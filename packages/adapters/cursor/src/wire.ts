/**
 * Cursor 的 SQLite 线格式：表结构、key 规则、JSON 解析与文本工具。
 *
 * 实测来源（Cursor 3.25.9 本机数据 + /Applications/Cursor.app 内未压缩 JS）：
 * - globalStorage/state.vscdb 里有 ItemTable / cursorDiskKV / composerHeaders 三张表
 * - chat 列表：composerHeaders 表（value 是 head JSON），canonical 开关是
 *   cursorDiskKV['composer.composerHeaders.migratedToTable'] === '1'
 * - 会话内容：cursorDiskKV['composerData:<composerId>']（单条 JSON）
 * - 每条消息：cursorDiskKV['bubbleId:<composerId>:<bubbleId>']（单条 JSON）
 * - 应用里 composerData._v=18、bubble._v=3 为当前版本，旧数据会被 app 迁移
 *
 * 本文件不依赖 @sessionport/core，方便测试单独使用。
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CURSOR_AGENT = 'cursor';

export const HEADER_TABLE = 'composerHeaders';
export const LEGACY_HEADER_BLOB_KEY = 'composer.composerHeaders';
export const HEADER_MIGRATED_FLAG_KEY = 'composer.composerHeaders.migratedToTable';
export const HEADER_SENTINEL_KEY = 'composer.composerHeaders.version';
export const COMPOSER_DATA_PREFIX = 'composerData:';
export const BUBBLE_KEY_PREFIX = 'bubbleId';
export const COMPOSER_VERSION = 18;
export const BUBBLE_VERSION = 3;

/** app 里 lo.THINKING / ztt.AGENT / qr.HUMAN|AI 的实测数值 */
export const BUBBLE_TYPE_HUMAN = 1;
export const BUBBLE_TYPE_AI = 2;
export const CAPABILITY_THINKING = 30;
export const UNIFIED_MODE_AGENT = 2;

export interface CursorWorkspaceIdentifierLike {
  id?: string;
  uri?: unknown;
  [key: string]: unknown;
}

export interface CursorSubagentInfo {
  parentComposerId?: string;
  subagentTypeName?: string;
  subagentType?: number;
  toolCallId?: string;
  [key: string]: unknown;
}

export interface CursorImageRef {
  uuid?: string;
  dimension?: { width?: number; height?: number };
  [key: string]: unknown;
}

export interface CursorThinking {
  text?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface CursorToolFormerData {
  toolCallId?: string;
  toolIndex?: number;
  modelCallId?: string;
  name?: string;
  rawArgs?: string;
  params?: string;
  result?: unknown;
  status?: string;
  tool?: number;
  /** ToolResultError 的 protobuf JSON（clientVisibleErrorMessage/modelVisibleErrorMessage） */
  error?: unknown;
  /** 工具特有的附加数据（shell 状态、grep 摘要、edit precomputedDiff 等） */
  additionalData?: Record<string, unknown>;
  /**
   * base64(agent.v1.ToolCall)。真实 Cursor 气泡里都有；app 打开 composer 时会用
   * `ng.fromBinary` 解码它。edit/write 现在会生成（缺了它桌面端只显示纯文本
   * "Edited <file>"，precomputedDiff 不会渲染成 diff 卡片）；其余工具暂不生成。
   */
  toolCallBinary?: string;
  /**
   * sessionport 自己的往返扩展：Cursor 不读取它，但 app 的 JSON 透传会保留。
   * 用来在 IR → Cursor → IR 时保留原始工具名/参数/结果（params/result 是 Cursor 语义化后的形态）。
   */
  _sessionport?: Record<string, unknown>;
  [key: string]: unknown;
}

/** composerHeaders.value（也是 app 里 _Ce() 生成的 head 对象） */
export interface CursorHeaderValue {
  type?: string;
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unfinishedRunAt?: number;
  conversationCheckpointLastUpdatedAt?: number;
  unifiedMode?: string;
  forceMode?: string;
  hasUnreadMessages?: boolean;
  contextUsagePercent?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  subtitle?: string;
  hasBlockingPendingActions?: boolean;
  hasPendingPlan?: boolean;
  isArchived?: boolean;
  isDraft?: boolean;
  isEphemeral?: boolean;
  isWorktree?: boolean;
  isSpec?: boolean;
  isProject?: boolean;
  numSubComposers?: number;
  subagentInfo?: CursorSubagentInfo;
  workspaceIdentifier?: CursorWorkspaceIdentifierLike;
  referencedPlans?: unknown[];
  trackedGitRepos?: unknown[];
  [key: string]: unknown;
}

export interface CursorHeaderRow {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  recency: number | null;
  checkpointAt: number | null;
  subagentTypeName: string | null;
  value: string;
}

export interface CursorHeaderRecord {
  composerId: string;
  row: {
    workspaceId?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    isArchived: boolean;
    isSubagent: boolean;
    recency?: number;
    checkpointAt?: number;
    subagentTypeName?: string;
    value: string;
  };
  header: CursorHeaderValue;
}

export interface CursorModelConfig {
  modelName: string;
  maxMode?: boolean;
  selectedModels?: Array<{ modelId: string; parameters?: Array<{ id: string; value: string }> }>;
  [key: string]: unknown;
}

export interface CursorCapability {
  type: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CursorComposerData {
  _v?: number;
  composerId?: string;
  name?: string;
  text?: string;
  richText?: string;
  status?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  conversationCheckpointLastUpdatedAt?: number;
  unifiedMode?: string;
  forceMode?: string;
  isAgentic?: boolean;
  isDraft?: boolean;
  isEphemeral?: boolean;
  isArchived?: boolean;
  subtitle?: string;
  modelConfig?: CursorModelConfig;
  workspaceIdentifier?: CursorWorkspaceIdentifierLike;
  fullConversationHeadersOnly?: CursorConversationHeaderEntry[];
  conversationMap?: Record<string, unknown>;
  capabilities?: CursorCapability[];
  subComposerIds?: string[];
  subagentComposerIds?: string[];
  subagentInfo?: CursorSubagentInfo;
  todos?: unknown[];
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CursorConversationHeaderEntry {
  bubbleId: string;
  type: number;
  grouping?: Record<string, unknown>;
  createdAt?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  contentHeightHint?: number;
  [key: string]: unknown;
}

export interface CursorBubble {
  _v?: number;
  type?: number;
  bubbleId?: string;
  text?: string;
  richText?: string;
  thinking?: CursorThinking;
  toolFormerData?: CursorToolFormerData;
  interpreterResults?: unknown[];
  images?: CursorImageRef[];
  isSimulatedMsg?: boolean;
  simulatedMsgReason?: number;
  capabilityType?: number;
  createdAt?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// sqlite 打开与表结构
// ---------------------------------------------------------------------------

export const CURSOR_BUSY_TIMEOUT_MS = 5000;

export interface OpenCursorDbOptions {
  readOnly?: boolean;
}

/** 打开 state.vscdb；只读模式绝不写库（WAL 由 sqlite 自己处理） */
export function openCursorDb(dbPath: string, options: OpenCursorDbOptions = {}): DatabaseSync {
  if (!existsSync(dbPath)) throw new Error('Cursor 数据库不存在: ' + dbPath);
  const db =
    options.readOnly === true
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = ' + String(CURSOR_BUSY_TIMEOUT_MS) + ';');
  return db;
}

export function closeCursorDb(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // 已关闭或 app 正在退出时忽略
  }
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * 建缺失的表/索引（只在新库或极老 Cursor 上生效；已存在时不改动任何数据）。
 * 表结构复制自 app 的 storage.js 与 composerHeaderStorageUtils 实测 schema。
 */
export function ensureCursorSchema(db: DatabaseSync): void {
  db.exec(
    [
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);',
      'CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);',
      'CREATE TABLE IF NOT EXISTS composerHeaders (' +
        'composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, ' +
        'isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);',
      'CREATE INDEX IF NOT EXISTS idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency);',
      'CREATE INDEX IF NOT EXISTS idx_composerHeaders_1 ON composerHeaders (recency, composerId);',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// 读基础行
// ---------------------------------------------------------------------------

function textOfRowValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export function readItemValue(db: DatabaseSync, key: string): string | undefined {
  if (!tableExists(db, 'ItemTable')) return undefined;
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value?: unknown } | undefined;
  return textOfRowValue(row?.value);
}

export function readDiskKvValue(db: DatabaseSync, key: string): string | undefined {
  if (!tableExists(db, 'cursorDiskKV')) return undefined;
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as { value?: unknown } | undefined;
  return textOfRowValue(row?.value);
}

export function readDiskKvKeys(db: DatabaseSync, prefix: string): string[] {
  if (!tableExists(db, 'cursorDiskKV')) return [];
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const rows = db
    .prepare('SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key')
    .all(prefix, upper) as Array<{ key?: unknown }>;
  const out: string[] = [];
  for (const row of rows) if (typeof row.key === 'string') out.push(row.key);
  return out;
}

export interface ReadHeaderOptions {
  limit?: number;
  includeSubagents?: boolean;
  workspaceId?: string;
}

const HEADER_COLUMNS =
  'composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, subagentTypeName, value';

function headerRowFromSqlish(row: Record<string, unknown>): CursorHeaderRow | undefined {
  const composerId = typeof row.composerId === 'string' ? row.composerId : undefined;
  if (composerId === undefined || composerId.length === 0) return undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : undefined;
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  return {
    composerId,
    workspaceId: str(row.workspaceId) ?? null,
    createdAt: num(row.createdAt) ?? null,
    lastUpdatedAt: num(row.lastUpdatedAt) ?? null,
    isArchived: num(row.isArchived) ?? null,
    isSubagent: num(row.isSubagent) ?? null,
    recency: num(row.recency) ?? null,
    checkpointAt: num(row.checkpointAt) ?? null,
    subagentTypeName: str(row.subagentTypeName) ?? null,
    value: str(row.value) ?? '',
  };
}

/**
 * 读 composerHeaders 行。
 *
 * 兼容旧版 Cursor：表不存在时回退到 ItemTable['composer.composerHeaders'] 的
 * {allComposers:[...]} 单条 JSON（app 的旧存储格式）。
 */
export function readHeaderRows(db: DatabaseSync, options: ReadHeaderOptions = {}): CursorHeaderRow[] {
  if (tableExists(db, HEADER_TABLE)) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.includeSubagents !== true) where.push('(isSubagent IS NULL OR isSubagent = 0)');
    if (options.workspaceId !== undefined) {
      where.push('workspaceId = ?');
      params.push(options.workspaceId);
    }
    const sql =
      'SELECT ' +
      HEADER_COLUMNS +
      ' FROM ' +
      HEADER_TABLE +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY recency DESC, lastUpdatedAt DESC' +
      (options.limit !== undefined && options.limit > 0 ? ' LIMIT ?' : '');
    if (options.limit !== undefined && options.limit > 0) params.push(Math.floor(options.limit));
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const out: CursorHeaderRow[] = [];
    for (const row of rows) {
      const parsed = headerRowFromSqlish(row);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }
  return readLegacyHeaderRows(db, options);
}

function readLegacyHeaderRows(db: DatabaseSync, options: ReadHeaderOptions): CursorHeaderRow[] {
  const blob = readItemValue(db, LEGACY_HEADER_BLOB_KEY);
  if (blob === undefined || blob.length === 0) return [];
  const parsed = parseJsonRecord(blob);
  const all = parsed?.allComposers;
  if (!Array.isArray(all)) return [];
  const rows: CursorHeaderRow[] = [];
  for (const item of all) {
    if (item === null || typeof item !== 'object') continue;
    const header = item as CursorHeaderValue;
    const composerId = typeof header.composerId === 'string' ? header.composerId : undefined;
    if (composerId === undefined || composerId.length === 0) continue;
    const isSubagent =
      header.subagentInfo?.parentComposerId !== undefined || composerId.startsWith('task-');
    if (options.includeSubagents !== true && isSubagent) continue;
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : null;
    const lastUpdatedAt = typeof header.lastUpdatedAt === 'number' ? header.lastUpdatedAt : null;
    rows.push({
      composerId,
      workspaceId:
        header.workspaceIdentifier !== undefined && typeof header.workspaceIdentifier.id === 'string'
          ? header.workspaceIdentifier.id
          : null,
      createdAt,
      lastUpdatedAt,
      isArchived: header.isArchived === true ? 1 : 0,
      isSubagent: isSubagent ? 1 : 0,
      recency: lastUpdatedAt ?? createdAt,
      checkpointAt:
        typeof header.conversationCheckpointLastUpdatedAt === 'number'
          ? header.conversationCheckpointLastUpdatedAt
          : null,
      subagentTypeName:
        typeof header.subagentInfo?.subagentTypeName === 'string' ? header.subagentInfo.subagentTypeName : null,
      value: JSON.stringify(header),
    });
  }
  rows.sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0));
  return options.limit !== undefined && options.limit > 0 ? rows.slice(0, options.limit) : rows;
}

export function readHeaderRow(db: DatabaseSync, composerId: string): CursorHeaderRow | undefined {
  if (!tableExists(db, HEADER_TABLE)) {
    return readLegacyHeaderRows(db, { includeSubagents: true }).find((row) => row.composerId === composerId);
  }
  const row = db
    .prepare('SELECT ' + HEADER_COLUMNS + ' FROM ' + HEADER_TABLE + ' WHERE composerId = ?')
    .get(composerId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : headerRowFromSqlish(row);
}

export function headerRecordFromRow(row: CursorHeaderRow): CursorHeaderRecord | undefined {
  const header = parseJsonRecord(row.value) as CursorHeaderValue | undefined;
  if (header === undefined) return undefined;
  return {
    composerId: row.composerId,
    row: {
      workspaceId: row.workspaceId ?? undefined,
      createdAt: row.createdAt ?? undefined,
      lastUpdatedAt: row.lastUpdatedAt ?? undefined,
      isArchived: row.isArchived === 1,
      isSubagent: row.isSubagent === 1,
      recency: row.recency ?? undefined,
      checkpointAt: row.checkpointAt ?? undefined,
      subagentTypeName: row.subagentTypeName ?? undefined,
      value: row.value,
    },
    header,
  };
}

export function readComposerDataRaw(db: DatabaseSync, composerId: string): string | undefined {
  return readDiskKvValue(db, composerDataKey(composerId));
}

export function readComposerDataObject(db: DatabaseSync, composerId: string): CursorComposerData | undefined {
  const raw = readComposerDataRaw(db, composerId);
  if (raw === undefined) return undefined;
  return parseJsonRecord(raw) as CursorComposerData | undefined;
}

// ---------------------------------------------------------------------------
// 气泡
// ---------------------------------------------------------------------------

export interface ReadBubblesResult {
  bubbles: Map<string, CursorBubble>;
  /** header 里有、库里没有的 bubbleId */
  missing: string[];
  /** 库里有、JSON 解析失败的 bubbleId */
  bad: string[];
}

export function bubbleKey(composerId: string, bubbleId: string): string {
  return BUBBLE_KEY_PREFIX + ':' + composerId + ':' + bubbleId;
}

export function bubbleKeyPrefix(composerId: string): string {
  return BUBBLE_KEY_PREFIX + ':' + composerId + ':';
}

const BUBBLE_CHUNK = 80;

/** 按给定 bubbleId 批量取（只取需要的气泡，避免扫全表） */
export function readBubbles(db: DatabaseSync, composerId: string, bubbleIds: string[]): ReadBubblesResult {
  const bubbles = new Map<string, CursorBubble>();
  const bad: string[] = [];
  const missing: string[] = [];
  if (!tableExists(db, 'cursorDiskKV')) {
    return { bubbles, missing: [...bubbleIds], bad };
  }
  const unique = [...new Set(bubbleIds)];
  for (let offset = 0; offset < unique.length; offset += BUBBLE_CHUNK) {
    const chunk = unique.slice(offset, offset + BUBBLE_CHUNK);
    const keys = chunk.map((id) => bubbleKey(composerId, id));
    const sql = 'SELECT key, value FROM cursorDiskKV WHERE key IN (' + keys.map(() => '?').join(',') + ')';
    const rows = db.prepare(sql).all(...keys) as Array<{ key?: unknown; value?: unknown }>;
    const byKey = new Map<string, string>();
    for (const row of rows) {
      const key = typeof row.key === 'string' ? row.key : undefined;
      const value = textOfRowValue(row.value);
      if (key !== undefined && value !== undefined) byKey.set(key, value);
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const bubbleId = chunk[index] as string;
      const raw = byKey.get(keys[index] as string);
      if (raw === undefined) {
        missing.push(bubbleId);
        continue;
      }
      const parsed = parseJsonRecord(raw);
      if (parsed === undefined) {
        bad.push(bubbleId);
        continue;
      }
      bubbles.set(bubbleId, parsed as CursorBubble);
    }
  }
  return { bubbles, missing, bad };
}

/** 扫一个 composer 的全部气泡（只读 header 缺失时兜底用） */
export function readAllBubbles(db: DatabaseSync, composerId: string): ReadBubblesResult {
  const result: ReadBubblesResult = { bubbles: new Map(), missing: [], bad: [] };
  const prefix = bubbleKeyPrefix(composerId);
  const entries = readDiskKvEntries(db, prefix);
  for (const [key, raw] of entries) {
    const bubbleId = key.slice(prefix.length);
    const parsed = parseJsonRecord(raw);
    if (parsed === undefined) {
      result.bad.push(bubbleId);
      continue;
    }
    result.bubbles.set(bubbleId, parsed as CursorBubble);
  }
  return result;
}

export function readDiskKvEntries(db: DatabaseSync, prefix: string): Array<[string, string]> {
  if (!tableExists(db, 'cursorDiskKV')) return [];
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const rows = db
    .prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key')
    .all(prefix, upper) as Array<{ key?: unknown; value?: unknown }>;
  const out: Array<[string, string]> = [];
  for (const row of rows) {
    const key = typeof row.key === 'string' ? row.key : undefined;
    const value = textOfRowValue(row.value);
    if (key !== undefined && value !== undefined) out.push([key, value]);
  }
  return out;
}

export function countBubbles(db: DatabaseSync, composerId: string): number {
  const entries = readDiskKvEntries(db, bubbleKeyPrefix(composerId));
  return entries.length;
}

// ---------------------------------------------------------------------------
// key / JSON / 文本工具
// ---------------------------------------------------------------------------

export function composerDataKey(composerId: string): string {
  return COMPOSER_DATA_PREFIX + composerId;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 任意 JSON 值解析（数组也接受）；失败返回 undefined */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function msToIso(ms: number | null | undefined): string | undefined {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : undefined;
}

export function isoToMs(iso: string | number | null | undefined): number | undefined {
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : undefined;
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Cursor 的 user bubble.richText 是 ProseMirror/Tiptap doc 的 JSON 字符串 */
export function richTextToPlainText(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length === 0) return '';
    const parsed = parseJsonValue(raw);
    if (parsed === undefined) return raw;
    value = parsed;
  }
  const parts: string[] = [];
  walkRichText(value, parts);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function walkRichText(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walkRichText(item, out);
    return;
  }
  if (!isRecord(node)) return;
  const type = typeof node.type === 'string' ? node.type : undefined;
  if (type === 'text') {
    if (typeof node.text === 'string') out.push(node.text);
    return;
  }
  if (type === 'hardBreak' || type === 'hard_break') {
    out.push('\n');
    return;
  }
  const children = node.content ?? node.children;
  walkRichText(children, out);
  if (type === 'paragraph' || type === 'heading' || type === 'codeBlock' || type === 'listItem' || type === 'blockquote') {
    out.push('\n');
  }
}

/** 气泡正文：优先 text，其次把 richText 拍平成纯文本 */
export function bubbleText(bubble: CursorBubble): string {
  if (typeof bubble.text === 'string' && bubble.text.length > 0) return bubble.text;
  if (typeof bubble.richText === 'string' && bubble.richText.length > 0) {
    return richTextToPlainText(bubble.richText);
  }
  return '';
}

export function bubbleThinkingText(bubble: CursorBubble): string {
  if (isRecord(bubble.thinking) && typeof bubble.thinking.text === 'string') return bubble.thinking.text;
  return '';
}

/** 把字符串拍成 ProseMirror doc（写 user bubble.richText 用） */
export function plainTextToRichTextDoc(text: string): string {
  const paragraphs = text.split(/\r?\n/).map((line) => {
    if (line.length === 0) return { type: 'paragraph' };
    return { type: 'paragraph', content: [{ type: 'text', text: line }] };
  });
  return JSON.stringify({ type: 'doc', content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }] });
}

export function randomBase64(bytes: number): string {
  return randomBytes(bytes).toString('base64');
}

export function newUuid(): string {
  return randomUUID();
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** composerData.context 的默认空结构（与 app createEmptyComposer 的 Ly() 一致） */
export function emptyComposerContext(): Record<string, unknown> {
  const emptyArray: unknown[] = [];
  return {
    composers: [...emptyArray],
    selectedCommits: [...emptyArray],
    selectedPullRequests: [...emptyArray],
    selectedImages: [...emptyArray],
    selectedDocuments: [...emptyArray],
    selectedVideos: [...emptyArray],
    folderSelections: [...emptyArray],
    fileSelections: [...emptyArray],
    selections: [...emptyArray],
    terminalSelections: [...emptyArray],
    selectedDocs: [...emptyArray],
    externalLinks: [...emptyArray],
    cursorRules: [...emptyArray],
    cursorCommands: [...emptyArray],
    gitPRDiffSelections: [...emptyArray],
    subagentSelections: [...emptyArray],
    browserSelections: [...emptyArray],
    extraContext: [...emptyArray],
    mentions: {
      composers: {},
      selectedCommits: {},
      selectedPullRequests: {},
      gitDiff: [],
      gitDiffFromBranchToMain: [],
      folderSelections: {},
      fileSelections: {},
      terminalFiles: {},
      selections: {},
      terminalSelections: {},
      selectedDocs: {},
      externalLinks: {},
      diffHistory: [],
      cursorRules: {},
      cursorCommands: {},
      uiElementSelections: [],
      consoleLogs: [],
      ideEditorsState: [],
      gitPRDiffSelections: {},
      subagentSelections: {},
      browserSelections: {},
      selectedImages: {},
    },
  };
}

/** 读已安装 Cursor 的版本号（macOS 默认安装路径；探测不到返回 undefined） */
export function detectCursorVersion(userDataDir?: string): string | undefined {
  const candidates: string[] = [];
  if (process.platform === 'darwin') candidates.push('/Applications/Cursor.app/Contents/Resources/app/package.json');
  if (userDataDir !== undefined) {
    candidates.push(join(userDataDir, '..', '..', 'Cursor.app', 'Contents', 'Resources', 'app', 'package.json'));
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = parseJsonRecord(readFileSync(candidate, 'utf8'));
      if (parsed !== undefined && typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    } catch {
      // ignore
    }
  }
  return undefined;
}
