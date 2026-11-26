/**
 * Antigravity（Google Antigravity 2.x App/IDE & agy CLI）本机存储格式。
 *
 * 实测（2026-11-26，macOS，Antigravity 2.35.2）：
 * - 对话正文（明文 JSONL）：
 *   `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
 *   （部分早期/轻量目录仅含截断版 `transcript.jsonl`，含 `truncated_fields`；`~/.gemini/antigravity-cli` 同构）
 * - 摘要与父子索引：`~/.gemini/antigravity/conversation_summaries.db`（只读 SQLite）
 *   含 `conversation_summaries` 表（title / preview / workspace_uris / parent_conversation_id / agent_name / last_modified_time）
 *   与 `conversations_fts`（archived 标记）
 * - 用户注释：`~/.gemini/antigravity/annotations/<conversationId>.pbtxt`（title / archived 等 pbtxt 文本）
 * - 会话加载态：`~/.gemini/antigravity/conversations/<conversationId>.db` 存私有二进制 Protobuf blob，
 *   因此本适配器作为只读源端实现（同 kimi-code / workbuddy），不支持直接写回原生多轮历史。
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { AgentId } from '@sessionport/core';

export const ANTIGRAVITY_AGENT: AgentId = 'antigravity';

export interface AntigravityToolCall {
  name?: string;
  args?: unknown;
  [key: string]: unknown;
}

export interface AntigravityStepLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  model?: string;
  error?: string;
  tool_calls?: Array<AntigravityToolCall | string>;
  truncated_fields?: unknown[];
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}

export interface ParsedAntigravityLines {
  lines: AntigravityStepLine[];
  totalLines: number;
  badLines: number;
  hasTruncatedFields: boolean;
}

export interface AntigravitySummaryRow {
  conversationId: string;
  title?: string;
  preview?: string;
  cwd?: string;
  updatedAt?: string;
  lastUserInputAt?: string;
  parentConversationId?: string;
  agentName?: string;
  nestingDepth?: number;
  projectId?: string;
  archived: boolean;
  stepCount?: number;
}

export interface AntigravityAnnotation {
  title?: string;
  archived?: boolean;
}

export interface AntigravityTranscriptFile {
  conversationId: string;
  home: string;
  path: string;
  isCompact: boolean;
  mtimeMs: number;
  size: number;
}

export interface AntigravityHeadMetadata {
  createdAt?: string;
  firstUserText?: string;
}

export function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function clip(text: string, maxLen = 80): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function expandHome(raw: string): string {
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function envAntigravityHome(): string | undefined {
  return textOf(process.env.SESSIONPORT_ANTIGRAVITY_HOME) ?? textOf(process.env.ANTIGRAVITY_HOME);
}

/** 单一 Antigravity 数据根目录（优先显式参数 -> 环境变量 -> ~/.gemini/antigravity） */
export function antigravityHome(explicit?: string): string {
  const raw = textOf(explicit) ?? envAntigravityHome() ?? join(homedir(), '.gemini', 'antigravity');
  return expandHome(raw);
}

/**
 * 默认扫描根目录列表：
 * - 传入 explicit 或设置了环境变量时，仅返回该单目录
 * - 否则合并扫描 ~/.gemini/antigravity（App/IDE，优先）与 ~/.gemini/antigravity-cli（agy CLI）
 */
export function antigravityDefaultHomes(explicit?: string): string[] {
  if (textOf(explicit) !== undefined || envAntigravityHome() !== undefined) {
    return [antigravityHome(explicit)];
  }
  return [
    join(homedir(), '.gemini', 'antigravity'),
    join(homedir(), '.gemini', 'antigravity-cli'),
  ];
}

export function antigravityBrainDir(home: string): string {
  return join(home, 'brain');
}

export function antigravitySummaryDbPath(home: string): string {
  return join(home, 'conversation_summaries.db');
}

export function antigravityAnnotationsDir(home: string): string {
  return join(home, 'annotations');
}

export function antigravityLogsDir(home: string, conversationId: string): string {
  return join(antigravityBrainDir(home), conversationId, '.system_generated', 'logs');
}

export function findAntigravityTranscriptFile(
  home: string,
  conversationId: string,
): { path: string; isCompact: boolean } | undefined {
  const logsDir = antigravityLogsDir(home, conversationId);
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  if (existsSync(fullPath)) {
    try {
      const st = statSync(fullPath);
      if (st.isFile() && st.size > 0) return { path: fullPath, isCompact: false };
    } catch {
      // 忽略损坏文件
    }
  }
  const compactPath = join(logsDir, 'transcript.jsonl');
  if (existsSync(compactPath)) {
    try {
      const st = statSync(compactPath);
      if (st.isFile() && st.size > 0) return { path: compactPath, isCompact: true };
    } catch {
      // 忽略损坏文件
    }
  }
  return undefined;
}

/** 按 homes 顺序扫描 brain/<id>/.system_generated/logs，主目录优先并按 conversationId 去重 */
export function listAntigravityTranscripts(homes: readonly string[]): AntigravityTranscriptFile[] {
  const out: AntigravityTranscriptFile[] = [];
  const seenIds = new Set<string>();

  for (const home of homes) {
    const brain = antigravityBrainDir(home);
    if (!existsSync(brain)) continue;
    let entries: string[];
    try {
      entries = readdirSync(brain);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || seenIds.has(entry)) continue;
      const found = findAntigravityTranscriptFile(home, entry);
      if (found === undefined) continue;
      try {
        const st = statSync(found.path);
        if (!st.isFile() || st.size === 0) continue;
        seenIds.add(entry);
        out.push({
          conversationId: entry,
          home,
          path: found.path,
          isCompact: found.isCompact,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // 忽略竞态删除或无权限目录
      }
    }
  }
  return out;
}

export function inferAntigravityHomeFromPath(
  filePath: string,
): { home: string; conversationId: string; isCompact: boolean } {
  const abs = resolve(filePath);
  const base = basename(abs);
  const isCompact = base === 'transcript.jsonl';
  const logsDir = dirname(abs);
  const sysDir = dirname(logsDir);
  const convDir = dirname(sysDir);
  const brainDir = dirname(convDir);
  if (basename(logsDir) === 'logs' && basename(sysDir) === '.system_generated' && basename(brainDir) === 'brain') {
    return { home: dirname(brainDir), conversationId: basename(convDir), isCompact };
  }
  return {
    home: dirname(abs),
    conversationId: base.replace(/\.jsonl$/u, ''),
    isCompact,
  };
}

export function resolveAntigravitySessionPath(
  input: string,
  explicitHome?: string,
): { path: string; home: string; conversationId: string; isCompact: boolean } {
  const trimmed = input.trim();
  const expanded = expandHome(trimmed);
  if (existsSync(expanded)) {
    const st = statSync(expanded);
    if (st.isFile()) {
      return { path: expanded, ...inferAntigravityHomeFromPath(expanded) };
    }
    if (st.isDirectory()) {
      const candidates = [
        join(expanded, '.system_generated', 'logs', 'transcript_full.jsonl'),
        join(expanded, '.system_generated', 'logs', 'transcript.jsonl'),
        join(expanded, 'transcript_full.jsonl'),
        join(expanded, 'transcript.jsonl'),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return { path: candidate, ...inferAntigravityHomeFromPath(candidate) };
        }
      }
      throw new Error('目录中找不到 Antigravity transcript（.system_generated/logs/transcript_full.jsonl）: ' + expanded);
    }
  }

  const homes = antigravityDefaultHomes(explicitHome);
  for (const home of homes) {
    const found = findAntigravityTranscriptFile(home, trimmed);
    if (found !== undefined) {
      return { path: found.path, home, conversationId: trimmed, isCompact: found.isCompact };
    }
  }

  throw new Error('找不到 Antigravity 会话: ' + input + '（已搜索 ' + homes.join(', ') + '）');
}

export function parseAntigravityDbTime(raw: unknown): string | undefined {
  const text = textOf(raw);
  if (text === undefined) return undefined;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?$/u);
  if (match === null) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > Date.UTC(2000, 0, 1) ? new Date(parsed).toISOString() : undefined;
  }
  const isoCandidate = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] ?? 'Z'}`;
  const parsed = Date.parse(isoCandidate);
  return Number.isFinite(parsed) && parsed > Date.UTC(2000, 0, 1) ? new Date(parsed).toISOString() : undefined;
}

export function workspaceUriToPath(rawUris: unknown): string | undefined {
  let uris: unknown;
  if (Array.isArray(rawUris)) {
    uris = rawUris;
  } else if (typeof rawUris === 'string' && rawUris.trim().startsWith('[')) {
    try {
      uris = JSON.parse(rawUris);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(uris)) return undefined;
  for (const entry of uris) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (entry.startsWith('file://')) {
      try {
        return fileURLToPath(entry);
      } catch {
        continue;
      }
    }
    if (isAbsolute(entry)) return entry;
  }
  return undefined;
}

export function readAntigravitySummaries(home: string): Map<string, AntigravitySummaryRow> {
  const out = new Map<string, AntigravitySummaryRow>();
  const dbPath = antigravitySummaryDbPath(home);
  if (!existsSync(dbPath)) return out;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const archivedIds = new Set<string>();
    try {
      const archivedRows = db
        .prepare('SELECT DISTINCT conversation_id FROM conversations_fts WHERE archived = 1')
        .all() as Array<{ conversation_id?: unknown }>;
      for (const row of archivedRows) {
        if (typeof row.conversation_id === 'string' && row.conversation_id.length > 0) {
          archivedIds.add(row.conversation_id);
        }
      }
    } catch {
      // 旧库或无 FTS 表时忽略 archived 查询
    }

    const rows = db
      .prepare(
        'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, ' +
          'parent_conversation_id, agent_name, nesting_depth, project_id, last_user_input_time ' +
          'FROM conversation_summaries',
      )
      .all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const conversationId = textOf(row.conversation_id);
      if (conversationId === undefined) continue;
      const depth = typeof row.nesting_depth === 'number' && Number.isFinite(row.nesting_depth) ? row.nesting_depth : undefined;
      const stepCount = typeof row.step_count === 'number' && Number.isFinite(row.step_count) ? row.step_count : undefined;
      out.set(conversationId, {
        conversationId,
        ...(textOf(row.title) !== undefined ? { title: textOf(row.title) } : {}),
        ...(textOf(row.preview) !== undefined ? { preview: textOf(row.preview) } : {}),
        ...(workspaceUriToPath(row.workspace_uris) !== undefined ? { cwd: workspaceUriToPath(row.workspace_uris) } : {}),
        ...(parseAntigravityDbTime(row.last_modified_time) !== undefined
          ? { updatedAt: parseAntigravityDbTime(row.last_modified_time) }
          : {}),
        ...(parseAntigravityDbTime(row.last_user_input_time) !== undefined
          ? { lastUserInputAt: parseAntigravityDbTime(row.last_user_input_time) }
          : {}),
        ...(textOf(row.parent_conversation_id) !== undefined ? { parentConversationId: textOf(row.parent_conversation_id) } : {}),
        ...(textOf(row.agent_name) !== undefined ? { agentName: textOf(row.agent_name) } : {}),
        ...(depth !== undefined ? { nestingDepth: depth } : {}),
        ...(textOf(row.project_id) !== undefined ? { projectId: textOf(row.project_id) } : {}),
        ...(stepCount !== undefined ? { stepCount } : {}),
        archived: archivedIds.has(conversationId),
      });
    }
  } catch {
    return out;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
  return out;
}

/** 按 cwd 匹配 conversation_summaries.db 中最近一次记录的 project_id */
export function lookupAntigravityProjectId(home: string, cwd: string | undefined): string | undefined {
  const targetCwd = textOf(cwd);
  if (targetCwd === undefined) return undefined;
  const normalizedTarget = resolve(targetCwd);
  const candidates = [...readAntigravitySummaries(home).values()]
    .filter((row) => row.cwd !== undefined && row.projectId !== undefined && resolve(row.cwd) === normalizedTarget)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return candidates[0]?.projectId;
}

function unescapePbtxtString(raw: string): string {
  return raw
    .replace(/\\n/gu, '\n')
    .replace(/\\t/gu, '\t')
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, '\\');
}

export function readAntigravityAnnotation(home: string, conversationId: string): AntigravityAnnotation | undefined {
  const filePath = join(antigravityAnnotationsDir(home), conversationId + '.pbtxt');
  if (!existsSync(filePath)) return undefined;
  try {
    const body = readFileSync(filePath, 'utf8');
    const titleMatch = body.match(/\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/u);
    const archivedMatch = body.match(/\barchived\s*:\s*(true|false)/u);
    const title = titleMatch?.[1] !== undefined ? textOf(unescapePbtxtString(titleMatch[1])) : undefined;
    const archived = archivedMatch?.[1] === 'true' ? true : archivedMatch?.[1] === 'false' ? false : undefined;
    if (title === undefined && archived === undefined) return undefined;
    return {
      ...(title !== undefined ? { title } : {}),
      ...(archived !== undefined ? { archived } : {}),
    };
  } catch {
    return undefined;
  }
}

export function readFileText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

export function parseAntigravityLines(text: string): ParsedAntigravityLines {
  const lines: AntigravityStepLine[] = [];
  let totalLines = 0;
  let badLines = 0;
  let hasTruncatedFields = false;

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    totalLines += 1;
    try {
      const parsed = JSON.parse(trimmed) as AntigravityStepLine;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.truncated_fields) && parsed.truncated_fields.length > 0) {
          hasTruncatedFields = true;
        }
        lines.push(parsed);
      } else {
        badLines += 1;
      }
    } catch {
      badLines += 1;
    }
  }

  return { lines, totalLines, badLines, hasTruncatedFields };
}

/**
 * 提取 Antigravity USER_INPUT 的用户文本：
 * - 正常交互输入带有 `<USER_REQUEST>...</USER_REQUEST>` 与附加元数据，提取核心请求文本
 * - 上下文压缩唤醒携带 `<CONTEXT_SUMMARY>...</CONTEXT_SUMMARY>`，标为 synthetic
 * - 无包裹标签的自动触发 prompt 仅剥离 `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` 等系统附注
 */
export function extractUserRequestText(raw: string): { text: string; synthetic: boolean } {
  const userReq = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u);
  if (userReq !== null) {
    return { text: (userReq[1] ?? '').trim(), synthetic: false };
  }

  const contextSummary = raw.match(/<CONTEXT_SUMMARY>\s*([\s\S]*?)\s*<\/CONTEXT_SUMMARY>/u);
  if (contextSummary !== null) {
    return { text: (contextSummary[1] ?? '').trim(), synthetic: true };
  }

  const stripped = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gu, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gu, '')
    .replace(/<PLAN>[\s\S]*?<\/PLAN>/gu, '')
    .replace(/<SKILL>[\s\S]*?<\/SKILL>/gu, '')
    .replace(/<TEAMWORK>[\s\S]*?<\/TEAMWORK>/gu, '')
    .trim();

  return { text: stripped, synthetic: false };
}

/** 剥离 Antigravity GENERIC 工具结果开头重复的 Created At / Completed At 头行 */
export function cleanGenericOutput(raw: string): string {
  const rows = raw.replace(/\r\n/gu, '\n').split('\n');
  let i = 0;
  while (i < rows.length && /^(?:Created At|Completed At):\s+/u.test(rows[i] ?? '')) {
    i += 1;
  }
  return rows.slice(i).join('\n').trim();
}

function readHeadChunk(filePath: string, bytes = 65536): string {
  const fd = openSync(filePath, 'r');
  try {
    const size = Math.min(bytes, fstatSync(fd).size);
    const buffer = Buffer.allocUnsafe(size);
    const readBytes = readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8', 0, readBytes);
  } finally {
    closeSync(fd);
  }
}

export function readAntigravityHeadMetadata(filePath: string): AntigravityHeadMetadata {
  let createdAt: string | undefined;
  let firstUserText: string | undefined;
  try {
    const chunk = readHeadChunk(filePath);
    const lines = chunk.split('\n');
    // 截断块最后一行可能不完整，跳过最后一行（除非文件本身 <= 64KB 已完整读完）
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      let parsed: AntigravityStepLine;
      try {
        parsed = JSON.parse(trimmed) as AntigravityStepLine;
      } catch {
        continue;
      }
      if (createdAt === undefined && typeof parsed.created_at === 'string') {
        const ms = Date.parse(parsed.created_at);
        if (Number.isFinite(ms)) createdAt = new Date(ms).toISOString();
      }
      if (firstUserText === undefined && parsed.type === 'USER_INPUT' && typeof parsed.content === 'string') {
        const extracted = extractUserRequestText(parsed.content);
        if (!extracted.synthetic && extracted.text.length > 0) {
          firstUserText = clip(extracted.text, 80);
        }
      }
      if (createdAt !== undefined && firstUserText !== undefined) break;
    }
  } catch {
    // 忽略读取异常
  }
  return { createdAt, firstUserText };
}
