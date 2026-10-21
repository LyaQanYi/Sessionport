/**
 * 写：IR → Cursor 新 composer（app 会话列表可见、可继续对话）。
 *
 * 只新增 key，不做任何 update/delete：
 *   composerHeaders 一行（pk=composerId）
 *   cursorDiskKV['composerData:<composerId>']
 *   cursorDiskKV['bubbleId:<composerId>:<bubbleId>'] × N
 *
 * 安全约束：
 * - 单事务（BEGIN IMMEDIATE / COMMIT）、WAL、busy_timeout=5s
 * - 写入前把计划 key 的现值备份到 <backupDir>/cursor-write-backup-*.json（有则备份）
 * - 目标 key 已存在 → 直接拒绝（不覆盖任何旧会话）
 * - 默认 Cursor 用户库路径写入必须显式 confirmReal: true（先 dryRun 看计划）
 *
 * 字段形状来自 app 未压缩 JS（Cursor 3.25.9 workbench.glass.main.js）：
 * createEmptyComposer、getComposerHeaderData(_Ce)、createComposerMessageHeaderData(_R)、
 * createComposerMessageHeaderGroupingData(Lts)；当前 composerData._v=18 / bubble._v=3。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { LossCollector } from '@sessionport/core';
import type {
  AgentId,
  ExportCaps,
  IrBundle,
  IrContent,
  IrEvent,
  IrSession,
  LossEntry,
  WriteReport,
} from '@sessionport/core';

import {
  cursorGlobalDbPath,
  defaultCursorUserDataDir,
  resolveCursorPaths,
  resolveWorkspaceId,
  workspaceIdentifierFor,
} from './paths.ts';
import type { CursorPaths, CursorWorkspaceIdentifier } from './paths.ts';
import {
  BUBBLE_TYPE_AI,
  BUBBLE_TYPE_HUMAN,
  BUBBLE_VERSION,
  CAPABILITY_THINKING,
  COMPOSER_VERSION,
  CURSOR_AGENT,
  HEADER_TABLE,
  UNIFIED_MODE_AGENT,
  bubbleKey,
  closeCursorDb,
  composerDataKey,
  emptyComposerContext,
  ensureCursorSchema,
  isRecord,
  newUuid,
  openCursorDb,
  plainTextToRichTextDoc,
  randomBase64,
  readComposerDataObject,
  readDiskKvValue,
  readHeaderRow,
  readHeaderRows,
  tableExists,
} from './wire.ts';
import type {
  CursorBubble,
  CursorComposerData,
  CursorConversationHeaderEntry,
  CursorHeaderValue,
  CursorModelConfig,
  CursorToolFormerData,
} from './wire.ts';
import { CAPABILITY_TOOL_FORMER, buildCursorToolFormerData } from './toolformer.ts';

export const CURSOR_CAPS: ExportCaps = {
  agent: 'cursor' as unknown as AgentId,
  reasoning: 'plain',
  // tool_result 内联在同一个气泡的 toolFormerData.result 里（Cursor 原生形态）
  toolResults: 'inline',
  branching: false,
  subagents: false,
  modelPinned: false,
};

export interface WriteCursorOptions {
  /** Cursor 用户数据根目录；默认 $SESSIONPORT_CURSOR_HOME 或平台默认 */
  home?: string;
  /** 直接指定 state.vscdb（优先于 home 推导） */
  dbPath?: string;
  /** 只算不写，返回计划（不产生任何文件） */
  dryRun?: boolean;
  /** 目标 workspaceStorage id；默认按 cwd 复用/推导 */
  workspaceId?: string;
  /** 目标 composerId（默认随机 uuid） */
  composerId?: string;
  /** 覆盖目标 cwd（默认 IR meta.cwd） */
  cwd?: string;
  /** 目标模型 id；默认沿用库里最近一个 composer 的 modelConfig */
  model?: string;
  title?: string;
  /** 备份目录；默认 <process.cwd()>/.tmp */
  backupDir?: string;
  /** 写入真实 Cursor 用户库时必须显式置 true */
  confirmReal?: boolean;
  /** 保留源端 synthetic 用户消息（默认丢弃） */
  keepSynthetic?: boolean;
  /**
   * 保留源端会话的 lastUpdatedAt/recency（默认 false：用写入时刻，让导入会话排在列表顶部；
   * 气泡自己的 createdAt 仍保留源时间）
   */
  preserveUpdatedAt?: boolean;
  /** 关闭 key 冲突检查（仅供测试/极端场景，正常不要用） */
  allowOverwrite?: boolean;
}

export interface WriteCursorRow {
  kind: 'header' | 'composerData' | 'bubble';
  key: string;
  bytes: number;
}

export interface WriteCursorResult extends WriteReport {
  composerId: string;
  dbPath: string;
  dryRun: boolean;
  title: string;
  cwd: string;
  workspaceId: string;
  rows: WriteCursorRow[];
  backupPath?: string;
  header: CursorHeaderValue;
  composerData: Record<string, unknown>;
}

interface BubbleSpec {
  bubbleId: string;
  type: number;
  atIso: string;
  atMs: number;
  text?: string;
  thinking?: string;
  /** 工具气泡：toolFormerData 已经编码好 */
  tool?: CursorToolFormerData;
  /** 工具结果的时刻；工具气泡的 completedAtMs 用它 */
  completedAtMs?: number;
}

function isoOf(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function msOf(at: string): number {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : Date.now();
}

function textOfContent(content: IrContent[]): string {
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

function firstUserText(session: IrSession): string | undefined {
  for (const event of session.events) {
    if (event.kind !== 'message' || event.role !== 'user' || event.synthetic === true) continue;
    const text = event.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function isRealCursorDb(dbPath: string): boolean {
  const real = cursorGlobalDbPath(defaultCursorUserDataDir());
  return resolve(dbPath) === resolve(real);
}

function pickModelConfig(db: ReturnType<typeof openCursorDb> | undefined, model: string | undefined): CursorModelConfig {
  if (model !== undefined && model.length > 0) {
    return { modelName: model, maxMode: false, selectedModels: [{ modelId: model, parameters: [] }] };
  }
  if (db !== undefined) {
    try {
      for (const row of readHeaderRows(db, { includeSubagents: true, limit: 20 })) {
        const data = readComposerDataObject(db, row.composerId);
        const candidate = data?.modelConfig;
        if (candidate !== undefined && typeof candidate.modelName === 'string' && candidate.modelName.length > 0) {
          return candidate;
        }
      }
    } catch {
      // 读不到就用默认
    }
  }
  return { modelName: 'default', maxMode: false };
}

// ---------------------------------------------------------------------------
// JSON 结构构造（与 app 的 createEmptyComposer / _Ce / _R / Lts 对齐）
// ---------------------------------------------------------------------------

export interface BuildComposerInput {
  composerId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  workspaceIdentifier: CursorWorkspaceIdentifier;
  modelConfig: CursorModelConfig;
  conversationHeaders: CursorConversationHeaderEntry[];
  subtitle?: string;
}

/** composerData 主体（最小但完整的可加载形态） */
export function buildCursorComposerData(input: BuildComposerInput): Record<string, unknown> {
  const data: Record<string, unknown> = {
    _v: COMPOSER_VERSION,
    composerId: input.composerId,
    richText: '',
    hasLoaded: true,
    text: '',
    fullConversationHeadersOnly: input.conversationHeaders,
    conversationMap: {},
    status: 'completed',
    context: emptyComposerContext(),
    generatingBubbleIds: [],
    codeBlockData: {},
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    lastUpdatedAt: input.updatedAtMs,
    conversationCheckpointLastUpdatedAt: input.updatedAtMs,
    createdAt: input.createdAtMs,
    hasChangedContext: false,
    capabilities: [],
    name: input.title,
    isFileListExpanded: false,
    canvasPillCollapsed: false,
    browserChipManuallyDisabled: false,
    browserChipManuallyEnabled: false,
    unifiedMode: 'agent',
    activeCustomMode: null,
    committedCustomMode: null,
    pendingExitedCustomMode: null,
    forceMode: 'edit',
    usageData: {},
    allAttachedFileCodeChunksUris: [],
    modelConfig: input.modelConfig,
    subComposerIds: [],
    subagentComposerIds: [],
    capabilityContexts: [],
    todos: [],
    isQueueExpanded: true,
    hasUnreadMessages: false,
    gitHubPromptDismissed: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    addedFiles: 0,
    removedFiles: 0,
    isDraft: false,
    isCreatingWorktree: false,
    isApplyingWorktree: false,
    isUndoingWorktree: false,
    applied: false,
    pendingCreateWorktree: false,
    worktreeStartedReadOnly: false,
    isBestOfNSubcomposer: false,
    isBestOfNParent: false,
    isSpec: false,
    isProject: false,
    isSpecSubagentDone: false,
    isContinuationInProgress: false,
    stopHookLoopCount: 0,
    trackedGitRepos: [],
    isNAL: true,
    planModeSuggestionUsed: false,
    debugModeSuggestionUsed: false,
    conversationState: '~',
    queueItems: [],
    blobEncryptionKey: randomBase64(32),
    speculativeSummarizationEncryptionKey: randomBase64(32),
    latestChatGenerationUUID: newUuid(),
    isAgentic: true,
    filesChangedCount: 0,
    workspaceIdentifier: input.workspaceIdentifier,
  };
  if (input.subtitle !== undefined && input.subtitle.length > 0) data.subtitle = input.subtitle;
  return data;
}

/** composerHeaders.value：app 里 _Ce(composerData) 的等价物（undefined 字段会被 JSON.stringify 丢弃） */
export function buildCursorHeaderValue(data: Record<string, unknown>): CursorHeaderValue {
  const workspaceIdentifier = data.workspaceIdentifier as CursorWorkspaceIdentifier | undefined;
  const createdAt = typeof data.createdAt === 'number' ? data.createdAt : undefined;
  // app 的 _Ce() 同时写 agentLocation / agentLocationHistory；Agents 窗口按它们做本地项目分组，
  // 缺了虽然还能被 LocalAgentStorage 扫到，但列表里的环境归属会退化。
  const agentLocation =
    workspaceIdentifier !== undefined
      ? {
          type: 'local',
          environment: {
            id: workspaceIdentifier.id,
            ...(workspaceIdentifier.uri !== undefined ? { uri: workspaceIdentifier.uri } : {}),
          },
          status: 'active',
        }
      : undefined;
  return {
    type: 'head',
    composerId: String(data.composerId ?? ''),
    name: typeof data.name === 'string' ? data.name : undefined,
    lastUpdatedAt: typeof data.lastUpdatedAt === 'number' ? data.lastUpdatedAt : undefined,
    unfinishedRunAt: undefined,
    conversationCheckpointLastUpdatedAt:
      typeof data.conversationCheckpointLastUpdatedAt === 'number' ? data.conversationCheckpointLastUpdatedAt : undefined,
    createdAt,
    unifiedMode: 'agent',
    forceMode: 'edit',
    hasUnreadMessages: data.hasUnreadMessages === true,
    lastReadAtMs: undefined,
    contextUsagePercent: undefined,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    filesChangedCount: 0,
    subtitle: typeof data.subtitle === 'string' ? data.subtitle : undefined,
    hasBlockingPendingActions: false,
    hasPendingPlan: false,
    isArchived: undefined,
    isDraft: false,
    isWorktree: false,
    worktreeStartedReadOnly: false,
    isSpec: false,
    isProject: false,
    numSubComposers: 0,
    isBestOfNSubcomposer: false,
    isEphemeral: undefined,
    trackedGitRepos: [],
    referencedPlans: [],
    workspaceIdentifier,
    ...(agentLocation !== undefined
      ? {
          agentLocation,
          agentLocationHistory: [
            {
              id: newUuid(),
              timestamp: createdAt ?? Date.now(),
              destination: { type: 'local' },
              location: agentLocation,
              reason: 'created',
            },
          ],
        }
      : {}),
  };
}

export function userGrouping(text: string): Record<string, unknown> {
  const grouping: Record<string, unknown> = { isRenderable: true, hasText: true, toolDisplayComputed: true };
  if (text.trim().length <= 200) grouping.isShortPlainText = true;
  return grouping;
}

export function assistantGrouping(text: string): Record<string, unknown> {
  const grouping: Record<string, unknown> = {
    isRenderable: true,
    hasText: true,
    isKeptFinalAiVisibleOutsideWorkedForGroup: true,
    toolDisplayComputed: true,
  };
  if (text.trim().length <= 200) grouping.isShortPlainText = true;
  return grouping;
}

export function thinkingGrouping(durationMs: number | undefined): Record<string, unknown> {
  const grouping: Record<string, unknown> = {
    isRenderable: true,
    capabilityType: CAPABILITY_THINKING,
    hasThinking: true,
    toolDisplayComputed: true,
  };
  if (durationMs !== undefined && durationMs > 0) grouping.thinkingDurationMs = durationMs;
  return grouping;
}

/**
 * 工具气泡的 grouping。app 打开会话时会用气泡重算（JEk），这里写的是保守近似值；
 * 关键是 toolFormerTool / toolFormerStatus / toolCallId 与 toolFormerData 一致。
 */
export function toolGrouping(tool: CursorToolFormerData): Record<string, unknown> {
  const grouping: Record<string, unknown> = {
    isRenderable: true,
    capabilityType: CAPABILITY_TOOL_FORMER,
    hasText: false,
    hasThinking: false,
    toolDisplayComputed: true,
  };
  if (typeof tool.tool === 'number') grouping.toolFormerTool = tool.tool;
  if (typeof tool.status === 'string') grouping.toolFormerStatus = tool.status;
  if (typeof tool.toolCallId === 'string' && tool.toolCallId.length > 0) grouping.toolCallId = tool.toolCallId;
  return grouping;
}

function buildBubble(spec: BubbleSpec): CursorBubble {
  // 真实 bubble 都带同一组空数组字段；补齐它们可以避免 Cursor 渲染时对 undefined 调 map。
  const base: CursorBubble = {
    _v: BUBBLE_VERSION,
    type: spec.type,
    bubbleId: spec.bubbleId,
    createdAt: spec.atIso,
    requestId: '',
    unifiedMode: UNIFIED_MODE_AGENT,
    conversationState: '~',
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    approximateLintErrors: [],
    lints: [],
    codebaseContextChunks: [],
    commits: [],
    pullRequests: [],
    attachedCodeChunks: [],
    assistantSuggestedDiffs: [],
    gitDiffs: [],
    interpreterResults: [],
    images: [],
    attachedFolders: [],
    attachedFoldersNew: [],
    userResponsesToSuggestedCodeBlocks: [],
    suggestedCodeBlocks: [],
    diffsForCompressingFiles: [],
    relevantFiles: [],
    toolResults: [],
    notepads: [],
    capabilities: [],
    multiFileLinterErrors: [],
    diffHistories: [],
    recentLocationsHistory: [],
    recentlyViewedFiles: [],
    isAgentic: false,
    fileDiffTrajectories: [],
    existedSubsequentTerminalCommand: false,
    existedPreviousTerminalCommand: false,
    docsReferences: [],
    webReferences: [],
    aiWebSearchResults: [],
    attachedFoldersListDirResults: [],
    humanChanges: [],
    attachedHumanChanges: false,
    summarizedComposers: [],
    cursorRules: [],
    cursorCommands: [],
    cursorCommandsExplicitlySet: false,
    pastChats: [],
    pastChatsExplicitlySet: false,
    contextPieces: [],
    editTrailContexts: [],
    allThinkingBlocks: [],
    diffsSinceLastApply: [],
    deletedFiles: [],
    supportedTools: [],
    attachedFileCodeChunksMetadataOnly: [],
    consoleLogs: [],
    uiElementPicked: [],
    isRefunded: false,
    knowledgeItems: [],
    documentationSelections: [],
    externalLinks: [],
    projectLayouts: [],
    capabilityContexts: [],
    todos: [],
    mcpDescriptors: [],
    workspaceUris: [],
    context: emptyComposerContext(),
    codeBlocks: [],
    isPlanExecution: false,
  };
  if (spec.type === BUBBLE_TYPE_HUMAN) {
    const text = spec.text ?? '';
    base.text = text;
    base.richText = plainTextToRichTextDoc(text);
    base.agentMode = 1;
    return base;
  }
  if (spec.tool !== undefined) {
    base.text = '';
    base.capabilityType = CAPABILITY_TOOL_FORMER;
    base.toolFormerData = spec.tool;
    base.startedAtMs = spec.atMs;
    base.completedAtMs = spec.completedAtMs ?? spec.atMs;
    return base;
  }
  if (spec.thinking !== undefined) {
    base.text = '';
    base.thinking = { text: spec.thinking, signature: '' };
    base.capabilityType = CAPABILITY_THINKING;
    base.thinkingStyle = 1;
    base.thinkingDurationMs = 0;
    base.startedAtMs = spec.atMs;
    base.completedAtMs = spec.atMs;
    return base;
  }
  base.text = spec.text ?? '';
  base.startedAtMs = spec.atMs;
  base.completedAtMs = spec.atMs;
  return base;
}

function buildConversationHeader(spec: BubbleSpec): CursorConversationHeaderEntry {
  const entry: CursorConversationHeaderEntry = {
    bubbleId: spec.bubbleId,
    type: spec.type,
    createdAt: spec.atIso,
  };
  if (spec.type === BUBBLE_TYPE_HUMAN) {
    entry.grouping = userGrouping(spec.text ?? '');
    return entry;
  }
  if (spec.tool !== undefined) {
    entry.grouping = toolGrouping(spec.tool);
    entry.startedAtMs = spec.atMs;
    entry.completedAtMs = spec.completedAtMs ?? spec.atMs;
    return entry;
  }
  if (spec.thinking !== undefined) {
    entry.grouping = thinkingGrouping(undefined);
    entry.startedAtMs = spec.atMs;
    return entry;
  }
  entry.grouping = assistantGrouping(spec.text ?? '');
  entry.startedAtMs = spec.atMs;
  return entry;
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export async function writeCursorSession(
  bundle: IrBundle,
  options: WriteCursorOptions = {},
): Promise<WriteCursorResult> {
  const session = bundle.root;
  const paths: CursorPaths = resolveCursorPaths(options);
  const dbPath = paths.dbPath;
  const dryRun = options.dryRun === true;
  const realDb = isRealCursorDb(dbPath);
  if (realDb && !dryRun && options.confirmReal !== true) {
    throw new Error(
      '拒绝直接写真实 Cursor 数据库（' +
        dbPath +
        '）：请先 dryRun 检查计划，确认后传 confirmReal: true 再执行',
    );
  }
  if (!existsSync(dbPath)) {
    throw new Error('Cursor 数据库不存在: ' + dbPath + '（Cursor 是否安装/启动过？）');
  }

  const composerId = options.composerId ?? newUuid();
  const cwd = resolve(options.cwd ?? session.meta.cwd ?? process.cwd());
  const title =
    options.title ??
    (session.meta.title !== undefined && session.meta.title.trim().length > 0
      ? session.meta.title.trim()
      : undefined) ??
    firstUserText(session)?.slice(0, 80) ??
    'Sessionport import';
  const losses = new LossCollector();
  const counters = {
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    reasoning: 0,
    images: 0,
    toolCalls: 0,
    toolResults: 0,
  };
  const specs: BubbleSpec[] = [];

  // 一个工具调用在 Cursor 里是一个 AI 气泡，tool_result 内联在同一个 toolFormerData.result。
  // 所以先按 callId 配对，再按事件顺序生成气泡；tool_result 事件本身不再单独成气泡。
  const resultByCallId = new Map<string, { event: Extract<IrEvent, { kind: 'tool_result' }>; index: number }>();
  const extraResultIndexes = new Set<number>();
  const consumedResultIndexes = new Set<number>();
  session.events.forEach((event, index) => {
    if (event.kind !== 'tool_result') return;
    const existing = resultByCallId.get(event.callId);
    if (existing !== undefined) {
      extraResultIndexes.add(index);
      return;
    }
    resultByCallId.set(event.callId, { event, index });
  });

  const toolSpecByEventIndex = new Map<number, BubbleSpec>();
  for (let index = 0; index < session.events.length; index += 1) {
    const event = session.events[index];
    if (event === undefined || event.kind !== 'tool_call') continue;
    const resultInfo = resultByCallId.get(event.callId);
    const callId = event.callId.trim().length > 0 ? event.callId : 'tool-' + newUuid();
    const built = buildCursorToolFormerData(
      { callId, name: event.name, input: event.input, atMs: msOf(event.at) },
      resultInfo === undefined
        ? undefined
        : {
            content: resultInfo.event.content,
            isError: resultInfo.event.isError === true,
            atMs: msOf(resultInfo.event.at),
          },
    );
    if (!built.ok) {
      for (const warning of built.warnings) {
        losses.add(warning.code, warning.message, { severity: warning.severity });
      }
      // 结果已经跟着这条调用一起丢弃，不能再算成“孤立结果”
      if (resultInfo !== undefined) consumedResultIndexes.add(resultInfo.index);
      continue;
    }
    for (const warning of built.warnings) {
      losses.add(warning.code, warning.message, { severity: warning.severity });
    }
    if (resultInfo === undefined) {
      losses.add('cursor.tool-result-missing', '工具调用没有对应结果，写入 status=cancelled 的气泡', { severity: 'info' });
    } else {
      const imageParts = resultInfo.event.content.filter((part) => part.type === 'image').length;
      if (imageParts > 0) {
        losses.add('cursor.tool-result-image-dropped', '工具结果里的图片没有本地二进制，只写了占位文本', {
          count: imageParts,
          severity: 'warning',
        });
      }
      consumedResultIndexes.add(resultInfo.index);
      counters.toolResults += 1;
    }
    toolSpecByEventIndex.set(index, {
      bubbleId: newUuid(),
      type: BUBBLE_TYPE_AI,
      atIso: isoOf(event.at),
      atMs: msOf(event.at),
      text: '',
      tool: built.data,
      completedAtMs:
        resultInfo === undefined ? msOf(event.at) : Math.max(msOf(event.at), msOf(resultInfo.event.at)),
    });
    counters.toolCalls += 1;
  }

  for (const index of extraResultIndexes) {
    const event = session.events[index];
    if (event === undefined || event.kind !== 'tool_result') continue;
    losses.add('cursor.extra-tool-result', '同一个工具调用有多个结果，Cursor 一个气泡只能内联一个，额外结果已丢弃', {
      severity: 'warning',
    });
    consumedResultIndexes.add(index);
  }

  for (let index = 0; index < session.events.length; index += 1) {
    const event = session.events[index];
    if (event === undefined) continue;
    if (event.kind === 'message') {
      const text = event.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      const images = event.parts.filter((part) => part.type === 'image').length;
      counters.images += images;
      if (event.role === 'user' && event.synthetic === true && options.keepSynthetic !== true) {
        losses.add('cursor.synthetic-user-dropped', '源端运行时注入的用户消息（synthetic）已丢弃；Cursor 会注入自己的上下文', {
          severity: 'info',
        });
        continue;
      }
      if (text.trim().length === 0) {
        losses.add('cursor.empty-message-dropped', '空消息（只有图片/附件）没有可写入的文本，已丢弃', { severity: 'info' });
        continue;
      }
      const type = event.role === 'user' ? BUBBLE_TYPE_HUMAN : BUBBLE_TYPE_AI;
      specs.push({
        bubbleId: newUuid(),
        type,
        atIso: isoOf(event.at),
        atMs: msOf(event.at),
        text,
      });
      counters.messages += 1;
      if (event.role === 'user') counters.userMessages += 1;
      else counters.assistantMessages += 1;
      continue;
    }
    if (event.kind === 'reasoning') {
      if (event.reasoning.kind !== 'plain') {
        losses.add('cursor.opaque-reasoning-dropped', '源端 reasoning 是密文/不透明数据，已丢弃', { severity: 'warning' });
        continue;
      }
      if (event.reasoning.text.trim().length === 0) continue;
      specs.push({
        bubbleId: newUuid(),
        type: BUBBLE_TYPE_AI,
        atIso: isoOf(event.at),
        atMs: msOf(event.at),
        thinking: event.reasoning.text,
      });
      counters.reasoning += 1;
      continue;
    }
    if (event.kind === 'tool_call') {
      const spec = toolSpecByEventIndex.get(index);
      if (spec !== undefined) specs.push(spec);
      continue;
    }
    if (event.kind === 'tool_result') {
      if (consumedResultIndexes.has(index)) continue;
      losses.add('cursor.orphan-tool-result', '找不到对应 tool_call 的工具结果，已显式丢弃', { severity: 'warning' });
      continue;
    }
    if (event.kind === 'boundary') {
      losses.add('cursor.boundary-dropped', '会话边界事件（' + event.boundary + '）在 Cursor 里没有对应结构', {
        severity: 'info',
      });
    }
  }

  if (counters.images > 0) {
    losses.add('cursor.images-dropped', '图片（image part）没有本地二进制，已丢弃', {
      count: counters.images,
      severity: 'warning',
    });
  }
  if (bundle.children.length > 0) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('cursor.subagent-dropped', 'Cursor 子代理 composer 结构复杂，本次不导出子代理会话', {
      count: bundle.children.length,
    });
    losses.add('cursor.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents });
  }
  if (session.source.agent !== CURSOR_AGENT) {
    losses.add('cursor.cross-agent-import', '会话来自 ' + session.source.agent + '，消息按 Cursor composer 近似还原', {
      severity: 'info',
    });
  }
  if (specs.length === 0) {
    throw new Error('IR 里没有可写入的消息（全部被丢弃）: ' + session.id);
  }

  let workspaceId = options.workspaceId;
  if (workspaceId === undefined) {
    workspaceId = resolveWorkspaceId(paths.home, cwd);
    if (workspaceId === undefined) {
      // cwd 不存在时没法用 birthtime 推导；退化为 md5(path)，并在损失清单里说明
      workspaceId = createHash('md5').update(cwd).digest('hex');
      losses.add('cursor.workspace-id-fallback', '目标目录不存在，workspaceId 用 md5(cwd) 兜底（可能与 Cursor 的推导不同）', {
        severity: 'warning',
      });
    }
  }
  const workspaceIdentifier = workspaceIdentifierFor(workspaceId, cwd);

  const inspectDb = openCursorDb(dbPath, { readOnly: true });
  let modelConfig: CursorModelConfig;
  try {
    modelConfig = pickModelConfig(inspectDb, options.model ?? session.meta.model);
  } finally {
    closeCursorDb(inspectDb);
  }

  const firstAt = specs[0] as BubbleSpec;
  const lastAt = specs[specs.length - 1] as BubbleSpec;
  const createdAtMs = Math.min(msOf(session.meta.createdAt ?? firstAt.atIso), firstAt.atMs);
  const sourceUpdatedAtMs = Math.max(msOf(session.meta.updatedAt ?? lastAt.atIso), lastAt.atMs);
  // 默认用写入时刻做 recency：Cursor 列表按 recency 倒序，导入会话应出现在列表顶部；
  // 源端时间仍保留在气泡 createdAt / header 的 createdAt 里。
  const updatedAtMs =
    options.preserveUpdatedAt === true ? sourceUpdatedAtMs : Math.max(Date.now(), createdAtMs);

  const conversationHeaders = specs.map((spec) => buildConversationHeader(spec));
  const composerData = buildCursorComposerData({
    composerId,
    title,
    createdAtMs,
    updatedAtMs,
    workspaceIdentifier,
    modelConfig,
    conversationHeaders,
  });
  const headerValue = buildCursorHeaderValue(composerData);
  const headerValueJson = JSON.stringify(headerValue);
  const composerDataJson = JSON.stringify(composerData);
  const bubbleRows = specs.map((spec) => ({
    spec,
    key: bubbleKey(composerId, spec.bubbleId),
    json: JSON.stringify(buildBubble(spec)),
  }));

  const rows: WriteCursorRow[] = [
    { kind: 'composerData', key: composerDataKey(composerId), bytes: byteLength(composerDataJson) },
    { kind: 'header', key: HEADER_TABLE + ':' + composerId, bytes: byteLength(headerValueJson) },
    ...bubbleRows.map((row) => ({
      kind: 'bubble' as const,
      key: row.key,
      bytes: byteLength(row.json),
    })),
  ];

  const plannedKeys = [composerDataKey(composerId), ...bubbleRows.map((row) => row.key)];
  const backupInfo = inspectPlannedKeys(dbPath, composerId, plannedKeys);
  let backupPath: string | undefined;
  if (!dryRun) {
    backupPath = writeBackup(options.backupDir, {
      dbPath,
      composerId,
      rows,
      existing: backupInfo.existing,
    });
  }
  if (!options.allowOverwrite && backupInfo.existingKeys.length > 0) {
    throw new Error(
      '目标 key 已存在，拒绝覆盖已有 Cursor 会话: ' +
        backupInfo.existingKeys.slice(0, 5).join(', ') +
        (backupInfo.existingKeys.length > 5 ? ' …' : ''),
    );
  }

  if (!dryRun) {
    const db = openCursorDb(dbPath);
    try {
      ensureCursorSchema(db);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('BEGIN IMMEDIATE;');
      try {
        // 事务内再查一次：避免 inspectPlannedKeys 与 BEGIN 之间的竞态让 INSERT 覆盖旧 key
        // （cursorDiskKV.key 是 UNIQUE ON CONFLICT REPLACE，冲突会静默替换而不是报错）。
        if (options.allowOverwrite !== true) {
          const headerExists = db.prepare('SELECT 1 AS present FROM composerHeaders WHERE composerId = ?').get(composerId);
          if (headerExists !== undefined) {
            throw new Error('目标 key 已存在，拒绝覆盖已有 Cursor 会话: ' + HEADER_TABLE + ':' + composerId);
          }
          const kvExists = db.prepare('SELECT 1 AS present FROM cursorDiskKV WHERE key = ?');
          for (const key of plannedKeys) {
            if (kvExists.get(key) !== undefined) {
              throw new Error('目标 key 已存在，拒绝覆盖已有 Cursor 会话: ' + key);
            }
          }
        }
        const insertHeader = db.prepare(
          'INSERT INTO ' +
            HEADER_TABLE +
            ' (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, subagentTypeName, value) ' +
            'VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)',
        );
        insertHeader.run(
          composerId,
          workspaceId,
          createdAtMs,
          updatedAtMs,
          updatedAtMs,
          updatedAtMs,
          '',
          headerValueJson,
        );
        // cursorDiskKV.key 声明了 ON CONFLICT REPLACE；显式 OR ABORT 覆盖列的默认策略，
        // 即使有并发写入也不会静默替换旧值。
        const insertKv = db.prepare('INSERT OR ABORT INTO cursorDiskKV (key, value) VALUES (?, ?)');
        insertKv.run(composerDataKey(composerId), composerDataJson);
        for (const bubbleRow of bubbleRows) insertKv.run(bubbleRow.key, bubbleRow.json);
        db.exec('COMMIT;');
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // 事务可能已自动回滚
        }
        throw error;
      }
    } finally {
      closeCursorDb(db);
    }
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: CURSOR_CAPS.agent,
    sessionId: composerId,
    paths: [dbPath],
    composerId,
    dbPath,
    dryRun,
    title,
    cwd,
    workspaceId,
    rows,
    written: {
      events: specs.length,
      messages: counters.messages,
      toolCalls: counters.toolCalls,
      toolResults: counters.toolResults,
      reasoning: counters.reasoning,
    },
    losses: lossList,
    caps: CURSOR_CAPS,
    header: headerValue,
    composerData,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

interface ExistingKeys {
  existingKeys: string[];
  existing: Record<string, { bytes: number; value?: string; truncated?: boolean }>;
}

function inspectPlannedKeys(dbPath: string, composerId: string, kvKeys: string[]): ExistingKeys {
  const existingKeys: string[] = [];
  const existing: ExistingKeys['existing'] = {};
  const db = openCursorDb(dbPath, { readOnly: true });
  try {
    if (tableExists(db, HEADER_TABLE) && readHeaderRow(db, composerId) !== undefined) {
      existingKeys.push(HEADER_TABLE + ':' + composerId);
      const row = readHeaderRow(db, composerId);
      if (row !== undefined) {
        existing[HEADER_TABLE + ':' + composerId] = { bytes: byteLength(row.value), value: row.value };
      }
    }
    for (const key of kvKeys) {
      const value = readDiskKvValue(db, key);
      if (value === undefined) continue;
      existingKeys.push(key);
      existing[key] = truncateValue(value);
    }
  } finally {
    closeCursorDb(db);
  }
  return { existingKeys, existing };
}

function truncateValue(value: string): { bytes: number; value?: string; truncated?: boolean } {
  const bytes = byteLength(value);
  const limit = 1024 * 1024;
  return bytes > limit ? { bytes, value: value.slice(0, limit), truncated: true } : { bytes, value };
}

const MAX_BACKUP_VALUE = 1024 * 1024;

function writeBackup(
  backupDir: string | undefined,
  input: {
    dbPath: string;
    composerId: string;
    rows: WriteCursorRow[];
    existing: Record<string, { bytes: number; value?: string; truncated?: boolean }>;
  },
): string {
  const dir = backupDir !== undefined && backupDir.length > 0 ? resolve(backupDir) : join(process.cwd(), '.tmp');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, 'cursor-write-backup-' + stamp + '-' + input.composerId + '.json');
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    dbPath: input.dbPath,
    composerId: input.composerId,
    note: '写入前备份：cursor 写入只新增 key；这里记录计划 key 的旧值（有则备份）',
    planned: input.rows,
    existing: Object.fromEntries(
      Object.entries(input.existing).map(([key, value]) => {
        if (value.value !== undefined && value.bytes > MAX_BACKUP_VALUE) {
          return [key, { bytes: value.bytes, truncated: true, value: value.value.slice(0, MAX_BACKUP_VALUE) }];
        }
        return [key, value];
      }),
    ),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return file;
}

export function printWriteReport(report: WriteCursorResult): string {
  return [
    'target      ' + report.target,
    'composer    ' + report.composerId,
    'db          ' + report.dbPath,
    'cwd         ' + report.cwd,
    'workspace   ' + report.workspaceId,
    'rows        ' + String(report.rows.length) + '（header 1 + composerData 1 + bubble ' + String(report.rows.length - 2) + '）',
    'title       ' + report.title,
    'dryRun      ' + String(report.dryRun),
    report.backupPath !== undefined ? 'backup      ' + report.backupPath : 'backup      -',
  ].join('\n');
}

export type { IrEvent, IrSession };
