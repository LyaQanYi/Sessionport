/**
 * 读：Claude Code 会话 JSONL → IR。
 *
 * 数据源：<CLAUDE_CONFIG_DIR>/projects/<slug>/<sessionId>.jsonl（默认 ~/.claude）
 * 输入可以是 .jsonl 路径、会话 uuid（或唯一前缀）、配置根目录，或 'last'（mtime 最新）。
 *
 * 映射：
 * - user text            -> message(user)
 * - user tool_result     -> tool_result（按 tool_use_id 与前面出现过的 tool_use 配对）
 * - assistant text       -> message(assistant)
 * - assistant thinking   -> reasoning(plain)，带 signature
 * - redacted_thinking    -> reasoning(opaque)
 * - assistant tool_use   -> tool_call
 * - system compact_boundary -> boundary(compact)；其它 system 行记 notice
 * - custom-title / summary / agent-name 只用于标题，不产生事件
 * - isSidechain 行属于子代理：按 agentId / parentUuid 连通关系分组为 bundle.children，
 *   根会话不再包含这些行；无法归组的行记 warning
 * - <sessionId>/subagents 下（含 workflows 子目录）的 agent-<agentId>.jsonl 是子代理权威 transcript（真实 Claude
 *   会把它们单独落盘，workflows 还会再嵌套一层），优先于主文件里的 sidechain 镜像行；
 *   agent-*.meta.json 的 description / toolUseId / agentType 用于标题、viaToolCallId 和 profile
 *
 * 容错：坏 JSON 行跳过并计数；未知行/未知 content block 记 notice，不抛错。
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type {
  IrBoundaryEvent,
  IrBundle,
  IrChildSession,
  IrContent,
  IrEvent,
  IrMessageEvent,
  IrNotice,
  IrPart,
  IrReasoningEvent,
  IrSession,
  IrToolCallEvent,
  IrToolResultEvent,
} from '@sessionport/core';

import { claudeConfigDir, projectsDir } from './paths.ts';

export interface ReadClaudeOptions {
  /** Claude 配置目录，默认 $CLAUDE_CONFIG_DIR 或 ~/.claude */
  configDir?: string;
  /** configDir 的别名（与 core 的 ListSessionsOptions.home 保持一致） */
  home?: string;
  /** input 是目录/配置根目录时，用它选择会话 id（默认取 mtime 最新） */
  sessionId?: string;
  /** 覆盖标题（默认 custom-title > summary > agent-name > 首条真实 user 文本） */
  title?: string;
}

/** writer / 真实 Claude 都会出现的非对话行：读的时候直接忽略 */
const IGNORED_ROW_TYPES = new Set<string>([
  'attachment',
  'last-prompt',
  'last-prompt-state',
  'mode',
  'permission-mode',
  'atis-latch',
  'queue-operation',
  'cost-state',
  'pr-link',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'relocated',
  'worktree-state',
  'api-request',
  'api-request-shape',
  'api-request-blob',
  'progress',
  'started',
  'result',
  'ai-title',
]);

type EventInput =
  | Omit<IrMessageEvent, 'id' | 'parentId'>
  | Omit<IrReasoningEvent, 'id' | 'parentId'>
  | Omit<IrToolCallEvent, 'id' | 'parentId'>
  | Omit<IrToolResultEvent, 'id' | 'parentId'>
  | Omit<IrBoundaryEvent, 'id' | 'parentId'>;

interface ClaudeRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: unknown;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  agentId?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  userType?: string;
  toolUseResult?: unknown;
  customTitle?: string;
  summary?: string;
  agentName?: string;
  subtype?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    [key: string]: unknown;
  };
}

interface ParsedRows {
  rows: ClaudeRow[];
  badLines: number;
}

interface Counters {
  systemLines: number;
  compactBoundaries: number;
  orphanResults: number;
  syntheticUsers: number;
  imageParts: number;
  redactedThinking: number;
  emptyThinking: number;
  calls: Set<string>;
  results: Set<string>;
  unknownLines: Map<string, number>;
  unknownBlocks: Map<string, number>;
}

export interface ClaudeSessionFile {
  filePath: string;
  sessionId: string;
  projectSlug: string;
}

function emptyCounters(): Counters {
  return {
    systemLines: 0,
    compactBoundaries: 0,
    orphanResults: 0,
    syntheticUsers: 0,
    imageParts: 0,
    redactedThinking: 0,
    emptyThinking: 0,
    calls: new Set(),
    results: new Set(),
    unknownLines: new Map(),
    unknownBlocks: new Map(),
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max).trimEnd() + '…' : normalized;
}

/** 只解析完整、合法的 JSON 行；坏行只计数（写到一半的尾行很常见） */
function parseJsonLines(text: string): ParsedRows {
  const rows: ClaudeRow[] = [];
  let badLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) rows.push(value as ClaudeRow);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

/** slug 反解 cwd；'-' 会误拆目录名，所以只在结果真实存在时采用 */
function cwdFromSlug(slug: string): string | undefined {
  if (!slug.startsWith('-')) return undefined;
  const decoded = '/' + slug.slice(1).split('-').join('/');
  return existsSync(decoded) ? decoded : undefined;
}

function imageRef(block: Record<string, unknown>): string | undefined {
  const source = recordOf(block.source);
  if (source !== undefined) {
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return 'data:' + media + ';base64,' + source.data;
    }
    if (typeof source.url === 'string') return source.url;
  }
  if (typeof block.url === 'string') return block.url;
  return undefined;
}

function toolResultContent(value: unknown): IrContent[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.length > 0 ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [{ type: 'json', value }];
  const out: IrContent[] = [];
  for (const item of value) {
    const block = recordOf(item);
    if (block === undefined) {
      out.push({ type: 'json', value: item });
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const ref = imageRef(block);
      out.push({ type: 'image', ref: ref ?? 'image' });
      continue;
    }
    out.push({ type: 'json', value: block });
  }
  return out;
}

/** 首条“真实”用户文本：跳过 meta / 工具结果回灌 / 注入指令；sidechain 只在读子会话时纳入 */
function realUserText(row: ClaudeRow, includeSidechain = false): string | undefined {
  if (row.isSidechain === true && !includeSidechain) return undefined;
  if (row.isMeta === true || row.isCompactSummary === true) return undefined;
  if (row.toolUseResult !== undefined) return undefined;
  const content = row.message?.content;
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const item of content) {
      const block = recordOf(item);
      if (block === undefined) continue;
      if (block.type === 'tool_result') return undefined;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  const joined = texts.join('\n').replace(/\s+/gu, ' ').trim();
  if (joined.length === 0) return undefined;
  if (joined.startsWith('<') || joined.startsWith('[Request interrupted')) return undefined;
  return joined;
}

// ---------------------------------------------------------------------------
// 行 -> 事件 / notice（根会话与 sidechain 子会话共用同一套解析）
// ---------------------------------------------------------------------------

interface SessionMetaScan {
  sessionId?: string;
  cwd?: string;
  model?: string;
  version?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  customTitle?: string;
  summaryTitle?: string;
  agentName?: string;
  firstUserText?: string;
  lastPrompt?: string;
}

/** 扫元数据 / 标题候选 / 时间范围；根会话传过滤后的行，子会话传自己的 sidechain 行 */
function scanSessionMeta(rows: ClaudeRow[], includeSidechain = false): SessionMetaScan {
  const meta: SessionMetaScan = {};
  for (const row of rows) {
    if (row.isSidechain === true && !includeSidechain) continue;
    const type = typeof row.type === 'string' ? row.type : '';
    if (meta.sessionId === undefined) meta.sessionId = textOf(row.sessionId);
    if (meta.cwd === undefined) meta.cwd = textOf(row.cwd);
    if (meta.version === undefined) meta.version = textOf(row.version);
    if (type === 'assistant') {
      const candidate = textOf(row.message?.model);
      if (candidate !== undefined) meta.model = candidate;
    }
    if (type === 'custom-title') meta.customTitle = textOf(row.customTitle) ?? meta.customTitle;
    if (type === 'summary') meta.summaryTitle = textOf(row.summary) ?? meta.summaryTitle;
    if (type === 'agent-name') meta.agentName = textOf(row.agentName) ?? meta.agentName;
    if (type === 'user') {
      const text = realUserText(row, includeSidechain);
      if (text !== undefined) {
        if (meta.firstUserText === undefined) meta.firstUserText = text;
        meta.lastPrompt = text;
      }
    }
    const at = normalizeIso(row.timestamp);
    if (at !== undefined) {
      if (meta.firstTimestamp === undefined) meta.firstTimestamp = at;
      meta.lastTimestamp = at;
    }
  }
  return meta;
}

interface EventSink {
  events: IrEvent[];
  counters: Counters;
  /** 事件 id 前缀：根会话 claude，子会话 claude:c1 */
  idPrefix: string;
  fallbackAt: string;
}

/** 把 Claude 行映射成 IR 事件；调用方负责先按 sidechain / agentId 分好行 */
function emitRows(rows: ClaudeRow[], sink: EventSink): void {
  const counters = sink.counters;
  let eventIndex = 0;
  const push = (event: EventInput, at: string): void => {
    eventIndex += 1;
    sink.events.push({
      ...(event as IrEvent),
      id: sink.idPrefix + ':e' + String(eventIndex).padStart(6, '0'),
      parentId: sink.events.length > 0 ? sink.events[sink.events.length - 1]!.id : null,
      at,
    } as IrEvent);
  };

  for (const row of rows) {
    const type = typeof row.type === 'string' ? row.type : '';
    const at = normalizeIso(row.timestamp) ?? sink.fallbackAt;

    if (type === 'user') {
      const content = row.message?.content;
      const synthetic = row.isMeta === true || row.isCompactSummary === true;
      if (synthetic) counters.syntheticUsers += 1;
      let pending: IrPart[] = [];
      const flush = (): void => {
        if (pending.length === 0) return;
        const event: Omit<IrMessageEvent, 'id' | 'parentId'> = { kind: 'message', at, role: 'user', parts: pending };
        if (synthetic) event.synthetic = true;
        push(event, at);
        pending = [];
      };

      if (typeof content === 'string') {
        if (content.length > 0) pending.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          const block = recordOf(item);
          if (block === undefined) {
            bump(counters.unknownBlocks, 'user:invalid');
            continue;
          }
          if (block.type === 'text') {
            if (typeof block.text === 'string' && block.text.length > 0) pending.push({ type: 'text', text: block.text });
            continue;
          }
          if (block.type === 'image') {
            counters.imageParts += 1;
            pending.push({ type: 'image', ref: imageRef(block) ?? 'image' });
            continue;
          }
          if (block.type === 'tool_result') {
            flush();
            const callId = textOf(block.tool_use_id);
            if (callId === undefined) {
              bump(counters.unknownBlocks, 'tool_result:no-id');
              continue;
            }
            if (!counters.calls.has(callId)) counters.orphanResults += 1;
            else counters.results.add(callId);
            const event: Omit<IrToolResultEvent, 'id' | 'parentId'> = {
              kind: 'tool_result',
              at,
              callId,
              content: toolResultContent(block.content),
            };
            if (block.is_error === true) event.isError = true;
            push(event, at);
            continue;
          }
          bump(counters.unknownBlocks, 'user:' + String(block.type ?? '<missing>'));
        }
      } else if (content !== undefined) {
        bump(counters.unknownBlocks, 'user:content:' + typeof content);
      }
      flush();
      continue;
    }

    if (type === 'assistant') {
      const content = row.message?.content;
      if (typeof content === 'string') {
        if (content.length > 0) push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text: content }] }, at);
        continue;
      }
      if (!Array.isArray(content)) {
        bump(counters.unknownBlocks, 'assistant:content:' + typeof content);
        continue;
      }
      for (const item of content) {
        const block = recordOf(item);
        if (block === undefined) {
          bump(counters.unknownBlocks, 'assistant:invalid');
          continue;
        }
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.length > 0) {
            push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text: block.text }] }, at);
          }
          continue;
        }
        if (block.type === 'thinking') {
          const thinking = typeof block.thinking === 'string' ? block.thinking : '';
          if (thinking.length === 0) {
            counters.emptyThinking += 1;
            continue;
          }
          const signature = textOf(block.signature);
          const reasoning = signature !== undefined
            ? { kind: 'plain' as const, text: thinking, signature }
            : { kind: 'plain' as const, text: thinking };
          push({ kind: 'reasoning', at, reasoning }, at);
          continue;
        }
        if (block.type === 'redacted_thinking') {
          counters.redactedThinking += 1;
          push({ kind: 'reasoning', at, reasoning: { kind: 'opaque', payload: block.data ?? block, format: 'claude.redacted_thinking' } }, at);
          continue;
        }
        if (block.type === 'tool_use') {
          const callId = textOf(block.id);
          if (callId === undefined) {
            bump(counters.unknownBlocks, 'tool_use:no-id');
            continue;
          }
          counters.calls.add(callId);
          push({
            kind: 'tool_call',
            at,
            callId,
            name: textOf(block.name) ?? 'unknown',
            input: block.input ?? {},
          }, at);
          continue;
        }
        bump(counters.unknownBlocks, 'assistant:' + String(block.type ?? '<missing>'));
      }
      continue;
    }

    if (type === 'system' || type === 'compact_boundary') {
      const subtype = type === 'compact_boundary' ? 'compact_boundary' : textOf(row.subtype);
      if (subtype === 'compact_boundary') {
        counters.compactBoundaries += 1;
        push({ kind: 'boundary', at, boundary: 'compact', detail: 'claude.compact_boundary' }, at);
      } else {
        counters.systemLines += 1;
      }
      continue;
    }

    if (type === 'custom-title' || type === 'summary' || type === 'agent-name' || IGNORED_ROW_TYPES.has(type)) continue;

    bump(counters.unknownLines, type.length > 0 ? type : '<missing>');
  }
}

/** 把计数转成 notice；leading 用来插入 sidechain 归组结果等前置 notice */
function buildNotices(counters: Counters, badLines: number, leading: IrNotice[] = []): IrNotice[] {
  const notices: IrNotice[] = [];
  if (badLines > 0) {
    notices.push({
      code: 'claude.bad-json-lines',
      message: '无法解析的 JSONL 行已跳过（可能写到一半或文件损坏）',
      count: badLines,
      severity: 'warning',
    });
  }
  notices.push(...leading);

  const missingResults = [...counters.calls].filter((id) => !counters.results.has(id)).length;
  if (counters.orphanResults > 0) {
    notices.push({
      code: 'claude.orphan-tool-result',
      message: '找不到对应 tool_use 的 tool_result（保留了结果，重新导出时可能被降级）',
      count: counters.orphanResults,
      severity: 'warning',
    });
  }
  if (missingResults > 0) {
    notices.push({ code: 'claude.tool-without-result', message: '工具调用没有结果（进行中或被打断）', count: missingResults, severity: 'warning' });
  }
  for (const [block, count] of counters.unknownBlocks) {
    notices.push({ code: 'claude.unknown-content-block', message: '未识别的 content block ' + block, count, severity: 'warning' });
  }
  for (const [rowType, count] of counters.unknownLines) {
    notices.push({ code: 'claude.unknown-line-type', message: '未识别的行类型 ' + rowType, count, severity: 'warning' });
  }
  if (counters.syntheticUsers > 0) {
    notices.push({ code: 'claude.synthetic-user-message', message: 'isMeta / compact summary 用户消息已标记 synthetic', count: counters.syntheticUsers, severity: 'info' });
  }
  if (counters.compactBoundaries > 0) {
    notices.push({ code: 'claude.compact-boundary', message: 'compact_boundary 已映射成 boundary(compact)', count: counters.compactBoundaries, severity: 'info' });
  }
  if (counters.systemLines > 0) {
    notices.push({ code: 'claude.system-lines-skipped', message: 'system 行（非 compact_boundary）已跳过', count: counters.systemLines, severity: 'info' });
  }
  if (counters.emptyThinking > 0) {
    notices.push({ code: 'claude.empty-thinking-block', message: '空的 thinking block 已跳过', count: counters.emptyThinking, severity: 'info' });
  }
  if (counters.redactedThinking > 0) {
    notices.push({ code: 'claude.redacted-thinking', message: 'redacted_thinking 以 opaque reasoning 保留', count: counters.redactedThinking, severity: 'info' });
  }
  if (counters.imageParts > 0) {
    notices.push({ code: 'claude.image-block', message: '图片 block 以 data URI / 引用保留，跨 agent 导出时可能丢失', count: counters.imageParts, severity: 'info' });
  }
  return notices;
}

// ---------------------------------------------------------------------------
// sidechain 分组
// ---------------------------------------------------------------------------

interface SidechainGroup {
  key: string;
  agentId?: string;
  rootUuid?: string;
  rows: ClaudeRow[];
  firstIndex: number;
  /** 子代理 transcript 的磁盘路径（主文件里的 sidechain 镜像行为空） */
  filePath?: string;
  /** 子代理类型，落到 IrMeta.profile */
  profile?: string;
  /** 优先于首条用户文本的标题（meta.json 的 description / workflow label） */
  titleHint?: string;
  /** 触发子代理的工具调用 id（meta.json 的 toolUseId） */
  viaToolCallId?: string;
  /** 子代理 transcript 里的坏行数 */
  badLines?: number;
}

interface SidechainGrouping {
  groups: SidechainGroup[];
  /** 既没有 agentId、也没有任何 parentUuid 的孤立 sidechain 行 */
  ungrouped: ClaudeRow[];
}

/**
 * 同一父会话里的 sidechain 行 -> 子会话分组。
 * - 有 agentId 的行按 agentId 归组（同一 agent 的行即使被主会话行穿插也合并）；
 * - 没有 agentId 的行按 sidechain 行之间的 parentUuid 连通关系归组；
 * - 两者都没有的孤立行无法归组，交给调用方记 warning。
 */
function groupSidechainRows(rows: ClaudeRow[]): SidechainGrouping {
  const sideRows = rows.filter((row) => row.isSidechain === true);
  if (sideRows.length === 0) return { groups: [], ungrouped: [] };

  const order = new Map<ClaudeRow, number>();
  sideRows.forEach((row, index) => order.set(row, index));

  const parents = sideRows.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    let cursor = index;
    while (parents[cursor] !== cursor) {
      const next = parents[cursor]!;
      parents[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // 文件里更早的行为组根，保证分组稳定
    if (rootA < rootB) parents[rootB] = rootA;
    else parents[rootA] = rootB;
  };

  const indexByUuid = new Map<string, number>();
  for (const [index, row] of sideRows.entries()) {
    const uuid = textOf(row.uuid);
    if (uuid !== undefined && !indexByUuid.has(uuid)) indexByUuid.set(uuid, index);
  }
  for (const [index, row] of sideRows.entries()) {
    const parentUuid = textOf(row.parentUuid);
    if (parentUuid === undefined) continue;
    const parentIndex = indexByUuid.get(parentUuid);
    if (parentIndex !== undefined) union(index, parentIndex);
  }

  const components = new Map<number, number[]>();
  for (let index = 0; index < sideRows.length; index += 1) {
    const root = find(index);
    const members = components.get(root);
    if (members === undefined) components.set(root, [index]);
    else members.push(index);
  }

  const byKey = new Map<string, SidechainGroup>();
  const ungrouped: ClaudeRow[] = [];
  const addGroup = (key: string, indexes: number[], identity: { agentId?: string; rootUuid?: string }): void => {
    const existing = byKey.get(key);
    const group = existing ?? { key, agentId: identity.agentId, rootUuid: identity.rootUuid, rows: [], firstIndex: indexes[0]! };
    for (const index of indexes) group.rows.push(sideRows[index]!);
    group.firstIndex = Math.min(group.firstIndex, indexes[0]!);
    if (group.agentId === undefined) group.agentId = identity.agentId;
    if (group.rootUuid === undefined) group.rootUuid = identity.rootUuid;
    if (existing === undefined) byKey.set(key, group);
  };

  for (const indexes of components.values()) {
    const componentRows = indexes.map((index) => sideRows[index]!);
    const agentIds: string[] = [];
    for (const row of componentRows) {
      const agentId = textOf(row.agentId);
      if (agentId !== undefined && !agentIds.includes(agentId)) agentIds.push(agentId);
    }

    if (agentIds.length === 0) {
      const linked = componentRows.some((row) => textOf(row.parentUuid) !== undefined);
      if (!linked) {
        ungrouped.push(...componentRows);
        continue;
      }
      const first = componentRows[0]!;
      const rootUuid = textOf(first.uuid) ?? textOf(first.parentUuid);
      // 没有 uuid 时用“行号”做分组键，避免两条都只指向同一个主会话 parentUuid 的链被误合并
      const key = textOf(first.uuid) ?? 'row-' + String(indexes[0]! + 1);
      addGroup('chain:' + key, indexes, { rootUuid });
      continue;
    }

    if (agentIds.length === 1) {
      addGroup('agent:' + agentIds[0]!, indexes, { agentId: agentIds[0]! });
      continue;
    }

    // 异常数据：同一个 parentUuid 连通块里混了多个 agentId。
    // 各自按 agentId 分组，缺 agentId 的行归到文件里先出现的子代理。
    for (const agentId of agentIds) {
      const own = componentRows.filter((row) => textOf(row.agentId) === agentId);
      addGroup('agent:' + agentId, own.map((row) => order.get(row)!), { agentId });
    }
    const unassigned = componentRows.filter((row) => textOf(row.agentId) === undefined);
    if (unassigned.length > 0) {
      addGroup('agent:' + agentIds[0]!, unassigned.map((row) => order.get(row)!), { agentId: agentIds[0]! });
    }
  }

  const groups = [...byKey.values()];
  for (const group of groups) group.rows.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  groups.sort((a, b) => a.firstIndex - b.firstIndex);
  ungrouped.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { groups, ungrouped };
}

// ---------------------------------------------------------------------------
// 磁盘上的子代理 transcript
// ---------------------------------------------------------------------------

/** <sessionId>/subagents 下任意层级（workflows 会再嵌套一层）的 agent-<agentId>.jsonl，真实 Claude 落盘位置 */
const SUBAGENT_FILE_PATTERN = /^agent-([A-Za-z0-9]+)\.jsonl$/u;
const SUBAGENT_SCAN_MAX_DEPTH = 4;

interface SubagentSidecar {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

interface DiskSubagent {
  agentId: string;
  filePath: string;
  rows: ClaudeRow[];
  badLines: number;
  sidecar: SubagentSidecar;
  /** workflows/<wf>/journal.jsonl 里的 started label（比首条用户文本更适合当标题） */
  workflowLabel?: string;
}

async function collectSubagentFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > SUBAGENT_SCAN_MAX_DEPTH) return [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSubagentFiles(full, depth + 1)));
    else if (entry.isFile() && SUBAGENT_FILE_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

async function readSubagentSidecar(filePath: string): Promise<SubagentSidecar> {
  let raw: string;
  try {
    raw = await readFile(filePath.replace(/\.jsonl$/u, '.meta.json'), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const record = recordOf(parsed);
  if (record === undefined) return {};
  const sidecar: SubagentSidecar = {};
  const agentType = textOf(record.agentType);
  if (agentType !== undefined) sidecar.agentType = agentType;
  const description = textOf(record.description);
  if (description !== undefined) sidecar.description = description;
  const toolUseId = textOf(record.toolUseId);
  if (toolUseId !== undefined) sidecar.toolUseId = toolUseId;
  return sidecar;
}

/** workflow journal：agentId -> started 行的 label */
async function readWorkflowLabel(filePath: string, agentId: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dirname(filePath), 'journal.jsonl'), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = recordOf(parsed);
    if (record === undefined) continue;
    if (textOf(record.type) !== 'started') continue;
    if (textOf(record.agentId) !== agentId) continue;
    const label = textOf(record.label);
    if (label !== undefined) return label;
  }
  return undefined;
}

/**
 * 扫 <sessionId>/subagents：Claude 把子代理（含 workflow 子代理）写成独立 transcript。
 * 老版本 / 部分构建只把 sidechain 镜像写进主文件，那时返回空数组，行为保持原样。
 */
async function discoverSubagentTranscripts(filePath: string): Promise<DiskSubagent[]> {
  const root = join(dirname(filePath), basename(filePath, '.jsonl'), 'subagents');
  if (!existsSync(root)) return [];
  const byAgent = new Map<string, DiskSubagent>();
  for (const subagentPath of await collectSubagentFiles(root)) {
    let text: string;
    try {
      text = await readFile(subagentPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseJsonLines(text);
    if (parsed.rows.length === 0) continue;
    const fromName = SUBAGENT_FILE_PATTERN.exec(basename(subagentPath))?.[1];
    const fromRows = parsed.rows.map((row) => textOf(row.agentId)).find((value) => value !== undefined);
    const agentId = fromName ?? fromRows;
    if (agentId === undefined) continue;
    const existing = byAgent.get(agentId);
    if (existing !== undefined) {
      // 同一个 agent 出现多份（重复拷贝 / 重试）时按 uuid 去重合并，保留先发现的那份路径
      const seen = new Set<string>();
      for (const row of existing.rows) {
        const uuid = textOf(row.uuid);
        if (uuid !== undefined) seen.add(uuid);
      }
      for (const row of parsed.rows) {
        const uuid = textOf(row.uuid);
        if (uuid !== undefined && seen.has(uuid)) continue;
        if (uuid !== undefined) seen.add(uuid);
        existing.rows.push(row);
      }
      existing.badLines += parsed.badLines;
      continue;
    }
    const sidecar = await readSubagentSidecar(subagentPath);
    const workflowLabel = await readWorkflowLabel(subagentPath, agentId);
    const transcript: DiskSubagent = { agentId, filePath: subagentPath, rows: parsed.rows, badLines: parsed.badLines, sidecar };
    if (workflowLabel !== undefined) transcript.workflowLabel = workflowLabel;
    byAgent.set(agentId, transcript);
  }
  return [...byAgent.values()];
}

interface DiskMergeResult {
  replaced: number;
  added: number;
  extraInlineRows: number;
}

/**
 * 磁盘 transcript（权威）与主文件里的 sidechain 镜像行合并：
 * - 同一个 agentId：以磁盘为准；镜像里磁盘没有的行追加到末尾（极少见，避免丢数据）；
 * - 只在磁盘上存在：新增子会话，排在内联分组之后。
 */
function mergeDiskSubagents(groups: SidechainGroup[], disk: DiskSubagent[]): DiskMergeResult {
  const byAgent = new Map<string, SidechainGroup>();
  for (const group of groups) {
    if (group.agentId !== undefined && !byAgent.has(group.agentId)) byAgent.set(group.agentId, group);
  }
  let replaced = 0;
  let added = 0;
  let extraInlineRows = 0;
  let nextIndex = 1_000_000;
  for (const transcript of disk) {
    const titleHint = transcript.sidecar.description ?? transcript.workflowLabel;
    const existing = byAgent.get(transcript.agentId);
    if (existing === undefined) {
      const group: SidechainGroup = {
        key: 'agent:' + transcript.agentId,
        agentId: transcript.agentId,
        rows: [...transcript.rows],
        firstIndex: nextIndex,
        filePath: transcript.filePath,
        badLines: transcript.badLines,
      };
      if (transcript.sidecar.agentType !== undefined) group.profile = transcript.sidecar.agentType;
      if (titleHint !== undefined) group.titleHint = titleHint;
      if (transcript.sidecar.toolUseId !== undefined) group.viaToolCallId = transcript.sidecar.toolUseId;
      nextIndex += 1;
      groups.push(group);
      byAgent.set(transcript.agentId, group);
      added += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const row of transcript.rows) {
      const uuid = textOf(row.uuid);
      if (uuid !== undefined) seen.add(uuid);
    }
    const extra = existing.rows.filter((row) => {
      const uuid = textOf(row.uuid);
      return uuid !== undefined && !seen.has(uuid);
    });
    existing.rows = [...transcript.rows, ...extra];
    existing.filePath = transcript.filePath;
    existing.badLines = (existing.badLines ?? 0) + transcript.badLines;
    if (transcript.sidecar.agentType !== undefined) existing.profile = transcript.sidecar.agentType;
    if (titleHint !== undefined) existing.titleHint = titleHint;
    if (transcript.sidecar.toolUseId !== undefined) existing.viaToolCallId = transcript.sidecar.toolUseId;
    replaced += 1;
    extraInlineRows += extra.length;
  }
  return { replaced, added, extraInlineRows };
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

async function listProjectFiles(configRoot: string): Promise<ClaudeSessionFile[]> {
  const root = projectsDir(configRoot);
  const out: ClaudeSessionFile[] = [];
  let projects: Array<{ name: string; isDirectory(): boolean }>;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      out.push({
        filePath: join(dir, entry.name),
        sessionId: entry.name.slice(0, -'.jsonl'.length),
        projectSlug: project.name,
      });
    }
  }
  return out;
}

async function newestFile(files: Array<{ filePath: string }>): Promise<string | undefined> {
  let newest: { filePath: string; mtimeMs: number } | undefined;
  for (const file of files) {
    const info = await stat(file.filePath).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    if (newest === undefined || info.mtimeMs > newest.mtimeMs) newest = { filePath: file.filePath, mtimeMs: info.mtimeMs };
  }
  return newest?.filePath;
}

async function findById(configRoot: string, idRef: string): Promise<string> {
  const files = await listProjectFiles(configRoot);
  const exact = files.filter((file) => file.sessionId === idRef);
  if (exact.length > 0) {
    // 同一 id 被复制到多个项目目录时取最近活动的那份
    const latest = await newestFile(exact);
    if (latest !== undefined) return latest;
  }
  const prefix = files.filter((file) => file.sessionId.startsWith(idRef));
  if (prefix.length === 1) return prefix[0]!.filePath;
  if (prefix.length > 1) {
    throw new Error('Claude Code 会话 id 前缀有歧义: ' + idRef + ' -> ' + prefix.map((file) => file.sessionId).join(', '));
  }
  throw new Error('找不到 Claude Code 会话: ' + idRef + '（数据目录 ' + projectsDir(configRoot) + '）');
}

async function resolveSessionPath(input: string, configRoot: string, sessionId?: string): Promise<string> {
  const ref = input.trim();
  if (ref.length === 0) throw new Error('readClaudeSession: input 为空');
  if (ref === 'last') {
    const latest = await newestFile(await listProjectFiles(configRoot));
    if (latest === undefined) throw new Error('找不到任何 Claude Code 会话: ' + projectsDir(configRoot));
    return latest;
  }

  const absolute = resolve(ref);
  if (existsSync(absolute)) {
    const info = await stat(absolute);
    if (info.isFile()) return absolute;
    if (info.isDirectory()) {
      if (existsSync(join(absolute, 'projects'))) {
        if (sessionId !== undefined) return findById(absolute, sessionId);
        const latest = await newestFile(await listProjectFiles(absolute));
        if (latest === undefined) throw new Error('配置目录里没有会话: ' + absolute);
        return latest;
      }
      let entries: Array<{ name: string; isFile(): boolean }>;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        throw new Error('无法读取目录: ' + absolute);
      }
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => ({ filePath: join(absolute, entry.name) }));
      if (files.length === 0) throw new Error('目录里没有 Claude Code 会话 (*.jsonl): ' + absolute);
      if (sessionId !== undefined) {
        const hit = files.find((file) => basename(file.filePath, '.jsonl') === sessionId)
          ?? files.find((file) => basename(file.filePath, '.jsonl').startsWith(sessionId));
        if (hit === undefined) throw new Error('目录里找不到会话: ' + sessionId);
        return hit.filePath;
      }
      const latest = await newestFile(files);
      if (latest === undefined) throw new Error('目录里没有可读的会话: ' + absolute);
      return latest;
    }
  }

  if (ref.endsWith('.jsonl')) throw new Error('找不到 Claude Code 会话文件: ' + absolute);
  return findById(configRoot, ref);
}

// ---------------------------------------------------------------------------
// 单会话
// ---------------------------------------------------------------------------

interface BuildOptions {
  filePath: string;
  badLines: number;
  mtimeIso: string;
  title?: string;
}

/** 子代理 label：agent-<agentId 前 8 位>，没有 agentId 时用 group root uuid */
function childLabel(identity: string | undefined, index: number): string {
  if (identity === undefined) return 'agent-sc' + String(index + 1);
  const compact = identity.replace(/[^0-9a-z]/giu, '');
  if (compact.length === 0) return 'agent-sc' + String(index + 1);
  return 'agent-' + compact.slice(0, 8);
}

function uniqueChildLabel(identity: string | undefined, index: number, used: Set<string>): string {
  const base = childLabel(identity, index);
  let label = base;
  let suffix = 2;
  while (used.has(label)) {
    label = base + '-' + String(suffix);
    suffix += 1;
  }
  used.add(label);
  return label;
}

/** 每个 sidechain 分组 -> 一个 IrChildSession；事件链在子会话内部重新从 null 开始 */
function buildChildSessions(
  groups: SidechainGroup[],
  root: IrSession,
  options: BuildOptions,
  rootVersion: string | undefined,
): IrChildSession[] {
  const usedLabels = new Set<string>();
  return groups.map((group, index) => {
    const meta = scanSessionMeta(group.rows, true);
    const counters = emptyCounters();
    const events: IrEvent[] = [];
    const fallbackAt = meta.firstTimestamp ?? root.meta.createdAt ?? options.mtimeIso;
    emitRows(group.rows, {
      events,
      counters,
      idPrefix: 'claude:c' + String(index + 1),
      fallbackAt,
    });

    const identity = group.agentId ?? group.rootUuid;
    const label = uniqueChildLabel(identity, index, usedLabels);
    const childNativeId = identity ?? 'sidechain-' + String(group.firstIndex + 1);
    const version = meta.version ?? rootVersion;
    const cwd = meta.cwd ?? root.meta.cwd;
    const model = meta.model ?? root.meta.model;
    const title =
      meta.customTitle ??
      meta.summaryTitle ??
      meta.agentName ??
      group.titleHint ??
      (meta.firstUserText !== undefined ? clip(meta.firstUserText, 100) : label);
    const createdAt = meta.firstTimestamp ?? root.meta.createdAt ?? options.mtimeIso;
    const updatedAt = meta.lastTimestamp ?? root.meta.updatedAt ?? createdAt;

    const session: IrSession = {
      id: root.id + ':' + (group.agentId !== undefined ? 'agent-' + group.agentId : 'sidechain-' + childNativeId),
      source: {
        agent: 'claude-code',
        nativeSessionId: childNativeId,
        nativePath: group.filePath ?? options.filePath,
        ...(version !== undefined ? { cliVersion: version } : {}),
      },
      meta: {
        ...(cwd !== undefined ? { cwd } : {}),
        title,
        createdAt,
        updatedAt,
        ...(model !== undefined ? { model } : {}),
        ...(group.profile !== undefined ? { profile: group.profile } : {}),
        ...(meta.lastPrompt !== undefined ? { lastPrompt: clip(meta.lastPrompt, 200) } : {}),
      },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: buildNotices(counters, group.badLines ?? 0),
    };

    return {
      session,
      parentSessionId: root.id,
      ...(group.viaToolCallId !== undefined ? { viaToolCallId: group.viaToolCallId } : {}),
      label,
    };
  });
}

function buildBundle(parsed: ParsedRows, options: BuildOptions, diskSubagents: DiskSubagent[] = []): IrBundle {
  const { rows } = parsed;
  const mainRows = rows.filter((row) => row.isSidechain !== true);
  const sidechain = groupSidechainRows(rows);
  const inlineGroupCount = sidechain.groups.length;
  const diskMerge = mergeDiskSubagents(sidechain.groups, diskSubagents);
  const counters = emptyCounters();
  const events: IrEvent[] = [];
  const projectSlug = basename(dirname(options.filePath));
  const meta = scanSessionMeta(mainRows);

  const resolvedSessionId = meta.sessionId ?? basename(options.filePath, '.jsonl');
  const resolvedCwd = meta.cwd ?? cwdFromSlug(projectSlug);
  const createdAt = meta.firstTimestamp ?? options.mtimeIso;
  const updatedAt = meta.lastTimestamp ?? options.mtimeIso;
  const title =
    textOf(options.title) ??
    meta.customTitle ??
    meta.summaryTitle ??
    meta.agentName ??
    (meta.firstUserText !== undefined ? clip(meta.firstUserText, 100) : undefined);

  // 主会话只喂非 sidechain 行；事件 id / parentId 链与旧实现完全一致
  emitRows(mainRows, {
    events,
    counters,
    idPrefix: 'claude',
    fallbackAt: meta.firstTimestamp ?? options.mtimeIso,
  });

  const sidechainNotices: IrNotice[] = [];
  if (diskSubagents.length > 0) {
    sidechainNotices.push({
      code: 'claude.subagent-transcripts',
      message: '已从 subagents 目录读取 ' + String(diskSubagents.length) + ' 份子代理 transcript（磁盘为权威）',
      count: diskSubagents.length,
      severity: 'info',
    });
  }
  if (diskMerge.extraInlineRows > 0) {
    sidechainNotices.push({
      code: 'claude.subagent-mirror-extra-rows',
      message: '磁盘 transcript 之外还有主文件里的镜像行，已追加到子会话末尾',
      count: diskMerge.extraInlineRows,
      severity: 'warning',
    });
  }
  if (inlineGroupCount > 0) {
    sidechainNotices.push({
      code: 'claude.sidechain-children',
      message: '主文件里的 sidechain 镜像行已归组（' + String(inlineGroupCount) + ' 组）',
      count: inlineGroupCount,
      severity: 'info',
    });
  }
  if (sidechain.ungrouped.length > 0) {
    sidechainNotices.push({
      code: 'claude.sidechain-skipped',
      message: '无法归组的 isSidechain 行已跳过（缺少 agentId 且没有 sidechain parentUuid）',
      count: sidechain.ungrouped.length,
      severity: 'warning',
    });
  }
  const notices = buildNotices(counters, parsed.badLines, sidechainNotices);

  const session: IrSession = {
    id: 'claude-code:' + resolvedSessionId,
    source: {
      agent: 'claude-code',
      nativeSessionId: resolvedSessionId,
      nativePath: options.filePath,
      ...(meta.version !== undefined ? { cliVersion: meta.version } : {}),
    },
    meta: {
      ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
      ...(title !== undefined ? { title } : {}),
      createdAt,
      updatedAt,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.lastPrompt !== undefined ? { lastPrompt: clip(meta.lastPrompt, 200) } : {}),
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  const children = buildChildSessions(sidechain.groups, session, options, meta.version);
  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children };
}

/** 读一个 Claude Code 会话：文件路径 / session id（或唯一前缀）/ 配置目录 / 'last' */
export async function readClaudeSession(input: string, options: ReadClaudeOptions = {}): Promise<IrBundle> {
  const configRoot = claudeConfigDir(options.configDir ?? options.home);
  const filePath = await resolveSessionPath(input, configRoot, options.sessionId);
  const info = await stat(filePath).catch(() => undefined);
  const text = await readFile(filePath, 'utf8');
  const parsed = parseJsonLines(text);
  const diskSubagents = await discoverSubagentTranscripts(filePath);
  return buildBundle(
    parsed,
    {
      filePath,
      badLines: parsed.badLines,
      mtimeIso: info?.mtime.toISOString() ?? new Date().toISOString(),
      title: options.title,
    },
    diskSubagents,
  );
}
