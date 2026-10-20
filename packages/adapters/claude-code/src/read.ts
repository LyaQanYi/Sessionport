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
 * - isSidechain 行属于子代理：根会话里跳过并记 notice（独立 sidechain 文件需另行读取）
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
  sidechainRows: number;
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
    sidechainRows: 0,
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

/** 首条“真实”用户文本：跳过 meta / 工具结果回灌 / 注入指令 / sidechain */
function realUserText(row: ClaudeRow): string | undefined {
  if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) return undefined;
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

function buildBundle(parsed: ParsedRows, options: BuildOptions): IrBundle {
  const { rows } = parsed;
  const counters = emptyCounters();
  const notices: IrNotice[] = [];
  const events: IrEvent[] = [];
  const projectSlug = basename(dirname(options.filePath));

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let version: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let customTitle: string | undefined;
  let summaryTitle: string | undefined;
  let agentName: string | undefined;
  let firstUserText: string | undefined;
  let lastPrompt: string | undefined;

  // 第一遍：元数据 / 标题候选 / 时间范围（sidechain 不参与根会话）
  for (const row of rows) {
    if (row.isSidechain === true) continue;
    const type = typeof row.type === 'string' ? row.type : '';
    if (sessionId === undefined) sessionId = textOf(row.sessionId);
    if (cwd === undefined) cwd = textOf(row.cwd);
    if (version === undefined) version = textOf(row.version);
    if (type === 'assistant') {
      const candidate = textOf(row.message?.model);
      if (candidate !== undefined) model = candidate;
    }
    if (type === 'custom-title') customTitle = textOf(row.customTitle) ?? customTitle;
    if (type === 'summary') summaryTitle = textOf(row.summary) ?? summaryTitle;
    if (type === 'agent-name') agentName = textOf(row.agentName) ?? agentName;
    if (type === 'user') {
      const text = realUserText(row);
      if (text !== undefined) {
        if (firstUserText === undefined) firstUserText = text;
        lastPrompt = text;
      }
    }
    const at = normalizeIso(row.timestamp);
    if (at !== undefined) {
      if (firstTimestamp === undefined) firstTimestamp = at;
      lastTimestamp = at;
    }
  }

  const resolvedSessionId = sessionId ?? basename(options.filePath, '.jsonl');
  const resolvedCwd = cwd ?? cwdFromSlug(projectSlug);
  const createdAt = firstTimestamp ?? options.mtimeIso;
  const updatedAt = lastTimestamp ?? options.mtimeIso;
  const title =
    textOf(options.title) ??
    customTitle ??
    summaryTitle ??
    agentName ??
    (firstUserText !== undefined ? clip(firstUserText, 100) : undefined);

  let eventIndex = 0;
  const push = (event: EventInput, at: string): void => {
    eventIndex += 1;
    events.push({
      ...(event as IrEvent),
      id: 'claude:e' + String(eventIndex).padStart(6, '0'),
      parentId: events.length > 0 ? events[events.length - 1]!.id : null,
      at,
    } as IrEvent);
  };

  const fallbackAt = firstTimestamp ?? options.mtimeIso;

  // 第二遍：事件映射
  for (const row of rows) {
    if (row.isSidechain === true) {
      counters.sidechainRows += 1;
      continue;
    }
    const type = typeof row.type === 'string' ? row.type : '';
    const at = normalizeIso(row.timestamp) ?? fallbackAt;

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

  const missingResults = [...counters.calls].filter((id) => !counters.results.has(id)).length;

  if (parsed.badLines > 0) {
    notices.push({
      code: 'claude.bad-json-lines',
      message: '无法解析的 JSONL 行已跳过（可能写到一半或文件损坏）',
      count: parsed.badLines,
      severity: 'warning',
    });
  }
  if (counters.sidechainRows > 0) {
    notices.push({
      code: 'claude.sidechain-skipped',
      message: 'isSidechain 行属于子代理，根会话里已跳过；若同目录存在独立 sidechain transcript 需单独读取',
      count: counters.sidechainRows,
      severity: 'warning',
    });
  }
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

  const session: IrSession = {
    id: 'claude-code:' + resolvedSessionId,
    source: {
      agent: 'claude-code',
      nativeSessionId: resolvedSessionId,
      nativePath: options.filePath,
      ...(version !== undefined ? { cliVersion: version } : {}),
    },
    meta: {
      ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
      ...(title !== undefined ? { title } : {}),
      createdAt,
      updatedAt,
      ...(model !== undefined ? { model } : {}),
      ...(lastPrompt !== undefined ? { lastPrompt: clip(lastPrompt, 200) } : {}),
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}

/** 读一个 Claude Code 会话：文件路径 / session id（或唯一前缀）/ 配置目录 / 'last' */
export async function readClaudeSession(input: string, options: ReadClaudeOptions = {}): Promise<IrBundle> {
  const configRoot = claudeConfigDir(options.configDir ?? options.home);
  const filePath = await resolveSessionPath(input, configRoot, options.sessionId);
  const info = await stat(filePath).catch(() => undefined);
  const text = await readFile(filePath, 'utf8');
  const parsed = parseJsonLines(text);
  return buildBundle(parsed, {
    filePath,
    badLines: parsed.badLines,
    mtimeIso: info?.mtime.toISOString() ?? new Date().toISOString(),
    title: options.title,
  });
}
