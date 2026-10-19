/**
 * sessionport IR -> DSH 原生会话目录。
 *
 * 产物（已用官方 app.asar 源码核对字段/校验规则）：
 *   <DSH_HOME>/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd
 *   <DSH_HOME>/sessions/<projectKey(cwd)>/<sessionId>/session.lock        （0 字节，与官方一致）
 *
 * 关键事实：
 * - 头行必须单独占第一帧，字段必需 type/version/id/createdAt/isSeeded/delegationDepth，
 *   可选 cwd/parentSession/origin/agentPreset；不能写 retired 的 sandboxMode/approvalPolicy。
 * - 会话正文是 surface 事件（user/message、assistant/message、tool/result、system/message）
 *   必须带 surfaceOp:"append"；seq 从 0 连续；assistant/message 必须带 turn/step/stream，
 *   stream 必须能组装回 message.content（镜像官方 BlockAssembler）。
 * - 普通根会话 id 形如 session-<uuid>；子代理会话是裸 uuid + header.parentSession，
 *   delegationDepth=1、origin="subagent"。
 * - 官方启动时 dsh-workspace 会从 sessionPersistence.list() 的 header 重建 workspace.json，
 *   所以 workspace 注册不是必须的（registerWorkspace 只是可选加速）。
 * - projcache 是投影缓存，缺省时应用会回放事件重建，所以不写（也不伪造 v7 记录）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { LossCollector, randomUuid } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrEvent, IrSession, LossEntry, WriteReport } from '@sessionport/core';

import { DSH_AGENT } from './read.ts';
import { dshHome, dshSessionDir, dshSessionFilePath, projectKey, sessionsRoot } from './paths.ts';
import { writeZstdJsonl } from './zstd.ts';

/** core 的 AgentId 还没有 'dsh'，先桥接；运行时值就是 'dsh' */
export type DshAgent = 'dsh';

export interface DshExportCaps extends ExportCaps {
  agent: DshAgent;
}

export const DSH_CAPS: DshExportCaps = {
  agent: 'dsh',
  reasoning: 'plain',
  toolResults: 'separate',
  branching: false,
  subagents: true,
  modelPinned: false,
};

export interface DshEventLine {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
}

export interface DshSessionHeaderLine {
  type: 'session';
  version: 4;
  id: string;
  createdAt: number;
  cwd: string;
  isSeeded: false;
  delegationDepth: number;
  agentPreset?: string;
  parentSession?: string;
  origin?: 'subagent';
}

export interface WriteDshOptions {
  /** 目标 DSH_HOME；默认 $DSH_HOME 或 ~/.dsh */
  home?: string;
  /** 目标 workspace 路径；默认 bundle.root.meta.cwd */
  cwd?: string;
  /** 目标 session id；默认 session-<uuid> */
  id?: string;
  /** 会话标题；默认 bundle.root.meta.title */
  title?: string;
  /** 只生成不落盘 */
  dryRun?: boolean;
  /** 是否把 bundle.children 写成 DSH 子代理会话（默认 false，记一条损失） */
  includeChildren?: boolean;
  /** 是否顺带更新 storages/workspace.json（默认 false；官方启动会自动重建） */
  registerWorkspace?: boolean;
}

export interface WriteDshResult extends WriteReport {
  target: 'dsh';
  sessionId: string;
  paths: string[];
  written: WriteReport['written'];
  losses: LossEntry[];
  caps: DshExportCaps;
  /** 写入的正文事件行（不含头行） */
  rows: DshEventLine[];
  header: DshSessionHeaderLine;
  filePath: string;
  sessionDir: string;
  cwd: string;
  title?: string;
  dryRun: boolean;
  /** 子代理会话（includeChildren=true 时） */
  children: Array<{ sessionId: string; filePath: string }>;
  /** 是否真的写了 projcache（恒 false：官方会自行重建） */
  projcacheWritten: false;
  /** 是否更新了 workspace.json */
  workspaceRegistered: boolean;
}

interface PendingStep {
  users: Array<Extract<IrEvent, { kind: 'message' }>>;
  reasoning: string[];
  assistant?: Extract<IrEvent, { kind: 'message' }>;
  toolCalls: Array<Extract<IrEvent, { kind: 'tool_call' }>>;
  results: Array<Extract<IrEvent, { kind: 'tool_result' }>>;
  at: string;
}

function msOf(iso: string | undefined, fallback: number): number {
  if (iso === undefined) return fallback;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeEvent(event: IrEvent): Record<string, unknown> | undefined {
  const native = event._native;
  return isRecord(native) ? native : undefined;
}

function nativeMessageId(event: IrEvent, kind: 'user' | 'assistant' | 'tool'): string {
  const native = nativeEvent(event);
  if (native === undefined) return randomUuid();
  if (kind === 'user') {
    if (typeof native.data === 'object' && native.data !== null && typeof (native.data as Record<string, unknown>).id === 'string') {
      return String((native.data as Record<string, unknown>).id);
    }
    return randomUuid();
  }
  const data = isRecord(native.data) ? native.data : {};
  const message = isRecord(data.message) ? data.message : {};
  return typeof message.id === 'string' ? message.id : randomUuid();
}

function nativeAssistantSource(event: IrEvent): { provider: string; model: string } | undefined {
  const native = nativeEvent(event);
  if (native === undefined) return undefined;
  const data = isRecord(native.data) ? native.data : {};
  const message = isRecord(data.message) ? data.message : {};
  const source = isRecord(message.source) ? message.source : {};
  if (typeof source.provider === 'string' && typeof source.model === 'string') {
    return { provider: source.provider, model: source.model };
  }
  return undefined;
}

function toolCallArgumentsString(call: Extract<IrEvent, { kind: 'tool_call' }>): string {
  const native = nativeEvent(call);
  if (native !== undefined) {
    const data = isRecord(native.data) ? native.data : {};
    if (typeof data.arguments === 'string') return data.arguments;
  }
  const input = call.input;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}

function textOfParts(event: Extract<IrEvent, { kind: 'message' }>): string | undefined {
  const texts = event.parts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text);
  if (texts.length === 0) return undefined;
  return texts.join('');
}

/** 把 IR 事件流切分成 DSH 的 step 序列（一个 step 至多一条 assistant/message）。 */
function groupSteps(session: IrSession, losses: LossCollector): { steps: PendingStep[]; counts: WriteDshResult['written'] } {
  const counts: WriteDshResult['written'] = { events: session.events.length, messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };
  const steps: PendingStep[] = [];
  let current: PendingStep | null = null;
  const begin = (at: string): PendingStep => ({ users: [], reasoning: [], toolCalls: [], results: [], at });
  const flush = (): void => {
    if (current !== null && (current.users.length > 0 || current.assistant !== undefined || current.toolCalls.length > 0 || current.results.length > 0 || current.reasoning.length > 0)) {
      steps.push(current);
    }
    current = null;
  };

  for (const event of session.events) {
    switch (event.kind) {
      case 'message': {
        if (event.role === 'user') {
          if (current !== null && current.assistant !== undefined) flush();
          current ??= begin(event.at);
          current.users.push(event);
          counts.messages += 1;
        } else {
          if (current !== null && current.assistant !== undefined) flush();
          current ??= begin(event.at);
          current.assistant = event;
          counts.messages += 1;
        }
        break;
      }
      case 'reasoning': {
        if (event.reasoning.kind !== 'plain') {
          losses.add('dsh.reasoning-opaque-dropped', 'opaque/加密 reasoning 无法转成 DSH reasoning 块，已丢弃', { count: 1, severity: 'warning' });
          break;
        }
        if (current !== null && current.assistant !== undefined) flush();
        current ??= begin(event.at);
        current.reasoning.push(event.reasoning.text);
        counts.reasoning += 1;
        break;
      }
      case 'tool_call': {
        current ??= begin(event.at);
        if (current.assistant !== undefined && current.results.length > 0) flush();
        current ??= begin(event.at);
        current.toolCalls.push(event);
        counts.toolCalls += 1;
        break;
      }
      case 'tool_result': {
        current ??= begin(event.at);
        current.results.push(event);
        counts.toolResults += 1;
        break;
      }
      case 'boundary': {
        losses.add('dsh.boundary-dropped', 'DSH 会话格式没有 fork/undo/compact/cancel 的通用结构，边界事件（' + event.boundary + '）已丢弃', {
          count: 1,
          severity: event.boundary === 'compact' ? 'info' : 'warning',
        });
        break;
      }
    }
  }
  flush();
  return { steps, counts };
}

interface EmitContext {
  session: IrSession;
  losses: LossCollector;
  rows: DshEventLine[];
  turn: number;
  lastTime: number;
  firstUserSeq?: number;
  synthProvider: string;
  synthModel: string;
}

function emit(ctx: EmitContext, type: string, time: number, data: Record<string, unknown>, opts: { surfaceOp?: unknown } = {}): DshEventLine {
  const at = Math.max(time, ctx.lastTime);
  ctx.lastTime = at;
  const row: DshEventLine = { type, seq: ctx.rows.length, time: at, data };
  if (opts.surfaceOp !== undefined) row.surfaceOp = opts.surfaceOp;
  ctx.rows.push(row);
  return row;
}

function imagePartLoss(losses: LossCollector, count: number): void {
  if (count === 0) return;
  losses.add('dsh.image-part-dropped', 'DSH 会话里的报文图片需要 attachment 机制，跨 agent 无法伪造，图片已丢弃', { count, severity: 'warning' });
}

function contentBlocksForResult(content: Extract<IrEvent, { kind: 'tool_result' }>['content'], losses: LossCollector): unknown[] {
  const blocks: unknown[] = [];
  for (const item of content) {
    switch (item.type) {
      case 'text':
        blocks.push({ type: 'text', text: item.text });
        break;
      case 'json':
        blocks.push({ type: 'text', text: JSON.stringify(item.value) });
        losses.add('dsh.tool-result-json-as-text', 'JSON 工具结果已序列化为 text 块', { count: 1, severity: 'info' });
        break;
      case 'diff':
      case 'terminal':
        blocks.push({ type: 'text', text: item.text });
        break;
      case 'image':
        blocks.push({ type: 'text', text: '[image: ' + item.ref + ']' });
        losses.add('dsh.tool-result-image-dropped', '工具结果图片无法映射为 DSH attachment，已降级为文本占位', { count: 1, severity: 'warning' });
        break;
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

/** 生成能通过官方 BlockAssembler 校验的 assistant stream（block-start/block-end + finish）。 */
function buildAssistantStream(content: unknown[], turn: number, step: number, time: number, hasToolCalls: boolean): unknown[] {
  void turn;
  void step;
  const stream: unknown[] = [];
  content.forEach((block, index) => {
    const record = isRecord(block) ? block : {};
    const blockType = typeof record.type === 'string' ? record.type : 'text';
    stream.push({ type: 'chunk', time, chunk: { type: 'block-start', index, blockType } });
    stream.push({ type: 'chunk', time, chunk: { type: 'block-end', index, block } });
  });
  stream.push({ type: 'chunk', time, chunk: { type: 'finish', reason: { kind: hasToolCalls ? 'tool-calls' : 'stop' } } });
  return stream;
}

function toHeaderLine(sessionId: string, cwd: string, createdAt: number, delegationDepth: number, extra: { parentSession?: string; origin?: 'subagent'; agentPreset?: string } = {}): DshSessionHeaderLine {
  const header: DshSessionHeaderLine = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth,
  };
  if (extra.parentSession !== undefined) header.parentSession = extra.parentSession;
  if (extra.origin !== undefined) header.origin = extra.origin;
  if (extra.agentPreset !== undefined) header.agentPreset = extra.agentPreset;
  return header;
}

async function writeWorkspaceRegistration(home: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const path = join(home, 'storages', 'workspace.json');
  let state: unknown;
  try {
    state = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    state = undefined;
  }
  const now = new Date().toISOString();
  if (!isRecord(state) || !isRecord(state.tables) || !isRecord((state.tables as Record<string, unknown>).workspaces)) {
    const workspaceId = randomUuid();
    const next = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: workspaceId,
        workspaceIds: [workspaceId],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
      tables: {
        workspaces: {
          [workspaceId]: { path: cwd, title: projectKey(cwd).replace(/^-+|-+$/gu, '') || 'workspace', sessionIds: [sessionId], createdAt: now, updatedAt: now },
        },
      },
    };
    await mkdir(join(home, 'storages'), { recursive: true });
    const temp = path + '.' + randomUuid() + '.tmp';
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await rename(temp, path);
    return path;
  }
  const root = state as Record<string, unknown>;
  const tables = root.tables as Record<string, unknown>;
  const workspaces = tables.workspaces as Record<string, Record<string, unknown>>;
  const globals = isRecord(root.global) ? root.global : {};
  let target = Object.entries(workspaces).find(([, record]) => record.path === cwd);
  if (target === undefined) {
    const workspaceId = randomUuid();
    workspaces[workspaceId] = { path: cwd, title: projectKey(cwd).replace(/^-+|-+$/gu, '') || 'workspace', sessionIds: [sessionId], createdAt: now, updatedAt: now };
    target = [workspaceId, workspaces[workspaceId]!];
    const ids = Array.isArray(globals.workspaceIds) ? globals.workspaceIds.filter((id): id is string => typeof id === 'string') : [];
    if (!ids.includes(workspaceId)) ids.unshift(workspaceId);
    globals.workspaceIds = ids;
    if (typeof globals.defaultWorkspaceId !== 'string' || globals.defaultWorkspaceId.length === 0) globals.defaultWorkspaceId = workspaceId;
    root.global = globals;
  }
  const [workspaceId, record] = target;
  const ids = Array.isArray(record.sessionIds) ? record.sessionIds.filter((id): id is string => typeof id === 'string') : [];
  if (!ids.includes(sessionId)) ids.unshift(sessionId);
  record.sessionIds = ids;
  record.updatedAt = now;
  await mkdir(join(home, 'storages'), { recursive: true });
  const temp = path + '.' + randomUuid() + '.tmp';
  await writeFile(temp, JSON.stringify(root, null, 2) + '\n', 'utf8');
  await rename(temp, path);
  void workspaceId;
  return path;
}

const SYNTH_PREFIX = 'sessionport';

/** 写单个会话（root 或 child），返回行、头、路径与统计。 */
async function writeOneSession(session: IrSession, options: {
  home: string;
  cwd: string;
  id: string;
  title?: string;
  parentSession?: string;
  delegationDepth: number;
  origin?: 'subagent';
  agentPreset?: string;
  losses: LossCollector;
  dryRun: boolean;
}): Promise<{ filePath: string; sessionDir: string; header: DshSessionHeaderLine; rows: DshEventLine[]; counts: WriteDshResult['written'] }> {
  const cwd = options.cwd;
  const createdAtMs = msOf(session.meta.createdAt, Date.now());
  const header = toHeaderLine(options.id, cwd, createdAtMs, options.delegationDepth, {
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  });

  const { steps, counts } = groupSteps(session, options.losses);
  const firstEvent = session.events[0];
  const ctx: EmitContext = {
    session,
    losses: options.losses,
    rows: [],
    turn: 1,
    lastTime: msOf(firstEvent?.at, createdAtMs),
    synthProvider: SYNTH_PREFIX,
    synthModel: session.meta.model ?? 'unknown',
  };

  const startTime = ctx.lastTime;
  emit(ctx, 'turn/start', startTime, { turn: ctx.turn });

  const allCallIds = new Set<string>();
  for (const step of steps) for (const call of step.toolCalls) allCallIds.add(call.callId);
  const allResultIds = new Set<string>();
  for (const step of steps) for (const result of step.results) allResultIds.add(result.callId);

  let systemWritten = false;
  const title = options.title;
  let titleMessageSeq: number | undefined;
  let stepNumber = 0;

  for (const step of steps) {
    stepNumber += 1;
    const at = msOf(step.at, ctx.lastTime);
    emit(ctx, 'step/start', at, { turn: ctx.turn, step: stepNumber });

    if (!systemWritten) {
      systemWritten = true;
      emit(ctx, 'system/message', at, {
        turn: ctx.turn,
        step: stepNumber,
        message: {
          role: 'system',
          content: [],
          source: { kind: 'system-prompt' },
          id: randomUuid(),
        },
      }, { surfaceOp: 'append' });
      options.losses.add(
        'dsh.system-prompt-synthesized',
        '写了一个空 system/message 占住 surface node 0；DSH 会在下一次请求时注入自己的 system prompt',
        { severity: 'info' },
      );
    }

    for (const user of step.users) {
      const parts: unknown[] = [];
      let images = 0;
      for (const part of user.parts) {
        if (part.type === 'text') parts.push({ type: 'text', text: part.text });
        else images += 1;
      }
      imagePartLoss(options.losses, images);
      if (parts.length === 0) {
        options.losses.add('dsh.empty-user-message-dropped', '用户消息没有可导出的 text part，已跳过', { count: 1, severity: 'info' });
        continue;
      }
      const sourceKind = user.synthetic === true ? SYNTH_PREFIX + '-synthetic' : 'user';
      const row = emit(ctx, 'user/message', msOf(user.at, at), {
        content: parts,
        source: { kind: sourceKind },
        role: 'user',
        id: nativeMessageId(user, 'user'),
      }, { surfaceOp: 'append' });
      if (titleMessageSeq === undefined) titleMessageSeq = row.seq;
    }

    // assistant：reasoning 块（前置）+ text 块 + tool-call 块
    const content: unknown[] = [];
    for (const text of step.reasoning) {
      if (text.length === 0) continue;
      content.push({ type: 'reasoning', text });
    }
    if (step.assistant !== undefined) {
      let images = 0;
      for (const part of step.assistant.parts) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else images += 1;
      }
      imagePartLoss(options.losses, images);
    }
    for (const call of step.toolCalls) {
      content.push({
        type: 'tool-call',
        id: call.callId,
        name: call.name,
        arguments: toolCallArgumentsString(call),
      });
    }
    const hasToolCalls = step.toolCalls.length > 0;
    if (content.length === 0) {
      options.losses.add('dsh.empty-assistant-step-dropped', 'step 里没有可导出的 assistant 内容（纯空消息），已跳过 assistant/message', { count: 1, severity: 'info' });
    } else {
      const nativeSource = step.assistant === undefined ? undefined : nativeAssistantSource(step.assistant);
      const assistantTime = step.assistant === undefined ? at : msOf(step.assistant.at, at);
      const messageId = step.assistant === undefined ? randomUuid() : nativeMessageId(step.assistant, 'assistant');
      const stream = buildAssistantStream(content, ctx.turn, stepNumber, assistantTime, hasToolCalls);
      emit(ctx, 'assistant/message', assistantTime, {
        turn: ctx.turn,
        step: stepNumber,
        message: {
          role: 'assistant',
          content,
          source: {
            kind: 'model',
            provider: nativeSource?.provider ?? ctx.synthProvider,
            model: nativeSource?.model ?? ctx.synthModel,
          },
          id: messageId,
        },
        stream,
      }, { surfaceOp: 'append' });
    }

    const toolTime = msOf(step.toolCalls[0]?.at ?? step.results[0]?.at, at);
    for (const call of step.toolCalls) {
      emit(ctx, 'tool/call', msOf(call.at, toolTime), {
        turn: ctx.turn,
        step: stepNumber,
        callId: call.callId,
        name: call.name,
        arguments: toolCallArgumentsString(call),
      });
    }
    for (const result of step.results) {
      if (result.callId.length === 0) {
        options.losses.add('dsh.tool-result-without-call-id', 'tool/result 缺少 callId，已跳过', { count: 1, severity: 'warning' });
        continue;
      }
      if (!allCallIds.has(result.callId)) {
        options.losses.add('dsh.orphan-tool-result-dropped', '孤立 tool/result（找不到对应 tool_call）已丢弃', { count: 1, severity: 'warning' });
        continue;
      }
      emit(ctx, 'tool/result', msOf(result.at, toolTime), {
        turn: ctx.turn,
        step: stepNumber,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: result.callId },
          toolCallId: result.callId,
          content: contentBlocksForResult(result.content, options.losses),
          isError: result.isError === true,
          id: nativeMessageId(result, 'tool'),
        },
      }, { surfaceOp: 'append' });
    }
    // 补占位结果，保证每个 tool-call 都有 tool/result（目标端可加载性）
    for (const call of step.toolCalls) {
      if (allResultIds.has(call.callId)) continue;
      emit(ctx, 'tool/result', msOf(call.at, toolTime), {
        turn: ctx.turn,
        step: stepNumber,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: call.callId },
          toolCallId: call.callId,
          content: [{ type: 'text', text: '[sessionport] 源会话里没有这条工具调用的结果' }],
          isError: true,
          id: randomUuid(),
        },
      }, { surfaceOp: 'append' });
      options.losses.add('dsh.tool-result-synthesized', '源会话里 tool_call 没有对应结果，已补占位 tool/result', { count: 1, severity: 'warning' });
    }

    emit(ctx, 'step/end', at, { turn: ctx.turn, step: stepNumber });
  }

  if (title !== undefined && title.length > 0) {
    const messageSeqs = titleMessageSeq === undefined ? [] : [titleMessageSeq];
    emit(ctx, 'session/title', ctx.lastTime, {
      title,
      messageSeqs,
      source: { kind: 'fallback' },
    });
  }
  emit(ctx, 'turn/end', ctx.lastTime, { turn: ctx.turn, reason: { kind: 'completed' } });

  const lines = [JSON.stringify(header), ...ctx.rows.map((row) => JSON.stringify(row))];
  const filePath = dshSessionFilePath(sessionsRoot(options.home), cwd, options.id, 4, 'zstd');
  const sessionDir = dshSessionDir(sessionsRoot(options.home), cwd, options.id);
  if (!options.dryRun) {
    await writeZstdJsonl(filePath, lines, { headerLines: 1, batchSize: 1 });
    await writeFile(join(sessionDir, 'session.lock'), '');
  }
  return { filePath, sessionDir, header, rows: ctx.rows, counts };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DSH 的约定：根会话 id 是 `session-<uuid>`，子代理由裸 uuid 表示。
 * 源端（如 Kimi）的子会话 id 可能是 `session_<uuid>`，这里统一剥成裸 uuid；
 * 不是 uuid 形状的源 id 就新生成一个，避免目录名/头字段不符合 DSH 规则。
 */
function normalizeChildId(raw: string | undefined, rootId: string, used: Set<string>): string {
  let candidate = raw ?? '';
  if (candidate.startsWith('session-')) candidate = candidate.slice('session-'.length);
  if (candidate.startsWith('session_')) candidate = candidate.slice('session_'.length);
  if (!UUID_RE.test(candidate) || candidate === rootId || used.has(candidate)) candidate = randomUuid();
  used.add(candidate);
  return candidate;
}

/**
 * 把一个 IrBundle 写成 DSH v4 会话目录。默认只写根会话；子代理会话需 includeChildren。
 * 不写 projcache（应用会重建）；workspace.json 注册可选（应用启动也会重建）。
 */
export async function writeDshSession(bundle: IrBundle, options: WriteDshOptions = {}): Promise<WriteDshResult> {
  const session = bundle.root;
  const home = dshHome(options.home);
  const rawCwd = options.cwd ?? session.meta.cwd ?? process.cwd();
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd);
  const sessionId = options.id ?? 'session-' + randomUuid();
  const title = options.title ?? session.meta.title;
  const dryRun = options.dryRun === true;
  const losses = new LossCollector();

  if (session.source.agent !== DSH_AGENT) {
    losses.add('dsh.cross-agent-import', '会话来自 ' + String(session.source.agent) + '，按 DSH v4 事件流近似重建；源端专有结构按损失清单降级', { severity: 'info' });
  }
  if (session.meta.model !== undefined) {
    losses.add('dsh.model-selection-dropped', '源模型 "' + session.meta.model + '" 不迁移（设计取舍：跨 agent 导入后由目标端使用自身默认模型，可在会话里切换）', { severity: 'info' });
  }

  const rootWritten = await writeOneSession(session, {
    home,
    cwd,
    id: sessionId,
    title,
    delegationDepth: 0,
    // 不写 agentPreset：headless one-shot runner 只 compose 自己的 preset，
    // 写了 "standard" 会被拒绝加载（实测错误：agent preset "standard" ... does not compose）。
    // GUI 会话会自己写入 standard；跨端导入交给目标端默认 preset 更稳。
    losses,
    dryRun,
  });

  const paths: string[] = [rootWritten.filePath, join(rootWritten.sessionDir, 'session.lock')];
  const children: Array<{ sessionId: string; filePath: string }> = [];
  if (bundle.children.length > 0) {
    if (options.includeChildren === true) {
      const usedChildIds = new Set<string>();
      for (const child of bundle.children) {
        const childId = normalizeChildId(child.session.source.nativeSessionId, sessionId, usedChildIds);
        try {
          const writtenChild = await writeOneSession(child.session, {
            home,
            cwd,
            id: childId,
            title: child.label ?? child.session.meta.title,
            parentSession: sessionId,
            delegationDepth: 1,
            origin: 'subagent',
            losses,
            dryRun,
          });
          children.push({ sessionId: childId, filePath: writtenChild.filePath });
          paths.push(writtenChild.filePath, join(writtenChild.sessionDir, 'session.lock'));
        } catch (error) {
          losses.add('dsh.child-session-write-failed', '子代理会话写入失败: ' + String(error), { count: 1, severity: 'warning' });
        }
      }
    } else {
      const childEvents = bundle.children.reduce((n, child) => n + child.session.events.length, 0);
      losses.add('dsh.subagent-dropped', '子代理会话未导出（includeChildren=false）；DSH 把子代理存成独立会话文件', {
        count: bundle.children.length,
        severity: 'warning',
      });
      losses.add('dsh.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents, severity: 'warning' });
    }
  }

  let workspaceRegistered = false;
  if (options.registerWorkspace === true && !dryRun) {
    try {
      await writeWorkspaceRegistration(home, cwd, sessionId);
      workspaceRegistered = true;
      paths.push(join(home, 'storages', 'workspace.json'));
    } catch (error) {
      losses.add('dsh.workspace-register-failed', 'workspace.json 注册失败（不影响会话文件）: ' + String(error), { count: 1, severity: 'warning' });
    }
  }

  return {
    target: 'dsh',
    sessionId,
    paths,
    written: rootWritten.counts,
    losses: losses.sorted(),
    caps: DSH_CAPS,
    rows: rootWritten.rows,
    header: rootWritten.header,
    filePath: rootWritten.filePath,
    sessionDir: rootWritten.sessionDir,
    cwd,
    title,
    dryRun,
    children,
    projcacheWritten: false,
    workspaceRegistered,
  };
}

export function printWriteReport(report: WriteDshResult): string {
  const lines: string[] = [];
  lines.push('target      ' + report.target);
  lines.push('session     ' + report.sessionId);
  lines.push('file        ' + report.filePath);
  lines.push('cwd         ' + report.cwd);
  lines.push('events      ' + report.rows.length);
  lines.push(
    'written     events=' + report.written.events +
      ' messages=' + report.written.messages +
      ' tool_calls=' + report.written.toolCalls +
      ' tool_results=' + report.written.toolResults +
      ' reasoning=' + report.written.reasoning,
  );
  lines.push('projcache   not written (DSH rebuilds it)');
  lines.push('workspace   ' + (report.workspaceRegistered ? 'registered' : 'not registered (DSH bootstraps it)'));
  lines.push('losses      ' + (report.losses.length === 0 ? 'none' : ''));
  for (const loss of report.losses) {
    lines.push('  [' + loss.severity + '] ' + loss.code + ' x' + loss.count + ' — ' + loss.message);
  }
  return lines.join('\n');
}