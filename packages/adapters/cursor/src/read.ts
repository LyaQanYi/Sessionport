/**
 * 读：Cursor 会话（globalStorage/state.vscdb 的 composerHeaders + composerData + bubbleId）→ IR。
 *
 * 数据模型（实测 Cursor 3.25.9）：
 * - 一个 chat = composerHeaders 一行 + cursorDiskKV['composerData:<id>'] + N 个 bubbleId key
 * - fullConversationHeadersOnly 给出气泡顺序与渲染分组；气泡正文在 bubbleId key 里
 * - type=1 用户消息，type=2 助手消息；助手气泡里可能有 thinking / toolFormerData
 * - 子代理/子会话是独立 composer，父 id 在 composerData.subagentInfo.parentComposerId
 *
 * 读取容错：缺 header/缺 composerData/坏 JSON/空占位气泡都会记 notices，不中断整个会话。
 */
import { existsSync } from 'node:fs';

import { IR_VERSION, finalizeSessionList } from '@sessionport/core';
import type {
  AgentId,
  IrBundle,
  IrChildSession,
  IrContent,
  IrEvent,
  IrMessageEvent,
  IrNotice,
  IrPart,
  IrSession,
  ListSessionsOptions,
  SessionSummary,
} from '@sessionport/core';

import {
  expandHomePath,
  fsPathFromWorkspaceIdentifier,
  listCursorWorkspaces,
  resolveCursorPaths,
} from './paths.ts';
import type { CursorPaths } from './paths.ts';
import {
  BUBBLE_TYPE_AI,
  BUBBLE_TYPE_HUMAN,
  CURSOR_AGENT,
  bubbleText,
  bubbleThinkingText,
  closeCursorDb,
  detectCursorVersion,
  headerRecordFromRow,
  isRecord,
  isUuid,
  msToIso,
  openCursorDb,
  readAllBubbles,
  readBubbles,
  readComposerDataRaw,
  readHeaderRow,
  readHeaderRows,
  tryParseJson,
} from './wire.ts';
import type {
  CursorBubble,
  CursorComposerData,
  CursorConversationHeaderEntry,
  CursorHeaderRecord,
  CursorHeaderRow,
  CursorToolFormerData,
} from './wire.ts';
import { cursorToolName } from './toolformer.ts';

/** core 的 AgentId 目前还没有 'cursor'（集成时由 core 补），这里做一次集中断言 */
export const CURSOR_AGENT_ID = 'cursor' as unknown as AgentId;

export interface ReadCursorOptions {
  /** Cursor 用户数据根目录；默认 $SESSIONPORT_CURSOR_HOME 或平台默认 */
  home?: string;
  /** 直接指定 state.vscdb 路径（优先于 home 推导） */
  dbPath?: string;
  /** 覆盖标题 */
  title?: string;
  /** 是否把子代理 composer 读进 children（默认 true） */
  includeChildren?: boolean;
  /** 最多读多少个子代理（默认 32，防止超大 agent 树） */
  maxChildren?: number;
}

export interface CursorSessionSummary extends SessionSummary {
  /** @deprecated 用 sessionId（兼容桌面端旧兜底代码） */
  id: string;
  /** @deprecated 用 nativePath */
  path: string;
}

export interface CursorSessionTarget extends CursorPaths {
  composerId: string;
}

// ---------------------------------------------------------------------------
// 目标解析
// ---------------------------------------------------------------------------

function latestComposerId(dbPath: string, db: ReturnType<typeof openCursorDb>): string | undefined {
  const rows = readHeaderRows(db, {});
  const first = rows[0];
  if (first !== undefined) return first.composerId;
  const any = readHeaderRows(db, { includeSubagents: true });
  return any[0]?.composerId;
}

/**
 * input 支持：
 * - composerId（uuid / 唯一前缀）
 * - 'last'：当前库里 recency 最高的非子代理 composer
 * - state.vscdb 路径：取该库最新 composer
 * - "<state.vscdb 路径>#<composerId>"：指定库 + 指定会话
 */
export function resolveCursorSessionTarget(input: string, options: ReadCursorOptions = {}): CursorSessionTarget {
  const base = resolveCursorPaths(options);
  let raw = input.trim();
  if (raw.length === 0) throw new Error('Cursor 会话 id/路径不能为空');

  let dbPath = base.dbPath;
  let composerHint: string | undefined;
  const hashIndex = raw.indexOf('#');
  if (hashIndex > 0) {
    composerHint = raw.slice(hashIndex + 1);
    raw = raw.slice(0, hashIndex);
  }
  const looksLikePath = raw === 'last' || existsSync(raw) || raw.endsWith('.vscdb') || raw.includes('/');
  if (looksLikePath && raw !== 'last') {
    dbPath = expandHomePath(raw);
  }

  if (!existsSync(dbPath)) {
    throw new Error('找不到 Cursor 数据库: ' + dbPath + '（可用 home/dbPath 覆盖，或设置 ' + 'SESSIONPORT_CURSOR_HOME' + '）');
  }

  const db = openCursorDb(dbPath, { readOnly: true });
  try {
    if (composerHint !== undefined && composerHint.length > 0) {
      return { home: base.home, dbPath, composerId: matchComposerId(db, composerHint) };
    }
    if (raw === 'last') {
      const latest = latestComposerId(dbPath, db);
      if (latest === undefined) throw new Error('Cursor 数据库里没有任何 composer: ' + dbPath);
      return { home: base.home, dbPath, composerId: latest };
    }
    if (looksLikePath) {
      const latest = latestComposerId(dbPath, db);
      if (latest === undefined) throw new Error('Cursor 数据库里没有任何 composer: ' + dbPath);
      return { home: base.home, dbPath, composerId: latest };
    }
    return { home: base.home, dbPath, composerId: matchComposerId(db, raw) };
  } finally {
    closeCursorDb(db);
  }
}

function matchComposerId(db: ReturnType<typeof openCursorDb>, wanted: string): string {
  const exact = readHeaderRow(db, wanted);
  if (exact !== undefined) return exact.composerId;
  if (readComposerDataRaw(db, wanted) !== undefined) return wanted;
  const rows = readHeaderRows(db, { includeSubagents: true });
  const byPrefix = rows.find((row) => row.composerId.startsWith(wanted));
  if (byPrefix !== undefined) return byPrefix.composerId;
  throw new Error('找不到 Cursor 会话: ' + wanted);
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export async function listCursorSessions(options: ListSessionsOptions | string = {}): Promise<CursorSessionSummary[]> {
  const home = typeof options === 'string' ? expandHomePath(options) : undefined;
  const { home: resolvedHome, dbPath } = resolveCursorPaths({
    home: home ?? (typeof options === 'string' ? undefined : options.home),
  });
  const limit = typeof options === 'string' ? undefined : options.limit;
  if (!existsSync(dbPath)) return [];

  const db = openCursorDb(dbPath, { readOnly: true });
  try {
    const rows = readHeaderRows(db, { includeSubagents: false });
    const workspaces = new Map(listCursorWorkspaces(resolvedHome).map((info) => [info.workspaceId, info]));
    const summaries: CursorSessionSummary[] = [];
    for (const row of rows) {
      const header = headerRecordFromRow(row)?.header;
      const summary: CursorSessionSummary = {
        agent: CURSOR_AGENT_ID,
        sessionId: row.composerId,
        id: row.composerId,
        nativePath: dbPath,
        path: dbPath,
      };
      const title = typeof header?.name === 'string' && header.name.trim().length > 0 ? header.name.trim() : undefined;
      if (title !== undefined) summary.title = title;
      const cwd =
        fsPathFromWorkspaceIdentifier(header?.workspaceIdentifier) ??
        (row.workspaceId !== null ? workspaces.get(row.workspaceId)?.cwd : undefined);
      if (cwd !== undefined) summary.cwd = cwd;
      const createdAt = msToIso(row.createdAt ?? header?.createdAt);
      if (createdAt !== undefined) summary.createdAt = createdAt;
      const updatedAt = msToIso(row.lastUpdatedAt ?? row.recency ?? header?.lastUpdatedAt);
      if (updatedAt !== undefined) summary.updatedAt = updatedAt;
      if (row.isArchived === 1 || header?.isArchived === true) summary.archived = true;
      const subagentParent =
        typeof header?.subagentInfo?.parentComposerId === 'string' && header.subagentInfo.parentComposerId.length > 0
          ? header.subagentInfo.parentComposerId
          : undefined;
      if (subagentParent !== undefined) summary.parentSessionId = subagentParent;
      summaries.push(summary);
    }
    return finalizeSessionList(summaries, limit) as CursorSessionSummary[];
  } finally {
    closeCursorDb(db);
  }
}

// ---------------------------------------------------------------------------
// 单会话
// ---------------------------------------------------------------------------

interface LoadedComposer {
  session: IrSession;
  data: CursorComposerData;
  header?: CursorHeaderRecord;
  row?: CursorHeaderRow;
}

export async function readCursorSession(input: string, options: ReadCursorOptions = {}): Promise<IrBundle> {
  const target = resolveCursorSessionTarget(input, options);
  const db = openCursorDb(target.dbPath, { readOnly: true });
  try {
    const loaded = loadComposerSession(db, target.composerId, target.home, target.dbPath, options);
    const children: IrChildSession[] = [];
    if (options.includeChildren !== false) {
      const ids = collectChildComposerIds(loaded.data);
      const max = options.maxChildren ?? 32;
      const selected = ids.slice(0, max);
      if (ids.length > selected.length) {
        loaded.session.notices.push({
          code: 'cursor.child-truncated',
          message: '子代理会话数量超过上限，只读取前 ' + String(selected.length) + ' 个',
          count: ids.length - selected.length,
          severity: 'warning',
        });
      }
      let failed = 0;
      for (const childId of selected) {
        try {
          const child = loadComposerSession(db, childId, target.home, target.dbPath, {
            ...options,
            includeChildren: false,
          });
          const label =
            child.header?.row.subagentTypeName ??
            (typeof child.data.subagentInfo?.subagentTypeName === 'string'
              ? child.data.subagentInfo.subagentTypeName
              : undefined);
          const viaToolCallId =
            typeof child.data.subagentInfo?.toolCallId === 'string'
              ? child.data.subagentInfo.toolCallId
              : undefined;
          const childSession: IrChildSession = {
            session: child.session,
            parentSessionId: target.composerId,
          };
          if (viaToolCallId !== undefined) childSession.viaToolCallId = viaToolCallId;
          if (label !== undefined) childSession.label = label;
          children.push(childSession);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        loaded.session.notices.push({
          code: 'cursor.child-read-failed',
          message: '部分子代理 composer 读取失败（数据缺失），已跳过',
          count: failed,
          severity: 'warning',
        });
      }
    }
    return {
      irVersion: IR_VERSION,
      createdAt: new Date().toISOString(),
      root: loaded.session,
      children,
    };
  } finally {
    closeCursorDb(db);
  }
}

function collectChildComposerIds(data: CursorComposerData): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [data.subagentComposerIds, data.subComposerIds]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

interface Counters {
  emptyBubbles: number;
  missingBubbles: number;
  badBubbles: number;
  unknownBubbles: Map<string, number>;
  images: number;
  synthetic: number;
  toolCalls: number;
  toolResults: number;
  toolResultsMissing: number;
  interpreterResults: number;
  reasoning: number;
  displayOnly: number;
  noHeadersFallback: number;
  attachedContext: number;
}

function emptyCounters(): Counters {
  return {
    emptyBubbles: 0,
    missingBubbles: 0,
    badBubbles: 0,
    unknownBubbles: new Map(),
    images: 0,
    synthetic: 0,
    toolCalls: 0,
    toolResults: 0,
    toolResultsMissing: 0,
    interpreterResults: 0,
    reasoning: 0,
    displayOnly: 0,
    noHeadersFallback: 0,
    attachedContext: 0,
  };
}

function eventTime(bubble: CursorBubble, entry: CursorConversationHeaderEntry | undefined, fallback: string): string {
  const fromBubble = typeof bubble.createdAt === 'string' ? bubble.createdAt : undefined;
  if (fromBubble !== undefined && Number.isFinite(Date.parse(fromBubble))) return new Date(Date.parse(fromBubble)).toISOString();
  const fromEntry = entry?.createdAt;
  if (typeof fromEntry === 'string' && Number.isFinite(Date.parse(fromEntry))) {
    return new Date(Date.parse(fromEntry)).toISOString();
  }
  const startedAt = typeof bubble.startedAtMs === 'number' ? bubble.startedAtMs : undefined;
  if (startedAt !== undefined) {
    const iso = msToIso(startedAt);
    if (iso !== undefined) return iso;
  }
  return fallback;
}

function toolExtension(data: CursorToolFormerData): Record<string, unknown> | undefined {
  return isRecord(data._sessionport) ? data._sessionport : undefined;
}

function isIrContentArray(value: unknown): value is IrContent[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!isRecord(item) || typeof item.type !== 'string') return false;
    switch (item.type) {
      case 'text':
      case 'diff':
      case 'terminal':
        return typeof item.text === 'string';
      case 'json':
        return true;
      case 'image':
        return typeof item.ref === 'string';
      default:
        return false;
    }
  });
}

function toolCallInput(data: CursorToolFormerData): unknown {
  // 我们写出去的 bubble 带 _sessionport.input，可精确还原源 IR 的参数；
  // 原生 Cursor 气泡没有这个键，仍按 params/rawArgs 解码（保持既有行为）。
  const extension = toolExtension(data);
  if (extension !== undefined && 'input' in extension) return extension.input;
  const params = typeof data.params === 'string' ? data.params : undefined;
  if (params !== undefined && params.length > 0) {
    const parsed = tryParseJson(params);
    if (parsed !== undefined) return parsed;
    return params;
  }
  const raw = typeof data.rawArgs === 'string' ? data.rawArgs : undefined;
  if (raw !== undefined && raw.length > 0) {
    const parsed = tryParseJson(raw);
    return parsed !== undefined ? parsed : raw;
  }
  return null;
}

function toolResultContent(data: CursorToolFormerData): { content: IrContent[]; isError: boolean } | undefined {
  const status = typeof data.status === 'string' ? data.status : '';
  const extension = toolExtension(data);
  if (extension !== undefined && isIrContentArray(extension.content)) {
    return { content: extension.content, isError: extension.isError === true || status === 'error' };
  }
  const raw = data.result;
  if (raw === undefined || raw === null) {
    // 原生 Cursor 的 grep/list 在落库时会把 result 剪成 additionalData 摘要
    // （serializeToolformerBubbleData.js 的 fgo/fYv），这里把摘要保留成 json 结果。
    if (
      (data.tool === 41 ||
        data.tool === 39 ||
        data.name === 'ripgrep_raw_search' ||
        data.name === 'list_dir_v2') &&
      isRecord(data.additionalData) &&
      data.additionalData.isPruned === true
    ) {
      return { content: [{ type: 'json', value: data.additionalData }], isError: status === 'error' };
    }
    return undefined;
  }
  let content: IrContent[];
  if (typeof raw === 'string') {
    if (raw.length === 0) return undefined;
    const parsed = tryParseJson(raw);
    content = parsed !== undefined ? [{ type: 'json', value: parsed }] : [{ type: 'text', text: raw }];
  } else if (Array.isArray(raw) || isRecord(raw)) {
    content = [{ type: 'json', value: raw }];
  } else if (typeof raw === 'number' || typeof raw === 'boolean') {
    content = [{ type: 'json', value: raw }];
  } else {
    return undefined;
  }
  return { content, isError: status === 'error' };
}

function imageParts(bubble: CursorBubble): IrPart[] {
  if (!Array.isArray(bubble.images)) return [];
  const parts: IrPart[] = [];
  for (const image of bubble.images) {
    if (!isRecord(image)) continue;
    const uuid = typeof image.uuid === 'string' && image.uuid.length > 0 ? image.uuid : 'unknown';
    parts.push({ type: 'image', ref: 'cursor-image:' + uuid });
  }
  return parts;
}

function loadComposerSession(
  db: ReturnType<typeof openCursorDb>,
  composerId: string,
  home: string,
  dbPath: string,
  options: ReadCursorOptions,
): LoadedComposer {
  const row = readHeaderRow(db, composerId);
  const header = row === undefined ? undefined : headerRecordFromRow(row);
  if (row === undefined) {
    return loadWithoutHeader(db, composerId, home, dbPath, options);
  }
  const data = parseComposerData(db, composerId);
  const notices: IrNotice[] = [];
  const counters = emptyCounters();
  if (header === undefined) {
    notices.push({
      code: 'cursor.header-unparseable',
      message: 'composerHeaders 行的 value 不是合法 JSON（会话仍从 composerData 读取）',
      count: 1,
      severity: 'warning',
    });
  }

  const room = workspaceCwd(home, row);
  const entries = conversationHeaders(data, db, composerId, counters);
  const ids = entries.map((entry) => entry.bubbleId);
  const { bubbles, missing, bad } = readBubbles(db, composerId, ids);
  counters.missingBubbles += missing.length;
  counters.badBubbles += bad.length;

  const fallbackAt = msToIso(data.createdAt ?? row.createdAt) ?? new Date(0).toISOString();
  const events: IrEvent[] = [];
  const push = (event: Omit<IrEvent, 'id' | 'parentId'>): void => {
    const id = 'cursor:e' + String(events.length + 1).padStart(6, '0');
    const parentId = events.length === 0 ? null : (events[events.length - 1] as IrEvent).id;
    events.push({ ...(event as IrEvent), id, parentId });
  };

  for (const entry of entries) {
    const bubble = bubbles.get(entry.bubbleId);
    if (bubble === undefined) continue;
    const at = eventTime(bubble, entry, fallbackAt);
    const declaredType = typeof bubble.type === 'number' ? bubble.type : entry.type;

    if (bubble.isDisplayOnly === true) {
      counters.displayOnly += 1;
      continue;
    }

    if (declaredType === BUBBLE_TYPE_HUMAN) {
      const text = bubbleText(bubble);
      const parts: IrPart[] = [];
      if (text.trim().length > 0) parts.push({ type: 'text', text });
      const images = imageParts(bubble);
      if (images.length > 0) {
        parts.push(...images);
        counters.images += images.length;
      }
      if (parts.length === 0) {
        counters.emptyBubbles += 1;
        continue;
      }
      const event: IrMessageEvent = { kind: 'message', at, role: 'user', parts };
      if (bubble.isSimulatedMsg === true) {
        event.synthetic = true;
        counters.synthetic += 1;
      }
      push(event);
      counters.attachedContext += attachedContextCount(bubble);
      continue;
    }

    if (declaredType === BUBBLE_TYPE_AI) {
      const thinking = bubbleThinkingText(bubble);
      if (thinking.trim().length > 0) {
        counters.reasoning += 1;
        push({ kind: 'reasoning', at, reasoning: { kind: 'plain', text: thinking } });
      }
      const text = bubbleText(bubble);
      if (text.trim().length > 0) {
        push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text }] });
      }
      const tool = isRecord(bubble.toolFormerData) ? (bubble.toolFormerData as CursorToolFormerData) : undefined;
      if (tool !== undefined) {
        const callId =
          typeof tool.toolCallId === 'string' && tool.toolCallId.length > 0
            ? tool.toolCallId
            : 'cursor-tool-' + entry.bubbleId;
        const extension = toolExtension(tool);
        const extensionName =
          extension !== undefined && typeof extension.name === 'string' && extension.name.length > 0
            ? extension.name
            : undefined;
        const name =
          extensionName ??
          (typeof tool.name === 'string' && tool.name.length > 0
            ? tool.name
            : cursorToolName(typeof tool.tool === 'number' ? tool.tool : -1) ??
              'cursor_tool_' + String(typeof tool.tool === 'number' ? tool.tool : 'unknown'));
        counters.toolCalls += 1;
        push({ kind: 'tool_call', at, callId, name, input: toolCallInput(tool) });
        const result = toolResultContent(tool);
        if (result === undefined) {
          counters.toolResultsMissing += 1;
        } else {
          counters.toolResults += 1;
          push({ kind: 'tool_result', at, callId, content: result.content, isError: result.isError });
        }
      }
      let interpreterCount = 0;
      if (Array.isArray(bubble.interpreterResults) && bubble.interpreterResults.length > 0) {
        for (let index = 0; index < bubble.interpreterResults.length; index += 1) {
          interpreterCount += 1;
          counters.interpreterResults += 1;
          push({
            kind: 'tool_result',
            at,
            callId: 'cursor-interp-' + entry.bubbleId + '-' + String(index),
            content: [{ type: 'json', value: bubble.interpreterResults[index] }],
          });
        }
      }
      if (thinking.trim().length === 0 && text.trim().length === 0 && tool === undefined && interpreterCount === 0) {
        counters.emptyBubbles += 1;
      }
      continue;
    }

    const key = 'type:' + String(declaredType);
    counters.unknownBubbles.set(key, (counters.unknownBubbles.get(key) ?? 0) + 1);
  }

  appendNotices(notices, counters, header);
  const meta = buildMeta(data, row, header, room, options, events);
  const session: IrSession = {
    id: 'cursor:' + composerId,
    source: {
      agent: CURSOR_AGENT_ID,
      cliVersion: detectCursorVersion(home),
      formatVersion: typeof data._v === 'number' ? String(data._v) : undefined,
      nativeSessionId: composerId,
      nativePath: dbPath,
    },
    meta,
    events,
    head: events.length > 0 ? (events[events.length - 1] as IrEvent).id : null,
    notices,
  };
  return { session, data, header, row };
}

function parseComposerData(db: ReturnType<typeof openCursorDb>, composerId: string): CursorComposerData {
  const raw = readComposerDataRaw(db, composerId);
  if (raw === undefined) {
    throw new Error('Cursor 会话缺少 composerData 行: composerData:' + composerId);
  }
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) {
    throw new Error('Cursor composerData 不是合法 JSON: composerData:' + composerId);
  }
  return parsed as CursorComposerData;
}

/** header 数组缺失时，用全部气泡按 createdAt 兜底排序 */
function conversationHeaders(
  data: CursorComposerData,
  db: ReturnType<typeof openCursorDb>,
  composerId: string,
  counters: Counters,
): CursorConversationHeaderEntry[] {
  const raw = data.fullConversationHeadersOnly;
  if (Array.isArray(raw) && raw.length > 0) {
    const out: CursorConversationHeaderEntry[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const bubbleId = typeof item.bubbleId === 'string' ? item.bubbleId : undefined;
      const type = typeof item.type === 'number' ? item.type : undefined;
      if (bubbleId === undefined || type === undefined) continue;
      out.push({ ...(item as CursorConversationHeaderEntry), bubbleId, type });
    }
    return out;
  }
  counters.noHeadersFallback += 1;
  const all = readAllBubbles(db, composerId);
  const sorted = [...all.bubbles.entries()].sort((a, b) => {
    const aTime = typeof a[1].createdAt === 'string' ? Date.parse(a[1].createdAt) : 0;
    const bTime = typeof b[1].createdAt === 'string' ? Date.parse(b[1].createdAt) : 0;
    if (aTime !== bTime) return aTime - bTime;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return sorted.map(([bubbleId, bubble]) => {
    const entry: CursorConversationHeaderEntry = {
      bubbleId,
      type: typeof bubble.type === 'number' ? bubble.type : BUBBLE_TYPE_AI,
    };
    if (typeof bubble.createdAt === 'string') entry.createdAt = bubble.createdAt;
    return entry;
  });
}

function attachedContextCount(bubble: CursorBubble): number {
  let count = 0;
  for (const key of ['attachedCodeChunks', 'codebaseContextChunks', 'relevantFiles', 'attachedFolders', 'notepads'] as const) {
    const value = bubble[key];
    if (Array.isArray(value)) count += value.length;
  }
  return count;
}

function workspaceCwd(home: string, row: CursorHeaderRow): string | undefined {
  if (row.workspaceId === null) return undefined;
  const info = listCursorWorkspaces(home).find((item) => item.workspaceId === row.workspaceId);
  return info?.cwd;
}

function buildMeta(
  data: CursorComposerData,
  row: CursorHeaderRow,
  header: CursorHeaderRecord | undefined,
  workspaceCwdValue: string | undefined,
  options: ReadCursorOptions,
  events: IrEvent[],
): IrSession['meta'] {
  const meta: IrSession['meta'] = {};
  const cwd =
    fsPathFromWorkspaceIdentifier(data.workspaceIdentifier) ??
    fsPathFromWorkspaceIdentifier(header?.header.workspaceIdentifier) ??
    workspaceCwdValue;
  if (cwd !== undefined) meta.cwd = cwd;
  const title =
    options.title ??
    (typeof header?.header.name === 'string' && header.header.name.trim().length > 0
      ? header.header.name.trim()
      : undefined) ??
    (typeof data.name === 'string' && data.name.trim().length > 0 ? data.name.trim() : undefined) ??
    firstUserText(events);
  if (title !== undefined) meta.title = title;
  const createdAt = msToIso(data.createdAt ?? row.createdAt) ?? (events[0] as IrEvent | undefined)?.at;
  if (createdAt !== undefined) meta.createdAt = createdAt;
  const updatedAt = msToIso(data.lastUpdatedAt ?? row.lastUpdatedAt ?? row.recency);
  if (updatedAt !== undefined) meta.updatedAt = updatedAt;
  const model = data.modelConfig;
  if (model !== undefined && typeof model.modelName === 'string' && model.modelName.length > 0) meta.model = model.modelName;
  if (typeof data.unifiedMode === 'string') meta.profile = data.unifiedMode;
  if (row.isArchived === 1 || header?.header.isArchived === true) meta.archived = true;
  const lastUser = lastUserText(events);
  if (lastUser !== undefined) meta.lastPrompt = lastUser.slice(0, 200);
  return meta;
}

function firstUserText(events: IrEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== 'message' || event.role !== 'user' || event.synthetic === true) continue;
    const text = event.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) return text.length > 80 ? text.slice(0, 80) + '…' : text;
  }
  return undefined;
}

function lastUserText(events: IrEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== 'message' || event.role !== 'user') continue;
    const text = event.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function appendNotices(notices: IrNotice[], counters: Counters, header: CursorHeaderRecord | undefined): void {
  if (counters.missingBubbles > 0) {
    notices.push({
      code: 'cursor.missing-bubble',
      message: 'fullConversationHeadersOnly 里的气泡在库里缺失（会话可能被部分清理）',
      count: counters.missingBubbles,
      severity: 'warning',
    });
  }
  if (counters.badBubbles > 0) {
    notices.push({
      code: 'cursor.bad-bubble',
      message: '气泡 JSON 解析失败，已跳过',
      count: counters.badBubbles,
      severity: 'warning',
    });
  }
  if (counters.emptyBubbles > 0) {
    notices.push({
      code: 'cursor.empty-bubble',
      message: '空占位气泡（没有正文/思考/工具数据），已跳过',
      count: counters.emptyBubbles,
      severity: 'info',
    });
  }
  if (counters.noHeadersFallback > 0) {
    notices.push({
      code: 'cursor.headers-missing',
      message: 'composerData 缺少 fullConversationHeadersOnly，已按气泡 createdAt 兜底排序',
      count: counters.noHeadersFallback,
      severity: 'warning',
    });
  }
  if (counters.synthetic > 0) {
    notices.push({
      code: 'cursor.synthetic-user-message',
      message: 'Cursor 运行时注入的用户消息（后台任务通知等）已标记 synthetic',
      count: counters.synthetic,
      severity: 'info',
    });
  }
  if (counters.images > 0) {
    notices.push({
      code: 'cursor.image-metadata-only',
      message: '图片只有元数据（uuid/尺寸），本地库里没有二进制，IR 里用 ref 占位',
      count: counters.images,
      severity: 'warning',
    });
  }
  if (counters.reasoning > 0) {
    notices.push({
      code: 'cursor.thinking',
      message: 'thinking 块映射为 IR reasoning（plain）',
      count: counters.reasoning,
      severity: 'info',
    });
  }
  if (counters.toolCalls > 0) {
    notices.push({
      code: 'cursor.tool-bubbles',
      message: 'toolFormerData 映射为 tool_call + tool_result',
      count: counters.toolCalls,
      severity: 'info',
    });
  }
  if (counters.toolResultsMissing > 0) {
    notices.push({
      code: 'cursor.tool-result-missing',
      message: '工具调用没有记录结果（status 非 completed 或结果被清理），只保留 tool_call',
      count: counters.toolResultsMissing,
      severity: 'info',
    });
  }
  if (counters.interpreterResults > 0) {
    notices.push({
      code: 'cursor.interpreter-results',
      message: 'interpreterResults（旧版工具结果）映射为孤立 tool_result',
      count: counters.interpreterResults,
      severity: 'info',
    });
  }
  if (counters.attachedContext > 0) {
    notices.push({
      code: 'cursor.attached-context-skipped',
      message: '用户气泡里附带的代码块/文件选择上下文没有导出（Cursor 侧重选）',
      count: counters.attachedContext,
      severity: 'info',
    });
  }
  if (counters.displayOnly > 0) {
    notices.push({
      code: 'cursor.display-only-bubble',
      message: 'isDisplayOnly 气泡是 UI 辅助内容，已跳过',
      count: counters.displayOnly,
      severity: 'info',
    });
  }
  for (const [key, count] of counters.unknownBubbles) {
    notices.push({ code: 'cursor.unknown-bubble', message: '未识别的气泡结构 ' + key, count, severity: 'warning' });
  }
  if (header === undefined) {
    notices.push({
      code: 'cursor.header-missing',
      message: 'composerHeaders 里没有这一行（可能只存在于旧版 blob），列表里可能不可见',
      count: 1,
      severity: 'warning',
    });
  }
}

/** header 缺失时也能读（基于 composerData + bubble 前缀扫描） */
function loadWithoutHeader(
  db: ReturnType<typeof openCursorDb>,
  composerId: string,
  home: string,
  dbPath: string,
  options: ReadCursorOptions,
): LoadedComposer {
  const data = parseComposerData(db, composerId);
  const notices: IrNotice[] = [
    {
      code: 'cursor.header-missing',
      message: 'composerHeaders 里没有这一行（可能只存在于旧版 blob），列表里可能不可见',
      count: 1,
      severity: 'warning',
    },
  ];
  const counters = emptyCounters();
  const entries = conversationHeaders(data, db, composerId, counters);
  const ids = entries.map((entry) => entry.bubbleId);
  const { bubbles, missing, bad } = readBubbles(db, composerId, ids);
  counters.missingBubbles += missing.length;
  counters.badBubbles += bad.length;
  const events: IrEvent[] = [];
  const push = (event: Omit<IrEvent, 'id' | 'parentId'>): void => {
    const id = 'cursor:e' + String(events.length + 1).padStart(6, '0');
    const parentId = events.length === 0 ? null : (events[events.length - 1] as IrEvent).id;
    events.push({ ...(event as IrEvent), id, parentId });
  };
  const fallbackAt = msToIso(data.createdAt) ?? new Date(0).toISOString();
  for (const entry of entries) {
    const bubble = bubbles.get(entry.bubbleId);
    if (bubble === undefined) continue;
    const at = eventTime(bubble, entry, fallbackAt);
    if (bubble.type === BUBBLE_TYPE_HUMAN) {
      const text = bubbleText(bubble);
      if (text.trim().length > 0) push({ kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] });
      continue;
    }
    if (bubble.type === BUBBLE_TYPE_AI) {
      const thinking = bubbleThinkingText(bubble);
      if (thinking.trim().length > 0) push({ kind: 'reasoning', at, reasoning: { kind: 'plain', text: thinking } });
      const text = bubbleText(bubble);
      if (text.trim().length > 0) push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text }] });
    }
  }
  appendNotices(notices, counters, undefined);
  const emptyRow: CursorHeaderRow = {
    composerId,
    workspaceId: null,
    createdAt: null,
    lastUpdatedAt: null,
    isArchived: null,
    isSubagent: null,
    recency: null,
    checkpointAt: null,
    subagentTypeName: null,
    value: '',
  };
  const meta = buildMeta(data, emptyRow, undefined, undefined, options, events);
  const session: IrSession = {
    id: 'cursor:' + composerId,
    source: {
      agent: CURSOR_AGENT_ID,
      cliVersion: detectCursorVersion(home),
      formatVersion: typeof data._v === 'number' ? String(data._v) : undefined,
      nativeSessionId: composerId,
      nativePath: dbPath,
    },
    meta,
    events,
    head: events.length > 0 ? (events[events.length - 1] as IrEvent).id : null,
    notices,
  };
  return { session, data };
}

