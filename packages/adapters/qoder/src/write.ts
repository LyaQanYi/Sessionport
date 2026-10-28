import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { LossCollector } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrChildSession, IrContent, IrPart, IrSession, LossEntry, WriteReport } from '@sessionport/core';

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
  qoderSubagentMetaPath,
  qoderSubagentPath,
  qoderSubagentsDir,
} from './wire.ts';

export const QODER_CAPS: ExportCaps = {
  agent: QODER_AGENT,
  reasoning: 'plain',
  toolResults: 'separate',
  branching: false,
  subagents: true,
  modelPinned: true,
};

/** meta.json 里 agentType 的默认值（真实 Qoder 样本用 Explore；源端没有 profile 时用 Claude 风格的 general-purpose） */
export const QODER_DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/**
 * 真实 Qoder 子代理文件名形如 agent-aExplore-3e452d8269ce3c04.jsonl：
 * 字母数字开头，允许 '-'/'_'（Claude 只允许字母数字，Qoder 实测带连字符）。
 * 文件名里不放 '/'、空格等会破坏路径的字符；UUID 形式的源 id 可以直接沿用。
 */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const AGENT_ID_MAX_LENGTH = 64;

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
  /** 是否把 bundle.children 写成 Qoder 原生 subagents transcript（默认否） */
  includeChildren?: boolean;
}

/** 子代理 meta.json（字段对齐真实 Qoder 1.1.69 样本，另有可选的 toolUseId） */
export interface QoderSubagentMeta {
  agentType: string;
  toolUseId?: string;
  description: string;
  invocationName: string;
}

/** 已计划/写入的子代理文件 */
export interface WriteQoderChild {
  /** agent-<agentId>.jsonl 里的 agentId */
  agentId: string;
  label?: string;
  meta: QoderSubagentMeta;
  filePath: string;
  metaPath: string;
  /** 子代理源 IR 事件数（用于报告与往返核对） */
  events: number;
}

export interface WriteQoderResult extends WriteReport {
  sessionId: string;
  /** 目标 transcript 路径（dryRun 也给） */
  path: string;
  /** 生成的行序列（未序列化） */
  rows: QoderLine[];
  /** 原生子代理 transcript（includeChildren=true 时） */
  children: WriteQoderChild[];
  /** 实际落盘 */
  applied: boolean;
  dryRun: boolean;
  title: string;
  cwd: string;
  /** 覆盖时旧文件的备份路径 */
  backupPath?: string;
}

interface BuildCounts {
  messages: number;
  toolCalls: number;
  toolResults: number;
  reasoning: number;
  pendingCalls: number;
}

interface BuiltRows {
  rows: QoderLine[];
  counts: BuildCounts;
}

/**
 * 一份 transcript 的行生成上下文。
 *
 * 主会话（controlRows=true）写 workspace-directories/runtime-config/worktree-state/
 * custom-title，并在每轮后写 active-leaf、结尾写 last-prompt；子代理 transcript
 * （controlRows=false）真实样本里只有 user/assistant 行，没有这些控制行。
 */
interface RowContext {
  /** 写进每行的 sessionId；子代理写父会话 id（真实样本如此） */
  sessionId: string;
  cwd: string;
  model: string;
  /** custom-title（仅主会话） */
  title?: string;
  controlRows: boolean;
  agentId?: string;
  /** 触发子代理的 tool_use id（真实样本每行都有 parent_tool_use_id） */
  parentToolUseId?: string;
  isSidechain: boolean;
  /** 子代理的 promptId 固定为父会话 id（真实样本 25/25 行都是父 id） */
  fixedPromptId?: string;
  /** 子代理保留 synthetic user（目标端不会给子代理注入任务提示，丢了就没有任务描述） */
  keepSyntheticUser: boolean;
  /** 子代理 user 文本行不写 requestSetId/permissionMode（真实样本没有） */
  lightUserFields: boolean;
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

function nonEmptyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 与 Claude adapter 同一策略：优先沿用源端 nativeSessionId（Qoder -> Qoder 往返稳定），
 * 非法/冲突时用 child id 的 sha256 前缀生成稳定值，重复时加盐。
 */
function normalizeAgentId(child: IrChildSession, used: Set<string>): string {
  const native = nonEmptyText(child.session.source.nativeSessionId);
  if (native !== undefined && native.length <= AGENT_ID_MAX_LENGTH && AGENT_ID_RE.test(native) && !used.has(native)) {
    used.add(native);
    return native;
  }
  for (let salt = 0; ; salt += 1) {
    const seed = child.session.id + '\u0000' + (native ?? '') + '\u0000' + String(salt);
    const candidate = sha256(seed).slice(0, 17);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** 子代理 meta.json：只写真实样本里出现过的字段（不伪造 Claude 的 requestShape/spawnDepth） */
function buildSubagentMeta(child: IrChildSession, toolUseId: string | undefined): QoderSubagentMeta {
  const agentType = nonEmptyText(child.session.meta.profile) ?? QODER_DEFAULT_SUBAGENT_TYPE;
  const description =
    nonEmptyText(child.session.meta.title) ?? nonEmptyText(child.label) ?? agentType;
  return {
    agentType,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    description,
    invocationName: agentType,
  };
}

/**
 * 把一份 IrSession 写成 Qoder transcript 行序列。
 *
 * 形状对齐真实 qodercli 1.1.69：
 * - 每个 assistant content block 一行，同一轮共用一个 message.id
 * - tool_result 的 parentUuid 指向包含 tool_use 的那一行（并行工具调用不乱序）
 * - 主会话每个 assistant 分组 / 每个 tool_result 后写 active-leaf
 * - 主会话文件尾部写 last-prompt + 最终 active-leaf
 * - 子代理行带 isSidechain/agentId/parent_tool_use_id，sessionId 写父会话 id
 */
function buildRows(session: IrSession, ctx: RowContext, losses: LossCollector): BuiltRows {
  const rows: QoderLine[] = [];
  const counts: BuildCounts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0, pendingCalls: 0 };
  let tip: string | null = null;
  let assistantMessageId: string | null = null;
  let assistantAnchor: { request: string; response: string; requestId: string } | null = null;
  let promptId = ctx.fixedPromptId ?? randomUUID();
  let lastPrompt = '';
  const toolUseUuid = new Map<string, string>();
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
  const sidechainFields = (): { isSidechain: boolean; agentId?: string; parent_tool_use_id?: string } => ({
    isSidechain: ctx.isSidechain,
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
    ...(ctx.parentToolUseId !== undefined ? { parent_tool_use_id: ctx.parentToolUseId } : {}),
  });

  if (ctx.controlRows) {
    rows.push({ type: 'workspace-directories', sessionId: ctx.sessionId, directories: [ctx.cwd] });
    rows.push({ type: 'runtime-config', sessionId: ctx.sessionId, model: ctx.model, reasoningEffort: null, contextWindow: null, generation: null, timestamp: controlTimestamp() });
    rows.push({ type: 'worktree-state', sessionId: ctx.sessionId, worktreeSession: null });
    if (ctx.title !== undefined && ctx.title.length > 0) {
      rows.push({ type: 'custom-title', sessionId: ctx.sessionId, customTitle: ctx.title, timestamp: controlIso() } as QoderLine);
    }
  }

  const emitActiveLeaf = (): void => {
    if (!ctx.controlRows) return;
    if (tip === null) return;
    rows.push({ type: 'active-leaf', sessionId: ctx.sessionId, leafUuid: tip, explicit: false, timestamp: controlTimestamp() });
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
        model: ctx.model,
        stop_reason: null,
        stop_sequence: null,
        content: [block],
      },
      requestTokenAnchor: { ...assistantAnchor! },
      sessionId: ctx.sessionId,
      ...(ctx.agentId !== undefined ? { session_id: ctx.sessionId } : {}),
      cwd: ctx.cwd,
      ...sidechainFields(),
      userType: 'external',
      entrypoint: 'cli',
      version: QODER_CLI_VERSION,
    };
    groupOpen = true;
    rows.push(row);
    tip = uuid;
    return uuid;
  };

  const emitUserText = (text: string, at: string, synthetic: boolean): void => {
    closeAssistant();
    const uuid = randomUUID();
    if (!ctx.lightUserFields) promptId = uuid;
    lastPrompt = text;
    const row: QoderUserLine = {
      type: 'user',
      uuid,
      parentUuid: tip,
      timestamp: at,
      // 真实子代理 transcript 的首条 user 是字符串 content（不是 block 数组）
      message: { role: 'user', content: ctx.lightUserFields ? text : [{ type: 'text', text }] },
      humanInput: { text, mode: 'prompt' },
      origin: { kind: synthetic ? 'system' : 'human' },
      promptId,
      ...(ctx.lightUserFields ? {} : { requestSetId: uuid, permissionMode: 'auto' }),
      businessModelKey: ctx.model,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      ...(synthetic && ctx.keepSyntheticUser ? { isMeta: true } : {}),
      ...sidechainFields(),
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
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      ...sidechainFields(),
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
        if (event.synthetic === true && !ctx.keepSyntheticUser) {
          losses.add('qoder.synthetic-message-dropped', '目标端会自行注入上下文；源端的 synthetic user 消息已丢弃', { severity: 'info' });
          continue;
        }
        const text = partsText(event.parts).trim();
        if (text.length === 0) {
          losses.add('qoder.empty-user-message', '空的 user 消息已丢弃', { severity: 'info' });
          continue;
        }
        emitUserText(text, at, event.synthetic === true);
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
      counts.pendingCalls += 1;
      counts.toolCalls += 1;
      continue;
    }

    if (event.kind === 'tool_result') {
      if (event.content.some((block) => block.type === 'image')) {
        losses.add('qoder.image-part-flattened', '图片 part 只保留 [image: ref] 文本，没有内联图片数据', { count: event.content.filter((block) => block.type === 'image').length, severity: 'warning' });
      }
      const text = contentText(event.content);
      if (counts.pendingCalls > 0) counts.pendingCalls -= 1;
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

  if (ctx.controlRows) {
    if (lastPrompt.length === 0) {
      for (const event of session.events) {
        if (event.kind === 'message' && event.role === 'user' && event.synthetic !== true) {
          lastPrompt = partsText(event.parts).trim();
          break;
        }
      }
    }
    if (lastPrompt.length > 0) {
      rows.push({ type: 'last-prompt', sessionId: ctx.sessionId, lastPrompt });
    }
    emitActiveLeaf();
  }

  return { rows, counts };
}

/** 原子写：同目录临时文件 + rename，避免 Qoder 读到写了一半的 jsonl */
function writeAtomic(path: string, text: string, mode: number): void {
  const dir = dirname(path);
  const temp = join(dir, '.' + path.slice(dir.length + 1) + '.tmp-' + String(process.pid));
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 忽略清理失败
    }
    throw error;
  }
}

/** 从 agent-<agentId>.jsonl / agent-<agentId>.meta.json 还原 agentId */
function subagentIdFromFileName(name: string): string | undefined {
  if (!name.startsWith('agent-')) return undefined;
  if (name.endsWith('.jsonl')) {
    const id = name.slice('agent-'.length, -'.jsonl'.length);
    return id.length > 0 ? id : undefined;
  }
  if (name.endsWith('.meta.json')) {
    const id = name.slice('agent-'.length, -'.meta.json'.length);
    return id.length > 0 ? id : undefined;
  }
  return undefined;
}

interface ChildPlan {
  agentId: string;
  label?: string;
  meta: QoderSubagentMeta;
  rows: QoderLine[];
  filePath: string;
  metaPath: string;
  events: number;
}

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

  if (session.events.length === 0) throw new Error('IR 会话没有事件，Qoder 会把它当空会话（不会出现在列表里）');

  const rootBuilt = buildRows(
    session,
    { sessionId, cwd, model, title, controlRows: true, isSidechain: false, keepSyntheticUser: false, lightUserFields: false },
    losses,
  );
  const rows = rootBuilt.rows;

  if (session.source.agent !== QODER_AGENT) {
    losses.add('qoder.cross-agent-import', '会话来自 ' + String(session.source.agent) + '，消息/工具语义按 Qoder transcript 近似还原', { severity: 'info' });
  }
  if (session.meta.model !== undefined && session.meta.model !== model) {
    losses.add('qoder.model-pinned', '源模型 ' + session.meta.model + ' 在 Qoder CN 不可用，已固定为 ' + model, { severity: 'info' });
  }

  // 先规划全部子代理再落盘：转换/命名失败时不留半套文件
  const childPlans: ChildPlan[] = [];
  let unlinked = 0;
  let childPendingCalls = 0;
  if (options.includeChildren === true && bundle.children.length > 0) {
    const rootCallIds = new Set<string>();
    for (const event of session.events) if (event.kind === 'tool_call') rootCallIds.add(event.callId);
    const usedAgentIds = new Set<string>();
    for (const child of bundle.children) {
      const agentId = normalizeAgentId(child, usedAgentIds);
      const nativeVia = nonEmptyText(child.viaToolCallId);
      // 只有主会话里真有这个 tool_use 才写 toolUseId；悬空 id 不写进 meta（否则 Qoder 关联到不存在的调用）
      const linkedVia = nativeVia !== undefined && rootCallIds.has(nativeVia) ? nativeVia : undefined;
      const meta = buildSubagentMeta(child, linkedVia);
      const childCwd = nonEmptyText(child.session.meta.cwd) ?? cwd;
      const built = buildRows(
        child.session,
        {
          sessionId,
          cwd: childCwd,
          model,
          controlRows: false,
          isSidechain: true,
          agentId,
          ...(linkedVia !== undefined ? { parentToolUseId: linkedVia } : {}),
          fixedPromptId: sessionId,
          keepSyntheticUser: true,
          lightUserFields: true,
        },
        losses,
      );
      if (built.rows.length === 0) {
        losses.add('qoder.subagent-empty-skipped', '空的子代理会话没有可写入的事件，已跳过（否则会留下 Qoder 无法加载的空 transcript）', { count: 1, severity: 'info' });
        continue;
      }
      childPendingCalls += built.counts.pendingCalls;
      const childLabel = nonEmptyText(child.label);
      childPlans.push({
        agentId,
        ...(childLabel !== undefined ? { label: childLabel } : {}),
        meta,
        rows: built.rows,
        filePath: qoderSubagentPath(home, cwd, sessionId, agentId),
        metaPath: qoderSubagentMetaPath(home, cwd, sessionId, agentId),
        events: child.session.events.length,
      });
      if (linkedVia === undefined) unlinked += 1;
    }
    if (childPlans.length > 0) {
      losses.add(
        'qoder.subagent-native-writeback',
        '子代理已写成 Qoder 原生 subagents transcript（<sessionId>/subagents/agent-<agentId>.jsonl + .meta.json，meta 带 agentType/description，能关联时带 toolUseId）；Qoder SDK 的 listSubagents/getSubagentMessages 走同一路径。未写运行时登记文件 subagents/task-*.json（含 /var/folders 的 outputPath，SDK 读取子代理时不读它）；桌面端 UI 是否在父会话下展开子代理未人工验证；IR 只建模一层，子代理自己的子代理不会写回',
        { count: childPlans.length, severity: 'info' },
      );
    }
    if (unlinked > 0) {
      losses.add(
        'qoder.subagent-unlinked',
        '子代理 transcript 已写出，但源端没有可通过 meta.toolUseId 关联的父 Agent tool_use（缺 viaToolCallId 或主会话里找不到该调用）；Qoder SDK 读这些子代理时 parentToolUseId 为 null，父会话下的展示/关联未验证',
        { count: unlinked, severity: 'warning' },
      );
    }
  }

  if (bundle.children.length > 0 && options.includeChildren !== true) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('qoder.subagents-dropped', '子代理是独立 transcript；includeChildren 未开启，子代理未导出', { count: bundle.children.length, severity: 'warning' });
    losses.add('qoder.subagent-events-dropped', '子代理事件未写入 Qoder', { count: childEvents, severity: 'warning' });
  }
  const pendingCalls = rootBuilt.counts.pendingCalls + childPendingCalls;
  if (pendingCalls > 0) {
    losses.add('qoder.tool-without-result', '工具调用没有结果，Qoder 里会显示为未完成调用', { count: pendingCalls, severity: 'warning' });
  }
  if (rows.length === 0) losses.add('qoder.empty-session', '没有写入任何行', { severity: 'warning' });

  if (options.dryRun !== true && options.overwrite !== true) {
    if (existsSync(path)) throw new Error('Qoder 目标文件已存在，拒绝覆盖（Qoder 只新增文件）: ' + path);
    for (const plan of childPlans) {
      for (const target of [plan.filePath, plan.metaPath]) {
        if (existsSync(target)) throw new Error('Qoder 子代理文件已存在，拒绝覆盖（Qoder 只新增文件）: ' + target);
      }
    }
  }

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
    writeAtomic(path, text, 0o600);
    const subagentsDir = qoderSubagentsDir(home, cwd, sessionId);
    let backups = 0;
    // 覆盖同一个 sessionId 时，把不属于本次 bundle 的旧子代理文件移走（改名保留，
    // 不删除），否则 reader 会把上一次导入的 children 一起读回来。
    if (options.overwrite === true && existsSync(subagentsDir)) {
      const plannedIds = new Set(childPlans.map((plan) => plan.agentId));
      const stamp = String(Date.now());
      for (const name of readdirSync(subagentsDir)) {
        const staleId = subagentIdFromFileName(name);
        if (staleId === undefined || plannedIds.has(staleId)) continue;
        renameSync(join(subagentsDir, name), join(subagentsDir, name + '.bak-' + stamp));
        backups += 1;
      }
    }
    if (childPlans.length > 0) {
      mkdirSync(subagentsDir, { recursive: true });
      for (const plan of childPlans) {
        if (options.overwrite === true) {
          if (existsSync(plan.filePath)) {
            renameSync(plan.filePath, plan.filePath + '.bak-' + String(Date.now()));
            backups += 1;
          }
          if (existsSync(plan.metaPath)) {
            renameSync(plan.metaPath, plan.metaPath + '.bak-' + String(Date.now()));
            backups += 1;
          }
        }
        writeAtomic(plan.filePath, plan.rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 0o600);
        writeAtomic(plan.metaPath, JSON.stringify(plan.meta) + '\n', 0o644);
      }
    }
    if (backups > 0) losses.add('qoder.backup', '覆盖前已备份旧子代理文件', { count: backups, severity: 'info' });
    applied = true;
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: QODER_AGENT,
    sessionId,
    path,
    rows,
    children: childPlans.map((plan) => ({
      agentId: plan.agentId,
      ...(plan.label !== undefined ? { label: plan.label } : {}),
      meta: plan.meta,
      filePath: plan.filePath,
      metaPath: plan.metaPath,
      events: plan.events,
    })),
    applied,
    dryRun: options.dryRun === true,
    title,
    cwd,
    ...(backupPath !== undefined ? { backupPath } : {}),
    paths: applied ? [path, ...childPlans.map((plan) => plan.filePath)] : [],
    losses: lossList,
    caps: QODER_CAPS,
    written: {
      events: session.events.length,
      messages: rootBuilt.counts.messages,
      toolCalls: rootBuilt.counts.toolCalls,
      toolResults: rootBuilt.counts.toolResults,
      reasoning: rootBuilt.counts.reasoning,
    },
  };
}

export function printWriteReport(report: WriteQoderResult): string {
  const lines = [
    'target      qoder',
    'session     ' + report.sessionId,
    'cwd         ' + report.cwd,
    'path        ' + report.path,
    'dryRun      ' + String(report.dryRun),
    'applied     ' + String(report.applied),
    'rows        ' + report.rows.length,
    'title       ' + report.title,
  ];
  for (const child of report.children) {
    lines.push('subagent    ' + child.agentId + '  ' + child.meta.agentType + '  ' + child.meta.description + '  ' + child.filePath);
  }
  return lines.join('\n');
}
