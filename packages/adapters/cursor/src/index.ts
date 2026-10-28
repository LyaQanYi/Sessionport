/**
 * Cursor adapter（@sessionport/adapter-cursor）
 *
 * 读：Cursor app 的 composer（SQLite state.vscdb）→ IR
 * 写：IR → 新 composer（只新增 key，不覆盖任何已有会话）
 *
 * 说明：core 的 AgentId 目前尚无 'cursor'，adapter 内部统一断言为 AgentId；
 * 集成时只需在 core 的 AgentId 联合类型/registry 里加上 'cursor'。
 */
export {
  CURSOR_AGENT_ID,
  listCursorSessions,
  readCursorSession,
  resolveCursorSessionTarget,
} from './read.ts';
export type { CursorSessionSummary, CursorSessionTarget, ReadCursorOptions } from './read.ts';

export {
  CURSOR_CAPS,
  buildCursorComposerData,
  buildCursorHeaderValue,
  assistantGrouping,
  printWriteReport,
  thinkingGrouping,
  toolGrouping,
  userGrouping,
  writeCursorSession,
} from './write.ts';
export type { BuildComposerInput, WriteCursorOptions, WriteCursorResult, WriteCursorRow } from './write.ts';

export {
  appSmokeCursor,
  countCursorTarget,
  cursorDisplayName,
  cursorHeadlessCapabilities,
  readCursorAgentScanLog,
  verifyCursorSession,
} from './verify.ts';
export type {
  CursorAgentScanLog,
  CursorAppSmokeOptions,
  CursorAppSmokeResult,
  CursorHeadlessCapabilities,
  CursorReadbackSummary,
  VerifyCheck,
  VerifyCursorOptions,
  VerifyCursorReport,
} from './verify.ts';

export {
  isCursorPrecomputedDiff,
  parseUnifiedDiff,
  precomputedDiffToUnifiedDiff,
  validateCursorPrecomputedDiff,
} from './diff.ts';
export type { CursorDiffLine, CursorDiffLineType, CursorPrecomputedDiff } from './diff.ts';

export {
  CAPABILITY_TOOL_FORMER,
  CURSOR_TOOL,
  CURSOR_TOOL_STATUSES,
  buildCursorToolFormerData,
  cursorToolName,
  irContentText,
  isCursorToolStatus,
  resolveCursorTool,
} from './toolformer.ts';
export type {
  BuildToolFormerResult,
  BuiltToolFormer,
  CursorToolCallSpec,
  CursorToolKind,
  CursorToolResultSpec,
  CursorToolStatus,
  RejectedToolFormer,
  ToolFormerWarning,
} from './toolformer.ts';

export {
  CURSOR_HOME_ENV,
  computeWorkspaceId,
  cursorGlobalDbPath,
  cursorLogsDir,
  cursorUserDataDir,
  cursorWorkspaceStorageDir,
  defaultCursorUserDataDir,
  expandHomePath,
  findWorkspaceIdByCwd,
  fsPathFromWorkspaceIdentifier,
  listCursorWorkspaces,
  resolveCursorPaths,
  resolveWorkspaceId,
  workspaceIdentifierFor,
} from './paths.ts';
export type { CursorPaths, CursorWorkspaceIdentifier, CursorWorkspaceInfo, CursorWorkspaceJson } from './paths.ts';

export {
  BUBBLE_KEY_PREFIX,
  BUBBLE_TYPE_AI,
  BUBBLE_TYPE_HUMAN,
  BUBBLE_VERSION,
  CAPABILITY_THINKING,
  COMPOSER_DATA_PREFIX,
  COMPOSER_VERSION,
  CURSOR_AGENT,
  HEADER_MIGRATED_FLAG_KEY,
  HEADER_SENTINEL_KEY,
  HEADER_TABLE,
  LEGACY_HEADER_BLOB_KEY,
  UNIFIED_MODE_AGENT,
  bubbleKey,
  bubbleKeyPrefix,
  bubbleText,
  bubbleThinkingText,
  closeCursorDb,
  composerDataKey,
  countBubbles,
  detectCursorVersion,
  emptyComposerContext,
  ensureCursorSchema,
  headerRecordFromRow,
  isRecord,
  isUuid,
  msToIso,
  newUuid,
  openCursorDb,
  parseJsonRecord,
  plainTextToRichTextDoc,
  randomBase64,
  readAllBubbles,
  readBubbles,
  readComposerDataObject,
  readComposerDataRaw,
  readDiskKvEntries,
  readDiskKvKeys,
  readDiskKvValue,
  readHeaderRow,
  readHeaderRows,
  readItemValue,
  richTextToPlainText,
  tableExists,
  tryParseJson,
} from './wire.ts';
export type {
  CursorBubble,
  CursorComposerData,
  CursorConversationHeaderEntry,
  CursorHeaderRecord,
  CursorHeaderRow,
  CursorHeaderValue,
  CursorImageRef,
  CursorModelConfig,
  CursorSubagentInfo,
  CursorThinking,
  CursorToolFormerData,
} from './wire.ts';
