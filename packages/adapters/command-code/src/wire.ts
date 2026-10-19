/*
 * Command Code 会话格式（v3）+ 路径规则。
 *
 * 事实来源（本机 Command Code 1.82.3，2026-10-19）：
 * - 真实数据：~/.commandcode/projects/<slug>/<uuid>.jsonl 共 23 个会话、1888 行；
 *   另含 .meta.json / .checkpoints.jsonl / ~/.commandcode/history.jsonl。
 * - CLI 源码：dist/cli.mjs 里的 createSessionStoreV3 / isSessionEntryV3 /
 *   getProjectSessionDir / appendMessage（字段名、校验规则、写入顺序均从源码核对）。
 *
 * 行格式（每行一个 JSON 对象）：
 *   首行 session 头：{type:session, version:3, id, timestamp, cwd, parentSession?}
 *   其后为 entry：  {type, id, parentId, timestamp, ...}，type 见 SESSION_ENTRY_TYPES
 *   - message：{message:{role:user|assistant, content:block[], meta?}, usage?, model?, effort?}
 *               （usage/model/effort 只在 assistant 行上出现）
 *   - compaction：{summary, firstKeptEntryId, tokensBefore, stripThinkingFromKept?, fromMod?}
 * 消息内 content block 实测只出现四类：text / thinking / tool_use / tool_result；
 * 源码另外支持 image（toV2/fromV2 里有）。tool_result 的 content 是 block 数组。
 *
 * 关键实测结论（.spikes/cc-verify 的变体探针）：
 * - message.meta.messageId 不影响加载，但缺了它，resume 时 CLI 会把旧消息重复 append
 *   回同一个文件（createSessionRecorder 用 messageId 去重），所以写端必须给每条消息发 messageId。
 * - message.meta.source 取值 user|model|tool（真实样本），createdAt 是 epoch 毫秒。
 * - 不写 .meta.json / .checkpoints.jsonl 也能 resume；它们只服务历史列表、/rewind 等 UI。
 */

export const SESSION_FORMAT_VERSION = 3;
export const COMMANDCODE_DIR = '.commandcode';

/** CLI 源码 SESSION_ENTRY_TYPES 原样抄录 */
export const SESSION_ENTRY_TYPES = new Set([
  'message',
  'model_change',
  'effort_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
]);

// ---------------------------------------------------------------------------
// 内容 block
// ---------------------------------------------------------------------------

export interface CcTextBlock {
  type: 'text';
  text: string;
}

export interface CcThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** 真实样本里 signature 恒为空字符串；源码 fromV2 也写空串 */
  signature?: string;
}

export interface CcToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

export interface CcToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /** 实测为 [{type:text, text}]；源码 normalizeToolResultContent 也接受其它 block */
  content?: CcBlock[] | string;
  is_error?: boolean;
}

export interface CcImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type CcBlock = CcTextBlock | CcThinkingBlock | CcToolUseBlock | CcToolResultBlock | CcImageBlock;

export interface CcMessageMeta {
  messageId?: string;
  /** epoch 毫秒 */
  createdAt?: number;
  source?: string;
  isMeta?: boolean;
  isSummary?: boolean;
  summaryEntryId?: string;
  injected?: unknown;
  hookContexts?: unknown;
  [key: string]: unknown;
}

export interface CcMessage {
  role: 'user' | 'assistant';
  content: CcBlock[];
  meta?: CcMessageMeta;
}

export interface CcEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface CcMessageEntry extends CcEntryBase {
  type: 'message';
  message: CcMessage;
  usage?: Record<string, unknown>;
  model?: string;
  effort?: string;
}

export interface CcCompactionEntry extends CcEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  stripThinkingFromKept?: boolean;
  fromMod?: boolean;
}

export interface CcBranchSummaryEntry extends CcEntryBase {
  type: 'branch_summary';
  summary: string;
}

export interface CcModelChangeEntry extends CcEntryBase {
  type: 'model_change';
  model: string;
}

export interface CcEffortChangeEntry extends CcEntryBase {
  type: 'effort_change';
  effort: string;
}

export interface CcSessionInfoEntry extends CcEntryBase {
  type: 'session_info';
  name?: string;
}

export interface CcLabelEntry extends CcEntryBase {
  type: 'label';
  targetId: string;
  label?: string;
}

export interface CcCustomEntry extends CcEntryBase {
  type: 'custom';
  customType: string;
  data?: unknown;
}

export interface CcCustomMessageEntry extends CcEntryBase {
  type: 'custom_message';
  customType: string;
  content: string | CcBlock[];
  display: boolean;
  details?: unknown;
}

export type CcEntry =
  | CcMessageEntry
  | CcCompactionEntry
  | CcBranchSummaryEntry
  | CcModelChangeEntry
  | CcEffortChangeEntry
  | CcSessionInfoEntry
  | CcLabelEntry
  | CcCustomEntry
  | CcCustomMessageEntry;

export interface CcSessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  /** fork / clone 出来的会话会把父 transcript 路径记在这里 */
  parentSession?: string;
  [key: string]: unknown;
}

/** <uuid>.meta.json 的宽松类型（真实样本字段 + 源码写入字段） */
export interface CcMetaFile {
  entrypoint?: string;
  title?: string;
  traceIds?: string[];
  model?: string;
  gitBranch?: string;
  parentSessionId?: string;
  forkedAt?: string;
  compaction?: {
    count?: number;
    tokensSaved?: number;
    lastTokensSaved?: number;
    lastCompactedAt?: string;
  };
  [key: string]: unknown;
}

export interface CcCheckpoint {
  id?: string;
  messageId?: string;
  turnNumber?: number;
  createdAt?: string;
  prompt?: string;
  messageCount?: number;
  lastMessageId?: string;
  files?: unknown[];
  [key: string]: unknown;
}
// ---------------------------------------------------------------------------
// 校验（与 CLI 源码 isSessionHeaderV3 / isSessionEntryV3 等价）
// ---------------------------------------------------------------------------

export function isCcHeader(value: unknown): value is CcSessionHeader {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'session' &&
    record.version === SESSION_FORMAT_VERSION &&
    typeof record.id === 'string' &&
    typeof record.timestamp === 'string' &&
    typeof record.cwd === 'string'
  );
}

export function isCcEntry(value: unknown): value is CcEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === 'string' &&
    SESSION_ENTRY_TYPES.has(record.type) &&
    typeof record.id === 'string' &&
    (record.parentId === null || typeof record.parentId === 'string') &&
    typeof record.timestamp === 'string'
  );
}

export interface ParsedJsonl {
  lines: string[];
  records: unknown[];
  /** 无法 JSON.parse 或不是对象 */
  badLines: number;
}

/** 宽松解析：坏行计数，不抛错（CLI 自己也是这么干的，坏行按 corrupted 丢弃） */
export function parseJsonl(text: string): ParsedJsonl {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const records: unknown[] = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) records.push(value);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, records, badLines };
}

// ---------------------------------------------------------------------------
// 项目目录 slug（CLI 源码：getProjectDirName = slugify(cwd)，@sindresorhus/slugify 2.2.1 默认参数）
// ---------------------------------------------------------------------------

/** @sindresorhus/slugify 的默认 overridable-replacements */
const OVERRIDABLE_REPLACEMENTS: Array<[string, string]> = [
  ['&', ' and '],
  ['🦄', ' unicorn '],
  ['♥', ' love '],
];

/**
 * 常用 Latin 特殊字符（NFD 拆不出来的那些）。完整 transliterate 表有 2000+ 条（含西里尔/
 * 希腊等），这里只覆盖路径里现实会出现的 Latin 字母；其它非 ASCII 会退化成分隔符。
 */
const LATIN_SPECIALS: Array<[string, string]> = [
  ['ß', 'ss'],
  ['ẞ', 'SS'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['ł', 'l'],
  ['Ł', 'L'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['þ', 'th'],
  ['Þ', 'TH'],
  ['ı', 'i'],
  ['ħ', 'h'],
  ['ŋ', 'n'],
];

function transliterateLite(input: string): string {
  let string = input.normalize();
  for (const [key, value] of OVERRIDABLE_REPLACEMENTS) string = string.split(key).join(value);
  for (const [key, value] of LATIN_SPECIALS) string = string.split(key).join(value);
  string = string.normalize('NFD').replace(/\p{Diacritic}/gu, '').normalize();
  return string;
}

/** @sindresorhus/slugify 内部的 decamelize（逐字照抄） */
function decamelize(string: string): string {
  return string
    .replace(/([A-Z]{2,})(\d+)/g, '$1 $2')
    .replace(/([a-z\d]+)([A-Z]{2,})/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-rt-z\d]+)/g, '$1 $2');
}

/**
 * Command Code 项目目录名规则：cwd 经过 @sindresorhus/slugify 默认参数（separator '-'、
 * lowercase、decamelize）。实测校验：本机 7 个有 transcript 的项目目录全部吻合，例如
 * /Users/x/GitHub/N.E.K.O.Verse -> users-x-git-hub-n-e-k-o-verse。
 */
export function commandCodeProjectSlug(cwd: string): string {
  let string = transliterateLite(cwd);
  // 与 slugify 内部顺序一致：transliterate -> decamelize -> lowercase
  string = decamelize(string).toLowerCase();
  // possessive / contraction 清理
  string = string.replace(/([a-zA-Z\d]+)'([ts])(\s|$)/g, '$1$2$3');
  // 非 [a-z0-9] 全部折叠成 separator
  string = string.replace(/[^a-z\d]+/g, '-');
  // slugify 还会删掉反斜杠（Windows 路径分隔符已在上一行变成 '-'，这里保持一致）
  string = string.replace(/\\/g, '');
  string = string.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return string || 'root';
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function commandCodeHome(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return (process.env.HOME ?? process.env.USERPROFILE ?? '') + '/' + COMMANDCODE_DIR;
}

export function commandCodeProjectsDir(home: string): string {
  return home + '/projects';
}

/** 目标项目目录（<home>/projects/<slug(cwd)>） */
export function commandCodeProjectDir(home: string, cwd: string): string {
  return commandCodeProjectsDir(home) + '/' + commandCodeProjectSlug(cwd);
}

export interface CcSessionPaths {
  jsonl: string;
  meta: string;
  checkpoints: string;
  prompts: string;
  share: string;
  scheduledTasks: string;
}

/** CLI 源码 sessionPaths()：所有 sidecar 都是 <dir>/<id>.<suffix> */
export function ccSessionPaths(baseDir: string, id: string): CcSessionPaths {
  const stem = baseDir + '/' + id;
  return {
    jsonl: stem + '.jsonl',
    meta: stem + '.meta.json',
    checkpoints: stem + '.checkpoints.jsonl',
    prompts: stem + '.prompts.jsonl',
    share: stem + '.share.json',
    scheduledTasks: stem + '.scheduled-tasks.json',
  };
}

export function isCcTranscriptFileName(name: string): boolean {
  return (
    name.endsWith('.jsonl') &&
    !name.includes('.checkpoints.') &&
    !name.includes('.prompts.') &&
    !name.includes('.v2.bak')
  );
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 8 位 hex entry id（CLI 源码 generateEntryId 的形状） */
export function newEntryId(used?: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    if (!used || !used.has(id)) return id;
  }
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/** ISO 8601 -> epoch 毫秒（非法返回 undefined） */
export function isoToMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 规范化成 CLI 自己写的 toISOString 形式；非法返回 undefined */
export function normalizeIso(value: unknown): string | undefined {
  const ms = isoToMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
