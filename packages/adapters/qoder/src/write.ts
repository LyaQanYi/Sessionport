import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { LossCollector } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrContent, IrPart, LossEntry, WriteReport } from '@sessionport/core';

import type {
  QoderAssistantLine,
  QoderContentBlock,
  QoderLine,
  QoderUserLine,
} from './wire.ts';
import {
  QODER_AGENT,
  QODER_CLI_VERSION,
  QODER_DEFAULT_MODEL,
  isQoderSessionId,
  newQoderSessionId,
  qoderHome,
  qoderProjectDir,
  qoderSessionPath,
} from './wire.ts';

export const QODER_CAPS: ExportCaps = {
  agent: QODER_AGENT,
  reasoning: 'plain',
  toolResults: 'separate',
  branching: false,
  subagents: false,
  modelPinned: true,
};

export interface WriteQoderOptions {
  /** Qoder 数据根目录，默认 $QODERCN_CONFIG_DIR 或 ~/.qoder-cn */
  home?: string;
  /** 不落盘，只生成行序列与目标路径 */
  dryRun?: boolean;
  /** 目标会话 id（UUID；默认随机生成） */
  sessionId?: string;
  /** CLI 兼容别名（--id） */
  id?: string;
  /** 目标项目目录（默认 IR 的 meta.cwd） */
  cwd?: string;
  /** 目标模型（默认 qfmodel；Qoder 只认自己的模型 id） */
  model?: string;
  /** 目标标题（写入 custom-title） */
  title?: string;
  /** 允许覆盖同 id 文件（默认 false：Qoder 只新增文件；覆盖前会备份） */
  overwrite?: boolean;
}

export interface WriteQoderResult extends WriteReport {
  sessionId: string;
  /** 目标 transcript 路径（dryRun 也给） */
  path: string;
  /** 生成的行序列（未序列化） */
  rows: QoderLine[];
  /** 实际落盘 */
  applied: boolean;
  dryRun: boolean;
  title: string;
  cwd: string;
  /** 覆盖时旧文件的备份路径 */
  backupPath?: string;
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

function partsText(parts: IrPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : '[image: ' + part.ref + ']'))
    .join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 把 IR 写成 Qoder 的 transcript 行序列。
 *
 * 形状对齐真实 qodercli 1.1.69：
 * - 每个 assistant content block 一行，同一轮共用一个 message.id
 * - tool_result 的 parentUuid 指向包含 tool_use 的那一行（并行工具调用不乱序）
 * - 每个 assistant 分组 / 每个 tool_result 后写 active-leaf
 * - 文件尾部写 last-prompt + 最终 active-leaf
 */
export async function writeQoderSession(bundle: IrBundle, options: WriteQoderOptions = {}): Promise<WriteQoderResult> {
  const session = bundle.root;
  const rawCwd = options.cwd ?? session.meta.cwd ?? process.cwd();
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd);
  const sessionId = options.sessionId ?? options.id ?? newQoderSessionId();
  if (!isQoderSessionId(sessionId)) throw new Error('Qoder sessionId 必须是 UUID: ' + sessionId);
  const model = options.model ?? QODER_DEFAULT_MODEL;
  const title = options.title ?? session.meta.title ?? 'Sessionport import';
  const home = qoderHome(options.home);
  const path = qoderSessionPath(home, cwd, sessionId);
  const losses = new LossCollector();
  const counts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };

  if (session.events.length === 0) throw new Error('IR 会话没有事件，Qoder 会把它当空会话（不会出现在列表里）');
  if (options.dryRun !== true && existsSync(path) && options.overwrite !== true) {
    throw new Error('Qoder 目标文件已存在，拒绝覆盖（Qoder 只新增文件）: ' + path);
  }

  const rows: QoderLine[] = [];
  let tip: string | null = null;
  let assistantMessageId: string | null = null;
  let assistantAnchor: { request: string; response: string; requestId: string } | null = null;
  let promptId = randomUUID();
  let lastPrompt = '';
  const toolUseUuid = new Map<string, string>();
  let pendingCalls = 0;
  let groupOpen = false;

  let controlMs = Date.now();
  let lastEventMs = 0;
  const nextEventIso = (at: string): string => {
    const parsed = Date.parse(at);
    const base = Number.isFinite(parsed) ? parsed : Date.now();
    lastEventMs = Math.max(base, lastEventMs + 1);
    return new Date(lastEventMs).toISOString();
  };
  const controlIso = (): string => {
    controlMs = Math.max(Date.now(), controlMs + 1);
    return new Date(controlMs).toISOString();
  };
  const controlTimestamp = (): number => {
    controlMs = Math.max(Date.now(), controlMs + 1);
    return controlMs;
  };

  rows.push({ type: 'workspace-directories', sessionId, directories: [cwd] });
  rows.push({ type: 'runtime-config', sessionId, model, reasoningEffort: null, contextWindow: null, generation: null, timestamp: controlTimestamp() });
  rows.push({ type: 'worktree-state', sessionId, worktreeSession: null });
  if (title.length > 0) {
    rows.push({ type: 'custom-title', sessionId, customTitle: title, timestamp: controlIso() } as QoderLine);
  }

  const emitActiveLeaf = (): void => {
    if (tip === null) return;
    rows.push({ type: 'active-leaf', sessionId, leafUuid: tip, explicit: false, timestamp: controlTimestamp() });
  };

  const closeAssistant = (): void => {
    if (!groupOpen) return;
    emitActiveLeaf();
    assistantMessageId = null;
    assistantAnchor = null;
    groupOpen = false;
  };

  const emitAssistantBlock = (block: QoderContentBlock, at: string): string => {
    if (assistantMessageId === null) {
      assistantMessageId = 'chatcmpl-' + randomUUID();
      assistantAnchor = {
        request: sha256(assistantMessageId + ':request'),
        response: sha256(assistantMessageId + ':response'),
        requestId: randomUUID(),
      };
    }
    const uuid = randomUUID();
    const row: QoderAssistantLine = {
      type: 'assistant',
      uuid,
      parentUuid: tip,
      timestamp: at,
      message: {
        id: assistantMessageId,
        type: 'message',
        role: 'assistant',
        model,
        stop_reason: null,
        stop_sequence: null,
        content: [block],
      },
      requestTokenAnchor: { ...assistantAnchor! },
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: QODER_CLI_VERSION,
    };
    groupOpen = true;
    rows.push(row);
    tip = uuid;
    return uuid;
  };

  const emitUserText = (text: string, at: string): void => {
    closeAssistant();
    const uuid = randomUUID();
    promptId = uuid;
    lastPrompt = text;
    const row: QoderUserLine = {
      type: 'user',
      uuid,
      parentUuid: tip,
      timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text }] },
      humanInput: { text, mode: 'prompt' },
      origin: { kind: 'human' },
      promptId,
      requestSetId: uuid,
      businessModelKey: model,
      permissionMode: 'auto',
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: QODER_CLI_VERSION,
    };
    rows.push(row);
    tip = uuid;
    emitActiveLeaf();
  };

  const emitToolResult = (callId: string, text: string, isError: boolean, at: string): void => {
    closeAssistant();
    const callUuid = toolUseUuid.get(callId);
    const parent = callUuid ?? tip;
    const uuid = randomUUID();
    const row: QoderUserLine = {
      type: 'user',
      uuid,
      parentUuid: parent,
      timestamp: at,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content: text, ...(isError ? { is_error: true } : {}) }],
      },
      toolUseResult: { kind: isError ? 'error' : 'completed' },
      ...(callUuid !== undefined ? { sourceToolAssistantUUID: callUuid } : {}),
      promptId,
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: QODER_CLI_VERSION,
    };
    rows.push(row);
    tip = uuid;
    emitActiveLeaf();
  };

  for (const event of session.events) {
    const at = nextEventIso(event.at);
    if (event.kind === 'message') {
      if (event.parts.some((part) => part.type === 'image')) {
        losses.add('qoder.image-part-flattened', '图片 part 只保留 [image: ref] 文本，没有内联图片数据', { count: event.parts.filter((part) => part.type === 'image').length, severity: 'warning' });
      }
      if (event.role === 'user') {
        if (event.synthetic === true) {
          losses.add('qoder.synthetic-message-dropped', '目标端会自行注入上下文；源端的 synthetic user 消息已丢弃', { severity: 'info' });
          continue;
        }
        const text = partsText(event.parts).trim();
        if (text.length === 0) {
          losses.add('qoder.empty-user-message', '空的 user 消息已丢弃', { severity: 'info' });
          continue;
        }
        emitUserText(text, at);
        counts.messages += 1;
        continue;
      }
      if (event.synthetic === true) {
        losses.add('qoder.synthetic-assistant-dropped', '运行时状态消息（如 Interrupted by user）已丢弃', { severity: 'info' });
        continue;
      }
      const text = partsText(event.parts).trim();
      if (text.length === 0) {
        losses.add('qoder.empty-assistant-message', '空的 assistant 消息已丢弃', { severity: 'info' });
        continue;
      }
      emitAssistantBlock({ type: 'text', text }, at);
      counts.messages += 1;
      continue;
    }

    if (event.kind === 'reasoning') {
      counts.reasoning += 1;
      if (event.reasoning.kind !== 'plain') {
        losses.add('qoder.opaque-reasoning-dropped', '源端 reasoning 是密文/不可读，Qoder 只接受明文 thinking', { severity: 'warning' });
        continue;
      }
      if (event.reasoning.text.length === 0) continue;
      emitAssistantBlock(
        { type: 'thinking', thinking: event.reasoning.text, ...(event.reasoning.signature !== undefined ? { signature: event.reasoning.signature } : {}) },
        at,
      );
      continue;
    }

    if (event.kind === 'tool_call') {
      const uuid = emitAssistantBlock({ type: 'tool_use', id: event.callId, name: event.name, input: event.input ?? {} }, at);
      toolUseUuid.set(event.callId, uuid);
      pendingCalls += 1;
      counts.toolCalls += 1;
      continue;
    }

    if (event.kind === 'tool_result') {
      if (event.content.some((block) => block.type === 'image')) {
        losses.add('qoder.image-part-flattened', '图片 part 只保留 [image: ref] 文本，没有内联图片数据', { count: event.content.filter((block) => block.type === 'image').length, severity: 'warning' });
      }
      const text = contentText(event.content);
      if (pendingCalls > 0) pendingCalls -= 1;
      emitToolResult(event.callId, text, event.isError === true, at);
      counts.toolResults += 1;
      continue;
    }

    if (event.kind === 'boundary') {
      losses.add('qoder.boundary-dropped', '会话边界（' + event.boundary + '）没有对应的 Qoder 行，已丢弃', { severity: 'info' });
      continue;
    }
  }
  closeAssistant();

  if (lastPrompt.length === 0) {
    for (const event of session.events) {
      if (event.kind === 'message' && event.role === 'user' && event.synthetic !== true) {
        lastPrompt = partsText(event.parts).trim();
        break;
      }
    }
  }
  if (lastPrompt.length > 0) {
    rows.push({ type: 'last-prompt', sessionId, lastPrompt });
  }
  emitActiveLeaf();

  if (session.source.agent !== QODER_AGENT) {
    losses.add('qoder.cross-agent-import', '会话来自 ' + String(session.source.agent) + '，消息/工具语义按 Qoder transcript 近似还原', { severity: 'info' });
  }
  if (session.meta.model !== undefined && session.meta.model !== model) {
    losses.add('qoder.model-pinned', '源模型 ' + session.meta.model + ' 在 Qoder CN 不可用，已固定为 ' + model, { severity: 'info' });
  }
  if (bundle.children.length > 0) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('qoder.subagents-dropped', 'Qoder 子代理是独立 transcript，v0.1 不导出子代理会话', { count: bundle.children.length, severity: 'warning' });
    losses.add('qoder.subagent-events-dropped', '子代理事件未写入 Qoder', { count: childEvents, severity: 'warning' });
  }
  if (pendingCalls > 0) {
    losses.add('qoder.tool-without-result', '工具调用没有结果，Qoder 里会显示为未完成调用', { count: pendingCalls, severity: 'warning' });
  }
  if (rows.length === 0) losses.add('qoder.empty-session', '没有写入任何行', { severity: 'warning' });

  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  let applied = false;
  let backupPath: string | undefined;
  if (options.dryRun !== true) {
    mkdirSync(qoderProjectDir(home, cwd), { recursive: true });
    if (existsSync(path) && options.overwrite === true) {
      backupPath = path + '.bak-' + String(Date.now());
      renameSync(path, backupPath);
      losses.add('qoder.backup', '覆盖前已备份旧文件: ' + backupPath, { severity: 'info' });
    }
    const temp = join(qoderProjectDir(home, cwd), '.' + sessionId + '.tmp-' + String(process.pid));
    try {
      writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, path);
      applied = true;
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // 忽略清理失败
      }
      throw error;
    }
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: QODER_AGENT,
    sessionId,
    path,
    rows,
    applied,
    dryRun: options.dryRun === true,
    title,
    cwd,
    ...(backupPath !== undefined ? { backupPath } : {}),
    paths: applied ? [path] : [],
    losses: lossList,
    caps: QODER_CAPS,
    written: {
      events: session.events.length,
      messages: counts.messages,
      toolCalls: counts.toolCalls,
      toolResults: counts.toolResults,
      reasoning: counts.reasoning,
    },
  };
}

export function printWriteReport(report: WriteQoderResult): string {
  return [
    'target      qoder',
    'session     ' + report.sessionId,
    'cwd         ' + report.cwd,
    'path        ' + report.path,
    'dryRun      ' + String(report.dryRun),
    'applied     ' + String(report.applied),
    'rows        ' + report.rows.length,
    'title       ' + report.title,
  ].join('\n');
}
