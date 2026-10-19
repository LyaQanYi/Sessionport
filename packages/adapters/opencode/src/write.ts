import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { LossCollector } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrContent, IrEvent, IrSession, LossEntry, WriteReport } from '@sessionport/core';

import type { OpencodeExport, OpencodeMessage, OpencodeMessageInfo, OpencodePart } from './wire.ts';
import { opencodeCliBinary } from './wire.ts';

const execFileAsync = promisify(execFile);

export const OPENCODE_CAPS: ExportCaps = {
  agent: 'opencode',
  reasoning: 'plain',
  toolResults: 'inline',
  branching: true,
  subagents: true,
  modelPinned: false,
};

export interface WriteOpencodeOptions {
  /** 目标项目目录，默认取 IR 的 meta.cwd */
  cwd?: string;
  /** 目标会话 id（默认生成 ses_…） */
  id?: string;
  title?: string;
  model?: string;
  provider?: string;
  /** 只生成 JSON，不调用 opencode import */
  dryRun?: boolean;
  /** 是否调用 `opencode import` 落库（默认 true；dryRun 时忽略） */
  apply?: boolean;
  /** opencode CLI 路径 */
  binary?: string;
  /** 额外环境变量（隔离 OPENCODE_DB / XDG_DATA_HOME 等） */
  env?: Record<string, string>;
  /** opencode import 的运行 cwd */
  runCwd?: string;
}

export interface WriteOpencodeResult extends WriteReport {
  sessionId: string;
  /** 生成的导出 JSON */
  exportData: OpencodeExport;
  /** JSON 落盘路径（dryRun 时也写临时文件） */
  jsonPath?: string;
  imported: boolean;
  paths: string[];
  title: string;
  cwd: string;
}

function opencodeRandomId(prefix: 'ses' | 'msg' | 'prt'): string {
  return prefix + '_' + randomBytes(16).toString('hex').slice(0, 24);
}

function contentText(content: IrContent[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
        case 'diff':
        case 'terminal':
          return block.text;
        case 'image':
          return '[image: ' + block.ref + ']';
        case 'json':
          return JSON.stringify(block.value);
        default:
          return '';
      }
    })
    .join('\n');
}

/** 给导出 JSON 补上 opencode 需要的公共字段（id/sessionID/messageID） */
function textPart(messageID: string, sessionID: string, text: string, atMs: number): OpencodePart {
  return { type: 'text', id: opencodeRandomId('prt'), sessionID, messageID, text, time: { start: atMs, end: atMs } };
}

/** opencode 会给工具状态一个 title（bash 用命令本身，其它用工具名） */
function toolTitle(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const command = record.command;
    if (typeof command === 'string' && command.length > 0) return command.slice(0, 120);
  }
  return name;
}

export async function writeOpencodeSession(bundle: IrBundle, options: WriteOpencodeOptions = {}): Promise<WriteOpencodeResult> {
  const session = bundle.root;
  const rawCwd = options.cwd ?? session.meta.cwd ?? process.cwd();
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd);
  const sessionId = options.id ?? opencodeRandomId('ses');
  const title = options.title ?? session.meta.title ?? 'Sessionport import';
  const agent = 'build';
  const modelId = options.model ?? session.meta.model ?? 'claude-haiku-5-5';
  const providerID = options.provider ?? process.env.SESSIONPORT_OPENCODE_PROVIDER ?? 'opencode-go';
  const losses = new LossCollector();
  const counts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };

  const createdAt = session.meta.createdAt && Number.isFinite(Date.parse(session.meta.createdAt)) ? Date.parse(session.meta.createdAt) : Date.now();
  const updatedAt = session.meta.updatedAt && Number.isFinite(Date.parse(session.meta.updatedAt)) ? Date.parse(session.meta.updatedAt) : createdAt;

  const messages: OpencodeMessage[] = [];
  let assistant: OpencodeMessage | undefined;
  const pendingTools = new Map<string, OpencodePart>();
  let lastAssistantId: string | null = null;
  let lastUserId: string | null = null;
  const messageBase = (atMs: number): Pick<OpencodeMessageInfo, 'agent' | 'model' | 'modelID' | 'providerID' | 'path' | 'time' | 'tokens' | 'cost'> => ({
    agent,
    model: { providerID, modelID: modelId },
    modelID: modelId,
    providerID,
    path: { cwd, root: '/' },
    time: { created: atMs, completed: atMs },
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  });

  const flushAssistant = (): void => {
    if (assistant && (assistant.parts ?? []).length > 0) messages.push(assistant);
    assistant = undefined;
  };
  const ensureAssistant = (atMs: number): OpencodeMessage => {
    if (!assistant) {
      const info: OpencodeMessageInfo = {
        ...messageBase(atMs),
        id: opencodeRandomId('msg'),
        sessionID: sessionId,
        role: 'assistant',
        mode: 'build',
        parentID: lastUserId,
        finish: 'stop',
      };
      assistant = { info, parts: [] };
      lastAssistantId = info.id!;
    }
    return assistant;
  };

  for (const event of session.events) {
    const atMs = Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : createdAt;
    if (event.kind === 'message') {
      if (event.role === 'user') {
        if (event.synthetic) {
          losses.add('opencode.injected-message-dropped', '目标端注入的消息（运行时上下文/技能目录等）已丢弃', { severity: 'info' });
          continue;
        }
        const text = event.parts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
        if (text.length === 0) continue;
        flushAssistant();
        const info: OpencodeMessageInfo = {
          ...messageBase(atMs),
          id: opencodeRandomId('msg'),
          sessionID: sessionId,
          role: 'user',
          mode: 'build',
          parentID: lastAssistantId,
          summary: { diffs: [] },
        };
        messages.push({ info, parts: [textPart(info.id!, sessionId, text, atMs)] });
        lastUserId = info.id!;
        counts.messages += 1;
        continue;
      }
      const text = event.parts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
      if (text.length === 0) continue;
      const target = ensureAssistant(atMs);
      target.parts!.push(textPart(target.info!.id!, sessionId, text, atMs));
      counts.messages += 1;
      continue;
    }
    if (event.kind === 'reasoning') {
      counts.reasoning += 1;
      if (event.reasoning.kind !== 'plain') {
        losses.add('opencode.opaque-reasoning-dropped', '源端 reasoning 是密文，已丢弃', { severity: 'warning' });
        continue;
      }
      if (event.reasoning.text.length === 0) continue;
      const target = ensureAssistant(atMs);
      const part: OpencodePart = { type: 'reasoning', id: opencodeRandomId('prt'), sessionID: sessionId, messageID: target.info!.id!, text: event.reasoning.text, time: { start: atMs, end: atMs } };
      target.parts!.push(part);
      continue;
    }
    if (event.kind === 'tool_call') {
      const target = ensureAssistant(atMs);
      const part: OpencodePart = {
        type: 'tool',
        id: opencodeRandomId('prt'),
        sessionID: sessionId,
        messageID: target.info!.id!,
        tool: event.name,
        callID: event.callId,
        state: { status: 'running', input: event.input ?? {}, metadata: {}, title: toolTitle(event.name, event.input), time: { start: atMs } },
      };
      target.parts!.push(part);
      pendingTools.set(event.callId, part);
      counts.toolCalls += 1;
      continue;
    }
    if (event.kind === 'tool_result') {
      const part = pendingTools.get(event.callId);
      const text = contentText(event.content);
      if (part) {
        part.state = {
          ...(part.state ?? {}),
          status: event.isError === true ? 'error' : 'completed',
          output: text,
          metadata: {},
          ...(event.isError === true ? { error: text } : {}),
          time: { start: part.state?.time?.start ?? atMs, end: atMs },
        };
        pendingTools.delete(event.callId);
      } else {
        losses.add('opencode.orphan-tool-result', '孤立 tool_result（找不到对应调用），已丢弃', { severity: 'info' });
      }
      counts.toolResults += 1;
      continue;
    }
    if (event.kind === 'boundary') {
      losses.add('opencode.boundary-dropped', '会话边界事件（' + event.boundary + '）未映射进 opencode 导出格式', { severity: 'info' });
    }
  }
  flushAssistant();

  for (const callId of pendingTools.keys()) {
    losses.add('opencode.tool-without-result', '工具调用没有结果，导出为 running 状态', { count: 1, severity: 'warning' });
  }

  if (session.source.agent !== 'opencode') {
    losses.add('opencode.cross-agent-import', '会话来自 ' + session.source.agent + '，消息/工具语义按 opencode 导出格式近似还原', { severity: 'info' });
  }
  if (bundle.children.length > 0) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('opencode.subagent-dropped', 'opencode 的子代理是 session 上的 agent 列（不是独立会话），子代理会话未导出', { count: bundle.children.length });
    losses.add('opencode.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents });
  }

  const exportData: OpencodeExport = {
    info: {
      id: sessionId,
      slug: 'imported-' + sessionId.slice(4, 12),
      projectID: 'global',
      directory: cwd,
      path: cwd.replace(/^\//, ''),
      title,
      agent,
      model: { id: modelId, providerID, variant: 'default' },
      version: '1.19.3',
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: createdAt, updated: updatedAt },
    },
    messages,
  };

  let imported = false;
  let jsonPath: string | undefined;
  if (options.apply !== false) {
    const dir = await mkdtemp(join(tmpdir(), 'sessionport-opencode-'));
    jsonPath = join(dir, sessionId + '.json');
    await writeFile(jsonPath, JSON.stringify(exportData), 'utf8');
    if (options.dryRun !== true) {
      const binary = opencodeCliBinary(options.binary);
      try {
        await execFileAsync(binary, ['import', jsonPath, '--pure'], {
          cwd: options.runCwd ?? cwd, // import 会用进程的 project/cwd 覆盖 session.info 的 directory
          env: { ...process.env, ...options.env },
          maxBuffer: 64 * 1024 * 1024,
        });
        imported = true;
      } catch (error) {
        losses.add('opencode.import-failed', 'opencode import 失败: ' + String(error), { severity: 'warning' });
      }
      await rm(dir, { recursive: true, force: true });
    }
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: 'opencode',
    sessionId,
    exportData,
    jsonPath,
    imported,
    paths: jsonPath ? [jsonPath] : [],
    title,
    cwd,
    written: {
      events: session.events.length,
      messages: counts.messages,
      toolCalls: counts.toolCalls,
      toolResults: counts.toolResults,
      reasoning: counts.reasoning,
    },
    losses: lossList,
    caps: OPENCODE_CAPS,
  };
}

export function printWriteReport(report: WriteOpencodeResult): string {
  return [
    'target      opencode',
    'session     ' + report.sessionId,
    'cwd         ' + report.cwd,
    'json        ' + (report.jsonPath ?? '(not written)'),
    'imported    ' + report.imported,
  ].join('\n');
}