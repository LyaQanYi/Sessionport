import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { LossCollector, normalizeToolCall } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrContent, IrEvent, IrPart, LossEntry, WriteReport } from '@sessionport/core';

import type {
  OpencodeExport,
  OpencodeExportFormat,
  OpencodeMessage,
  OpencodeMessageInfo,
  OpencodePart,
  OpencodeV2ContentBlock,
  OpencodeV2Message,
} from './wire.ts';
import { detectOpencodeCliVersion, opencodeCliBinary, opencodeImportArgs } from './wire.ts';

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
  /** 导出 JSON 格式：apply 时默认自动探测 CLI 版本（2.x 用 v2，1.x 用 v1）；apply=false 时默认 v1 */
  format?: OpencodeExportFormat;
  /** 只生成 JSON，不调用 opencode import */
  dryRun?: boolean;
  /** 是否调用 `opencode import` / `opencode session import` 落库（默认 true；dryRun 时忽略） */
  apply?: boolean;
  /** opencode CLI 路径 */
  binary?: string;
  /** 额外环境变量（隔离 OPENCODE_DB / XDG_DATA_HOME 等） */
  env?: Record<string, string>;
  /** opencode import 的运行 cwd / --directory */
  runCwd?: string;
  /** 是否把跨源工具调用改写为 opencode 原生工具（默认 true；--raw-tools 可关闭） */
  normalizeTools?: boolean;
}

export interface WriteOpencodeResult extends WriteReport {
  sessionId: string;
  /** 生成的导出 JSON 格式（v1 = 1.x，v2 = 2.x） */
  format: OpencodeExportFormat;
  /** 生成的导出 JSON */
  exportData: OpencodeExport;
  /** JSON 落盘路径（dryRun 时也写临时文件） */
  jsonPath?: string;
  imported: boolean;
  paths: string[];
  title: string;
  cwd: string;
}

interface BuildContext {
  cwd: string;
  sessionId: string;
  title: string;
  agent: string;
  modelId: string;
  providerID: string;
  explicitModel: boolean;
  createdAt: number;
  updatedAt: number;
  normalizeTools?: boolean;
}

interface BuildCounts {
  messages: number;
  toolCalls: number;
  toolResults: number;
  reasoning: number;
}

interface BuiltPayload {
  format: OpencodeExportFormat;
  exportData: OpencodeExport;
  losses: LossCollector;
  counts: BuildCounts;
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

function partsToText(parts: IrPart[], losses: LossCollector): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.length > 0) out.push(part.text);
    } else if (part.type === 'image') {
      out.push('[image: ' + part.ref + ']');
      losses.add('opencode.image-part-flattened', '图片块仅保留 [image: ref] 文本引用，无内联图片数据', { severity: 'warning' });
    }
  }
  return out.join('\n');
}

/** opencode 2.x 要求 tool.state.input 必须是 JSON 对象（字符串/数组会被 400 拒绝） */
function normalizeV2ToolInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (input === undefined || input === null) return {};
  return { value: input };
}

/** 给导出 JSON 补上 opencode 1.x 需要的公共字段（id/sessionID/messageID） */
function textPart(messageID: string, sessionID: string, text: string, atMs: number): OpencodePart {
  return { type: 'text', id: opencodeRandomId('prt'), sessionID, messageID, text, time: { start: atMs, end: atMs } };
}

/** opencode 1.x 会给工具状态一个 title（bash 用命令本身，其它用工具名） */
function toolTitle(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const command = record.command;
    if (typeof command === 'string' && command.length > 0) return command.slice(0, 120);
  }
  return name;
}

function addCommonSessionLosses(bundle: IrBundle, losses: LossCollector): void {
  const session = bundle.root;
  if (session.source.agent !== 'opencode') {
    losses.add('opencode.cross-agent-import', '会话来自 ' + session.source.agent + '，消息/工具语义按 opencode 导出格式近似还原', { severity: 'info' });
  }
  if (bundle.children.length > 0) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('opencode.subagent-dropped', 'opencode 的子代理会话暂未导出（需按父子顺序分别导入）', { count: bundle.children.length });
    losses.add('opencode.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents });
  }
}

function normalizeOpencodeTool(
  sourceAgent: string,
  event: Extract<IrEvent, { kind: 'tool_call' }>,
  ctx: BuildContext,
  losses: LossCollector,
): { name: string; input: unknown } {
  const normalized = normalizeToolCall({
    target: 'opencode',
    sourceAgent,
    name: event.name,
    input: event.input,
    enabled: ctx.normalizeTools,
  });
  if (normalized.status === 'normalized') {
    losses.add('opencode.tool-normalized', '工具调用已改写为目标端原生工具（--raw-tools 可关闭）', { severity: 'info' });
  } else if (normalized.status === 'unmapped') {
    losses.add('opencode.tool-unmapped', '工具调用无法映射到目标端原生工具，保留源端工具名', { severity: 'info' });
  }
  return { name: normalized.name, input: normalized.input };
}

function buildV1Payload(bundle: IrBundle, ctx: BuildContext): BuiltPayload {
  const session = bundle.root;
  const losses = new LossCollector();
  const counts: BuildCounts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };

  const messages: OpencodeMessage[] = [];
  let assistant: OpencodeMessage | undefined;
  const pendingTools = new Map<string, OpencodePart>();
  let lastAssistantId: string | null = null;
  let lastUserId: string | null = null;
  const messageBase = (atMs: number): Pick<OpencodeMessageInfo, 'agent' | 'model' | 'modelID' | 'providerID' | 'path' | 'time' | 'tokens' | 'cost'> => ({
    agent: ctx.agent,
    model: { providerID: ctx.providerID, modelID: ctx.modelId },
    modelID: ctx.modelId,
    providerID: ctx.providerID,
    path: { cwd: ctx.cwd, root: '/' },
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
        sessionID: ctx.sessionId,
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
    const atMs = Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : ctx.createdAt;
    if (event.kind === 'message') {
      if (event.role === 'user') {
        if (event.synthetic) {
          losses.add('opencode.injected-message-dropped', '目标端注入的消息（运行时上下文/技能目录等）已丢弃', { severity: 'info' });
          continue;
        }
        const text = partsToText(event.parts, losses);
        if (text.length === 0) continue;
        flushAssistant();
        const info: OpencodeMessageInfo = {
          ...messageBase(atMs),
          id: opencodeRandomId('msg'),
          sessionID: ctx.sessionId,
          role: 'user',
          mode: 'build',
          parentID: lastAssistantId,
          summary: { diffs: [] },
        };
        messages.push({ info, parts: [textPart(info.id!, ctx.sessionId, text, atMs)] });
        lastUserId = info.id!;
        counts.messages += 1;
        continue;
      }
      const text = partsToText(event.parts, losses);
      if (text.length === 0) continue;
      const target = ensureAssistant(atMs);
      target.parts!.push(textPart(target.info!.id!, ctx.sessionId, text, atMs));
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
      const part: OpencodePart = {
        type: 'reasoning',
        id: opencodeRandomId('prt'),
        sessionID: ctx.sessionId,
        messageID: target.info!.id!,
        text: event.reasoning.text,
        time: { start: atMs, end: atMs },
      };
      target.parts!.push(part);
      continue;
    }
    if (event.kind === 'tool_call') {
      const target = ensureAssistant(atMs);
      const tool = normalizeOpencodeTool(session.source.agent, event, ctx, losses);
      const part: OpencodePart = {
        type: 'tool',
        id: opencodeRandomId('prt'),
        sessionID: ctx.sessionId,
        messageID: target.info!.id!,
        tool: tool.name,
        callID: event.callId,
        state: { status: 'running', input: tool.input ?? {}, metadata: {}, title: toolTitle(tool.name, tool.input), time: { start: atMs } },
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

  for (const _callId of pendingTools.keys()) {
    losses.add('opencode.tool-without-result', '工具调用没有结果，导出为 running 状态', { count: 1, severity: 'warning' });
  }
  addCommonSessionLosses(bundle, losses);

  const exportData: OpencodeExport = {
    info: {
      id: ctx.sessionId,
      slug: 'imported-' + ctx.sessionId.slice(4, 12),
      projectID: 'global',
      directory: ctx.cwd,
      path: ctx.cwd.replace(/^\//, ''),
      title: ctx.title,
      agent: ctx.agent,
      model: { id: ctx.modelId, providerID: ctx.providerID, variant: 'default' },
      version: '1.19.3',
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: ctx.createdAt, updated: ctx.updatedAt },
    },
    messages,
  };

  return { format: 'v1', exportData, losses, counts };
}

function buildV2Payload(bundle: IrBundle, ctx: BuildContext): BuiltPayload {
  const session = bundle.root;
  const losses = new LossCollector();
  const counts: BuildCounts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };

  const messages: OpencodeV2Message[] = [];
  let assistant: OpencodeV2Message | undefined;
  const pendingTools = new Map<string, OpencodeV2ContentBlock>();

  const flushAssistant = (): void => {
    if (assistant && (assistant.content ?? []).length > 0) messages.push(assistant);
    assistant = undefined;
  };
  const ensureAssistant = (atMs: number): OpencodeV2Message => {
    if (!assistant) {
      assistant = {
        id: opencodeRandomId('msg'),
        type: 'assistant',
        time: { created: atMs, completed: atMs },
        agent: ctx.agent,
        model: { id: ctx.modelId, providerID: ctx.providerID },
        content: [],
        finish: 'stop',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
    } else if (assistant.time && typeof assistant.time.completed === 'number' && atMs > assistant.time.completed) {
      assistant.time.completed = atMs;
    }
    return assistant;
  };

  for (const event of session.events) {
    const atMs = Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : ctx.createdAt;
    if (event.kind === 'message') {
      if (event.role === 'user') {
        if (event.synthetic) {
          losses.add('opencode.injected-message-dropped', '目标端注入的消息（运行时上下文/技能目录等）已丢弃', { severity: 'info' });
          continue;
        }
        const text = partsToText(event.parts, losses);
        if (text.length === 0) continue;
        flushAssistant();
        messages.push({
          id: opencodeRandomId('msg'),
          type: 'user',
          time: { created: atMs },
          text,
          files: [],
          agents: [],
        });
        counts.messages += 1;
        continue;
      }
      const text = partsToText(event.parts, losses);
      if (text.length === 0) continue;
      const target = ensureAssistant(atMs);
      target.content!.push({ type: 'text', text });
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
      const keepSignature = session.source.agent === 'opencode' && typeof event.reasoning.signature === 'string' && event.reasoning.signature.length > 0;
      const block: OpencodeV2ContentBlock = {
        type: 'reasoning',
        text: event.reasoning.text,
        ...(keepSignature ? { state: { signature: event.reasoning.signature } } : {}),
        time: { created: atMs, completed: atMs },
      };
      target.content!.push(block);
      continue;
    }
    if (event.kind === 'tool_call') {
      const target = ensureAssistant(atMs);
      const tool = normalizeOpencodeTool(session.source.agent, event, ctx, losses);
      const input = normalizeV2ToolInput(tool.input);
      // 2.x import 拒绝 running/pending 状态；默认占位为 aborted 错误态，收到对应 tool_result 时再覆写为 completed/error
      const block: OpencodeV2ContentBlock = {
        type: 'tool',
        id: event.callId || opencodeRandomId('prt'),
        name: tool.name,
        executed: false,
        state: {
          status: 'error',
          input,
          error: { type: 'aborted', message: 'Tool call had no recorded result at export time' },
        },
        time: { created: atMs, ran: atMs, completed: atMs },
      };
      target.content!.push(block);
      pendingTools.set(event.callId, block);
      counts.toolCalls += 1;
      continue;
    }
    if (event.kind === 'tool_result') {
      const block = pendingTools.get(event.callId);
      const text = contentText(event.content);
      if (block) {
        const startMs = block.time?.created ?? atMs;
        const input = block.state?.input ?? {};
        if (event.isError === true) {
          block.state = {
            status: 'error',
            input,
            error: { type: 'tool.execution', message: text || 'Tool execution failed' },
          };
        } else {
          block.state = {
            status: 'completed',
            input,
            content: [{ type: 'text', text }],
            metadata: {},
          };
        }
        block.time = { created: startMs, ran: startMs, completed: Math.max(startMs, atMs) };
        if (assistant?.time && typeof assistant.time.completed === 'number' && atMs > assistant.time.completed) {
          assistant.time.completed = atMs;
        }
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

  for (const _callId of pendingTools.keys()) {
    losses.add(
      'opencode.tool-without-result',
      '工具调用没有结果，opencode 2.x 不接受 running/pending 导入，已导出为 aborted 错误状态',
      { count: 1, severity: 'warning' },
    );
  }
  if (!ctx.explicitModel && session.meta.model !== undefined) {
    losses.add(
      'opencode.model-not-migrated',
      '模型绑定不迁移（源模型 ' + session.meta.model + '），opencode 将使用自身默认模型',
      { severity: 'info' },
    );
  }
  addCommonSessionLosses(bundle, losses);

  const exportData: OpencodeExport = {
    info: {
      id: ctx.sessionId,
      projectID: 'global',
      agent: ctx.agent,
      ...(ctx.explicitModel ? { model: { id: ctx.modelId, providerID: ctx.providerID, variant: 'default' } } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: ctx.createdAt, updated: ctx.updatedAt },
      title: ctx.title,
      permissions: [],
      location: { directory: ctx.cwd },
    },
    messages,
  };

  return { format: 'v2', exportData, losses, counts };
}

function buildPayload(bundle: IrBundle, format: OpencodeExportFormat, ctx: BuildContext): BuiltPayload {
  return format === 'v2' ? buildV2Payload(bundle, ctx) : buildV1Payload(bundle, ctx);
}

function isBinaryMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
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
  const explicitModel = options.model !== undefined || options.provider !== undefined;

  const createdAt = session.meta.createdAt && Number.isFinite(Date.parse(session.meta.createdAt)) ? Date.parse(session.meta.createdAt) : Date.now();
  const updatedAt = session.meta.updatedAt && Number.isFinite(Date.parse(session.meta.updatedAt)) ? Date.parse(session.meta.updatedAt) : createdAt;

  const ctx: BuildContext = {
    cwd,
    sessionId,
    title,
    agent,
    modelId,
    providerID,
    explicitModel,
    createdAt,
    updatedAt,
    normalizeTools: options.normalizeTools,
  };

  const binary = opencodeCliBinary(options.binary);
  let candidateFormats: OpencodeExportFormat[];
  if (options.format !== undefined) {
    candidateFormats = [options.format];
  } else if (options.apply === false) {
    // 离线纯构造（不触发外部 CLI）：保持 v1 默认以确保确定性与既有调用兼容；需要 v2 时显式传 format: 'v2'
    candidateFormats = ['v1'];
  } else {
    const version = await detectOpencodeCliVersion(binary, options.env);
    if (version?.major !== undefined) {
      candidateFormats = [version.major >= 2 ? 'v2' : 'v1'];
    } else {
      candidateFormats = options.dryRun === true ? ['v2'] : ['v2', 'v1'];
    }
  }

  let built = buildPayload(bundle, candidateFormats[0]!, ctx);
  let imported = false;
  let jsonPath: string | undefined;

  if (options.apply !== false) {
    const dir = await mkdtemp(join(tmpdir(), 'sessionport-opencode-'));
    jsonPath = join(dir, sessionId + '.json');
    await writeFile(jsonPath, JSON.stringify(built.exportData), 'utf8');
    if (options.dryRun !== true) {
      const targetDir = options.runCwd ?? cwd;
      const runImport = async (format: OpencodeExportFormat): Promise<void> => {
        const args = opencodeImportArgs(jsonPath!, format, targetDir);
        const execCwd = format === 'v2' && !existsSync(targetDir) ? process.cwd() : targetDir;
        await execFileAsync(binary, args, {
          cwd: execCwd, // 1.x 用进程 cwd、2.x 用 --directory 覆盖 session 的 directory
          env: { ...process.env, ...options.env },
          maxBuffer: 64 * 1024 * 1024,
        });
      };
      try {
        let lastError: unknown;
        for (let index = 0; index < candidateFormats.length; index += 1) {
          const format = candidateFormats[index]!;
          if (index > 0) {
            built = buildPayload(bundle, format, ctx);
            await writeFile(jsonPath, JSON.stringify(built.exportData), 'utf8');
          }
          try {
            await runImport(format);
            imported = true;
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (isBinaryMissingError(error)) break;
          }
        }
        if (!imported && lastError !== undefined) {
          built.losses.add('opencode.import-failed', 'opencode import 失败: ' + String(lastError), { severity: 'warning' });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  const lossList: LossEntry[] = built.losses.sorted();
  return {
    target: 'opencode',
    sessionId,
    format: built.format,
    exportData: built.exportData,
    jsonPath,
    imported,
    paths: jsonPath ? [jsonPath] : [],
    title,
    cwd,
    written: {
      events: session.events.length,
      messages: built.counts.messages,
      toolCalls: built.counts.toolCalls,
      toolResults: built.counts.toolResults,
      reasoning: built.counts.reasoning,
    },
    losses: lossList,
    caps: OPENCODE_CAPS,
  };
}

export function printWriteReport(report: WriteOpencodeResult): string {
  return [
    'target      opencode (' + report.format + ')',
    'session     ' + report.sessionId,
    'cwd         ' + report.cwd,
    'json        ' + (report.jsonPath ?? '(not written)'),
    'imported    ' + report.imported,
  ].join('\n');
}
