/**
 * Codex CLI 0.163+ 的 rollout JSONL / JSONL.ZST 类型与解析。
 *
 * 事实来源：本机真实会话 rollout（0.162 写入、0.163~0.171 读取），每行 {timestamp, type, payload}。
 * 注意：
 * - Codex 新版本会把旧 rollout 压缩成 .jsonl.zst，并将长会话拆分为 rollout-<ts>-<threadId>_<segId>.jsonl(.zst)（带 ordinal）；
 * - archived_sessions/ 与 state_5.sqlite 的 threads/thread_spawn_edges 存有归档与子代理关联；
 * - response_item 是模型层（message / reasoning / function_call / function_call_output），
 * - event_msg 是 UI 层镜像，reader 以 response_item 为准，event_msg 只计数跳过（否则内容会翻倍）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';

export interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** paginated rollout 的递增序号 */
  ordinal?: number;
}

export interface CodexSessionMeta {
  session_id?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  runtime_workspace_roots?: string[];
  originator?: string;
  cli_version?: string;
  source?: string | Record<string, unknown>;
  thread_source?: string;
  model_provider?: string;
  base_instructions?: unknown;
  history_mode?: string;
  context_window?: number;
  git?: { branch?: string; sha?: string; origin_url?: string };
}

export interface CodexStateThreadRow {
  id: string;
  rolloutPath?: string;
  createdAt?: number;
  createdAtMs?: number;
  updatedAt?: number;
  updatedAtMs?: number;
  source?: string;
  threadSource?: string;
  cwd?: string;
  title?: string;
  name?: string;
  archived?: boolean;
  originator?: string;
  agentNickname?: string;
  agentPath?: string;
  spawnParentThreadId?: string;
}

export interface CodexThreadClassification {
  isSubagent: boolean;
  isGuardian: boolean;
  parentThreadId?: string;
  agentLabel?: string;
}

export interface CodexContentBlock {
  type?: string;
  text?: string;
}

export const CODEX_DIR = '.codex';

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

/** 解压单帧或多帧拼接的 Zstandard 缓冲区（Node zstdDecompressSync 默认只解第一帧） */
export function decompressZstd(buffer: Buffer): Buffer {
  if (buffer.length === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    const magic = buffer.readUInt32LE(offset);
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (buffer.length - offset < 8) break;
      const size = buffer.readUInt32LE(offset + 4);
      if (buffer.length - offset - 8 < size) break;
      offset += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error('Codex Zstandard rollout 损坏: 非法帧魔数 offset=' + String(offset));
    }
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error('Codex Zstandard rollout 损坏: 帧头保留位非零 offset=' + String(offset - 1));
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let torn = false;
    for (;;) {
      if (buffer.length - offset < 3) {
        torn = true;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error('Codex Zstandard rollout 损坏: 非法 block 类型 offset=' + String(offset - 3));
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        torn = true;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (torn) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    chunks.push(zstdDecompressSync(buffer.subarray(start, offset)));
  }
  if (chunks.length === 0) return zstdDecompressSync(buffer);
  return Buffer.concat(chunks);
}

export function codexHome(explicit?: string): string {
  if (explicit) return explicit.startsWith('~/') ? join(homedir(), explicit.slice(2)) : explicit;
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.codex');
}

export function sessionsRoot(home: string): string {
  return join(home, 'sessions');
}

export function archivedSessionsRoot(home: string): string {
  return join(home, 'archived_sessions');
}

export function threadIndexPath(home: string): string {
  return join(home, 'session_index.jsonl');
}

export function isRolloutFilename(name: string): boolean {
  return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'));
}

/** 递归找 sessions/ 与 archived_sessions/ 下所有 rollout 文件（含 .jsonl / .jsonl.zst，按 mtime 降序） */
export function listRolloutFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && isRolloutFilename(name)) out.push(full);
    }
  };
  for (const root of [sessionsRoot(home), archivedSessionsRoot(home)]) {
    if (existsSync(root)) walk(root);
  }
  return out.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

const ROLLOUT_UUID_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl(?:\.zst)?$/i;
const FALLBACK_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/** rollout 文件名里的主会话 id（兼容 <uuid>.jsonl(.zst) 与分页分段 <threadUuid>_<segUuid>.jsonl(.zst)） */
export function sessionIdFromRolloutPath(filePath: string): string | undefined {
  const name = basename(filePath);
  return ROLLOUT_UUID_RE.exec(name)?.[1] ?? FALLBACK_UUID_RE.exec(name)?.[1];
}

export function isPaginatedSegmentPath(filePath: string): boolean {
  const match = ROLLOUT_UUID_RE.exec(basename(filePath));
  return match?.[2] !== undefined;
}

/** 从 rollout-YYYY-MM-DDTHH-mm-ss-... 文件名解析本地时间戳（毫秒） */
export function rolloutTimestampFromPath(filePath: string): number | undefined {
  const match = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(basename(filePath));
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) {
    return undefined;
  }
  const ms = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseRollout(text: string): { lines: CodexLine[]; badLines: number } {
  const lines: CodexLine[] = [];
  let badLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object') lines.push(value as CodexLine);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines };
}

export function readRolloutText(filePath: string): string {
  const buffer = readFileSync(filePath);
  return filePath.endsWith('.zst') ? decompressZstd(buffer).toString('utf8') : buffer.toString('utf8');
}

export function readRollout(filePath: string): { lines: CodexLine[]; badLines: number } {
  return parseRollout(readRolloutText(filePath));
}

export async function readRolloutHead(filePath: string, maxBytes = 128 * 1024): Promise<string> {
  if (filePath.endsWith('.zst')) {
    const buf = await readFile(filePath);
    return decompressZstd(buf).toString('utf8');
  }
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const len = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buffer, 0, len, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  const rec = asRecord(value);
  if (rec !== undefined) return rec;
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** 只读读取 state_5.sqlite 的 threads 与 thread_spawn_edges（缺失或结构不兼容时安全降级为空） */
export function readStateThreads(home: string): Map<string, CodexStateThreadRow> {
  const result = new Map<string, CodexStateThreadRow>();
  const dbPath = join(home, 'state_5.sqlite');
  if (!existsSync(dbPath)) return result;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const colsRaw = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>;
    const cols = new Set(colsRaw.map((row) => String(row.name ?? '')));
    if (!cols.has('id')) return result;

    const wanted = [
      'id',
      'rollout_path',
      'created_at',
      'created_at_ms',
      'updated_at',
      'updated_at_ms',
      'source',
      'thread_source',
      'cwd',
      'title',
      'name',
      'archived',
      'originator',
      'agent_nickname',
      'agent_path',
    ].filter((col) => cols.has(col));

    const rows = db.prepare('SELECT ' + wanted.join(', ') + ' FROM threads').all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = nonEmptyText(row.id);
      if (id === undefined) continue;
      result.set(id, {
        id,
        rolloutPath: nonEmptyText(row.rollout_path),
        createdAt: finiteNumber(row.created_at),
        createdAtMs: finiteNumber(row.created_at_ms),
        updatedAt: finiteNumber(row.updated_at),
        updatedAtMs: finiteNumber(row.updated_at_ms),
        source: nonEmptyText(row.source),
        threadSource: nonEmptyText(row.thread_source),
        cwd: nonEmptyText(row.cwd),
        title: nonEmptyText(row.title),
        name: nonEmptyText(row.name),
        archived: row.archived === 1 || row.archived === true,
        originator: nonEmptyText(row.originator),
        agentNickname: nonEmptyText(row.agent_nickname),
        agentPath: nonEmptyText(row.agent_path),
      });
    }

    const edgeTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'").get();
    if (edgeTable !== undefined) {
      const edges = db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all() as Array<Record<string, unknown>>;
      for (const edge of edges) {
        const parentId = nonEmptyText(edge.parent_thread_id);
        const childId = nonEmptyText(edge.child_thread_id);
        if (parentId === undefined || childId === undefined) continue;
        const existing = result.get(childId);
        if (existing !== undefined) {
          existing.spawnParentThreadId = parentId;
        } else {
          result.set(childId, { id: childId, spawnParentThreadId: parentId });
        }
      }
    }
  } catch {
    // state_5.sqlite 被占用或版本不一致时忽略，回落纯文件扫描
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return result;
}

/** 识别 Codex 线程属于用户主线程、spawn 子代理，还是 Guardian 后台审查 */
export function classifyCodexThread(meta: CodexSessionMeta | undefined, stateRow?: CodexStateThreadRow): CodexThreadClassification {
  const threadSource = nonEmptyText(meta?.thread_source) ?? stateRow?.threadSource;
  const sourceObj = parseMaybeJsonObject(meta?.source) ?? parseMaybeJsonObject(stateRow?.source);
  const sub = asRecord(sourceObj?.subagent);
  const other = nonEmptyText(sub?.other);
  const threadSpawn = asRecord(sub?.thread_spawn);
  const parentThreadId = nonEmptyText(threadSpawn?.parent_thread_id) ?? stateRow?.spawnParentThreadId;
  const isGuardian = threadSource === 'guardian_review' || other === 'guardian';
  const isSubagent =
    threadSource === 'subagent' ||
    threadSpawn !== undefined ||
    parentThreadId !== undefined ||
    (sub !== undefined && !isGuardian);
  const agentLabel =
    stateRow?.agentNickname ??
    nonEmptyText(threadSpawn?.agent_nickname) ??
    stateRow?.agentPath ??
    nonEmptyText(threadSpawn?.agent_path) ??
    (isGuardian ? 'guardian' : undefined);
  return {
    isSubagent,
    isGuardian,
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
    ...(agentLabel !== undefined ? { agentLabel } : {}),
  };
}

/** session_index.jsonl：{id, thread_name, updated_at} */
export interface CodexIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

export function readSessionIndex(home: string): CodexIndexEntry[] {
  const path = threadIndexPath(home);
  if (!existsSync(path)) return [];
  const out: CodexIndexEntry[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as CodexIndexEntry;
      if (value && typeof value.id === 'string') out.push(value);
    } catch {
      // 索引行坏了就跳过
    }
  }
  return out;
}
/** rollout 文件名里的本地时间：2026-10-16T14-40-28 */
export function rolloutTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
}

/** sessions/YYYY/MM/DD/rollout-<local ts>-<sessionId>.jsonl */
export function codexRolloutPath(home: string, sessionId: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const dateDir = join(sessionsRoot(home), String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  return join(dateDir, 'rollout-' + rolloutTimestamp(at) + '-' + sessionId + '.jsonl');
}

const INJECTED_USER_PREFIXES = ['<environment_context>', '<skills_instructions>', '<user_instructions>'];
/**
 * Codex 会把 AGENTS.md / 环境上下文伪装成 user 消息注入：
 * - 0.163: `# AGENTS.md instructions for <dir>`
 * - 0.169+: `# AGENTS.md instructions\n\n<INSTRUCTIONS>...`（list 折叠空白后为 `# AGENTS.md instructions <INSTRUCTIONS>`）
 */
const AGENTS_MD_INJECTED_RE = /^# AGENTS\.md instructions(?:\s+for\s+|\s*\n|\s+<INSTRUCTIONS>)/;

export function isCodexInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  if (AGENTS_MD_INJECTED_RE.test(trimmed)) return true;
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}