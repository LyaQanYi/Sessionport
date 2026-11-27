/**
 * 桌面端服务层：全部业务逻辑都在主进程，renderer 只拿到可序列化的视图数据。
 * 这里不 import electron，便于在 Node 里单测 / 复用。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  applyUndo,
  beginBackup,
  buildDeltaAndMergedBundles,
  collectOutcomePaths,
  describeDecision,
  describeMergeBackDecision,
  eventFingerprint,
  findRef,
  latestUndoableRecord,
  listHistory,
  loadHistoryRecord,
  loadRegistry,
  OFFICIAL_IMPORTS,
  officialSupport,
  planMergeBack,
  planSync,
  saveRegistry,
  sessionportHome,
  sourceKeyOf,
  upsertRef,
  verifyOfficialImport,
} from '@sessionport/core';
import { READABLE_AGENTS, WRITABLE_AGENTS, getAdapter } from './adapters.ts';
import { AppError } from './errors.ts';
import type {
  AdapterWriteOptions,
  AdapterWriteOutcome,
  AgentAdapter,
  AgentId,
  CursorUndoInfo,
  ExternalRef,
  HistoryRecord,
  IrBundle,
  IrSession,
  LossEntry,
  MergeBackDecision,
  OfficialSupport,
  OfficialTarget,
  OfficialVerifyResult,
  SyncDecision,
  UndoResult,
} from '@sessionport/core';

export type ReadableAgent = AgentId;

export interface SessionRow {
  agent: AgentId;
  sessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  nativePath: string;
  readable: boolean;
  /** resume 命令片段（供 UI 复制） */
  resumeHint?: string;
  /** 父会话 id（用于渲染逐层可展开的树状子会话） */
  parentSessionId?: string;
}

export interface ListResult {
  sessions: SessionRow[];
  warnings: string[];
}

export interface SessionEventRow {
  id: string;
  kind: string;
  at: string;
  role?: 'user' | 'assistant';
  text?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  synthetic?: boolean;
}

/** 子代理会话摘要：列表用，不含事件（点开后再按 childId 拉） */
export interface ChildSessionSummary {
  /** IR child session id（点击时作为 childId 传回） */
  id: string;
  nativeSessionId?: string;
  label?: string;
  title?: string;
  profile?: string;
  events: number;
  viaToolCallId?: string;
}

export interface ReadResult {
  agent: AgentId;
  sessionId: string;
  title?: string;
  cwd?: string;
  events: SessionEventRow[];
  notices: Array<{ code: string; message: string; count?: number; severity: string }>;
  /** 本次返回的事件数上限 */
  truncated: boolean;
  /** 会话总事件数（用于「加载更多」） */
  totalEvents: number;
  /** 当前读的是子代理会话时，指向父会话 IR id */
  parentSessionId?: string;
  /** 当前 sessionId 是否是子代理（UI 用来显示「返回主会话」） */
  isChild?: boolean;
  /** 仅根会话返回：可下钻的子代理会话 */
  children: ChildSessionSummary[];
}

/** 可序列化的同步状态（renderer 不 import core 类型） */
export interface SyncInfo {
  sourceKey: string;
  decision: 'fresh' | 'up-to-date' | 'refresh' | 'diverged';
  description: string;
  sourceEvents: number;
  targetUnits: number;
  targetExtra?: number;
  targetId?: string;
  targetPath?: string;
  stateFile: string;
}

export interface MigrationPreview {
  source: { agent: AgentId; sessionId: string; title?: string; events: number };
  target: AgentId;
  losses: LossEntry[];
  caps: Record<string, unknown>;
  warnings: string[];
  sync: SyncInfo;
}

export interface MigrationOptions {
  register?: boolean;
  includeChildren?: boolean;
  /** 目标端数据目录（claude 配置目录 / dsh home / codex home / opencode 不用 / command-code home） */
  home?: string;
  model?: string;
  /** 指定后写入这个 target id（默认沿用登记里的 id） */
  targetId?: string;
  /** registry 目录，默认 $SESSIONPORT_HOME 或 ~/.sessionport（测试用） */
  stateHome?: string;
  /** 目标端已有新增时的处理：auto 拒绝 / force 覆盖 / fork 新会话 */
  onDiverged?: 'auto' | 'force' | 'fork';
  /** dsh 目标：精简导入（截断内容，日志也损） */
  slim?: boolean;
  /** dsh 目标：压缩导入（保留完整日志 + 原生 compaction 链） */
  compact?: boolean;
  /** dsh 目标：压缩导入时最近 step 的字符预算 */
  compactBudgetChars?: number;
  /** dsh 目标：压缩导入时强制保留的最近 step 数 */
  compactKeepRecentSteps?: number;
  /** dsh 目标：用外部 CLI 生成 LLM 摘要（prompt 走 stdin），如 "claude -p" */
  summaryCommand?: string;
  /** 是否把跨源工具调用归一化为目标 harness 原生工具（默认 true） */
  normalizeTools?: boolean;
  /** antigravity 目标：只生成本地交接文件，不调 CreateConversation API */
  handoffOnly?: boolean;
  /** antigravity 目标：覆盖语言服务器地址 */
  lsAddress?: string;
  /** antigravity 目标：覆盖 CSRF token */
  csrfToken?: string;
  /** antigravity 目标：覆盖 projectId */
  projectId?: string;
  /** antigravity 目标：交接正文字符预算 */
  maxChars?: number;
}

export interface AntigravityHandoffInfo {
  delivery: 'api' | 'handoff-file';
  mdPath: string;
  irPath: string;
  promptText: string;
  conversationId?: string;
  projectId?: string;
}

export interface MigrationResult {
  target: AgentId;
  sessionId: string;
  paths: string[];
  losses: LossEntry[];
  imported: boolean;
  sync: SyncInfo;
  backupId?: string;
  handoff?: AntigravityHandoffInfo;
  refused?: { reason: string; code?: string; params?: Record<string, unknown> };
}

export interface MergeBackOptions {
  home?: string;
  targetHome?: string;
  stateHome?: string;
  normalizeTools?: boolean;
  appendDiverged?: boolean;
}

export interface MergeBackPreview {
  source: { agent: AgentId; sessionId: string; title?: string; events: number };
  target: { agent: AgentId; sessionId?: string; events?: number };
  decision: MergeBackDecision['kind'];
  description: string;
  deltaEvents: number;
  sourceDelta: number;
  strategy?: 'appendDelta' | 'rewrite';
  losses: LossEntry[];
  targetPath?: string;
  sourcePath?: string;
}

export interface MergeBackResult {
  decision: MergeBackDecision['kind'];
  mergedEvents: number;
  strategy?: 'appendDelta' | 'rewrite';
  sourcePath?: string;
  backupId?: string;
  losses: LossEntry[];
  refused?: { reason: string; code?: string; params?: Record<string, unknown> };
}

export interface SessionRefInput {
  /** 会话在磁盘上的路径（opencode 除外：它指向共用 db） */
  nativePath?: string;
  /** 会话 id（opencode 必需，其他 adapter 优先路径） */
  sessionId?: string;
}

function resolveReadInput(agent: AgentId, input: SessionRefInput): string {
  if (agent === 'opencode') return requireId(input);
  if (agent === 'cursor') {
    if (input.nativePath?.endsWith('.jsonl') === true) return input.nativePath;
    return input.sessionId ?? requirePath(input);
  }
  if (agent === 'codex') return input.sessionId ?? requirePath(input);
  return requirePath(input);
}

function requirePath(input: SessionRefInput): string {
  if (!input.nativePath) {
    throw new AppError('session.missingPath', '这个会话缺少磁盘路径，无法读取');
  }
  return input.nativePath;
}

function requireId(input: SessionRefInput): string {
  if (!input.sessionId) {
    throw new AppError('session.missingSessionId', 'opencode 会话需要 sessionId 才能读取（nativePath 指向共用 db）');
  }
  return input.sessionId;
}

export function readableAgents(): AgentId[] {
  return [...READABLE_AGENTS];
}

export function writableAgents(): AgentId[] {
  return [...WRITABLE_AGENTS];
}

async function requireReader(
  agent: AgentId,
  code: string,
  message: string,
): Promise<AgentAdapter & { read: NonNullable<AgentAdapter['read']> }> {
  const adapter = await getAdapter(agent);
  if (!adapter?.read) {
    throw new AppError(code, message, {
      agent,
      agents: readableAgents().join(', '),
    });
  }
  return adapter as AgentAdapter & { read: NonNullable<AgentAdapter['read']> };
}

async function requireWriter(
  target: AgentId,
): Promise<AgentAdapter & { write: NonNullable<AgentAdapter['write']> }> {
  const adapter = await getAdapter(target);
  if (!adapter?.write) {
    throw new AppError('session.noWriter', target + ' 还没有 writer（当前可写：' + writableAgents().join(', ') + '）', {
      agent: target,
      agents: writableAgents().join(', '),
    });
  }
  return adapter as AgentAdapter & { write: NonNullable<AgentAdapter['write']> };
}

/** 列出所有 agent 的会话。core 的 listAllSessions 落地前，先兜底 codex。 */
export async function listSessions(): Promise<ListResult> {
  const warnings: string[] = [];
  try {
    const core = (await import('@sessionport/core')) as unknown as { listAllSessions?: (options?: unknown) => Promise<unknown> };
    if (typeof core.listAllSessions === 'function') {
      const result = (await core.listAllSessions({ limit: null, includeChildren: true })) as { sessions?: unknown[]; warnings?: string[] } | unknown[];
      const raw = Array.isArray(result) ? result : (result.sessions ?? []);
      const sessions: SessionRow[] = raw.map((item) => normalizeSummary(item));
      return { sessions, warnings: Array.isArray(result) ? [] : (result.warnings ?? []) };
    }
    warnings.push('core.listAllSessions 尚未实现，当前只列出 Codex 会话');
  } catch (error) {
    warnings.push('listAllSessions 调用失败: ' + String(error));
  }

  const sessions: SessionRow[] = [];
  try {
    const codex = await import('@sessionport/adapter-codex');
    const rows = await codex.listCodexSessions();
    for (const row of rows) {
      sessions.push({
        agent: 'codex',
        sessionId: row.id,
        title: row.title,
        updatedAt: row.updatedAt,
        nativePath: row.path,
        readable: true,
        resumeHint: 'codex exec resume ' + row.id,
      });
    }
  } catch (error) {
    warnings.push('Codex 列表失败: ' + String(error));
  }
  return { sessions, warnings };
}

function normalizeSummary(item: unknown): SessionRow {
  const record = (item ?? {}) as Record<string, unknown>;
  const agent = String(record.agent ?? 'unknown') as AgentId;
  return {
    agent,
    sessionId: String(record.sessionId ?? ''),
    title: typeof record.title === 'string' ? record.title : undefined,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    nativePath: String(record.nativePath ?? ''),
    readable: readableAgents().includes(agent as ReadableAgent),
    // DSH 的 resume 需要 app 内部 cli.js，命令很长；展示层截断，完整值放 title 里由 UI 决定
    resumeHint: typeof record.resumeHint === 'string' ? record.resumeHint : undefined,
    parentSessionId:
      typeof record.parentSessionId === 'string' && record.parentSessionId.trim().length > 0
        ? record.parentSessionId.trim()
        : undefined,
  };
}

/** 从 bundle 里选根会话或指定子代理；纯函数，便于单测 */
export function selectSession(
  bundle: IrBundle,
  childId?: string,
): { session: IrSession; isChild: boolean; children: ChildSessionSummary[] } {
  if (childId === undefined || childId.length === 0) {
    return { session: bundle.root, isChild: false, children: summarizeChildren(bundle) };
  }
  const found = bundle.children.find(
    (child) => child.session.id === childId || child.session.source.nativeSessionId === childId,
  );
  if (found === undefined) {
    throw new AppError('session.childNotFound', '找不到这个子代理会话: ' + childId, { childId });
  }
  return { session: found.session, isChild: true, children: [] };
}

function summarizeChildren(bundle: IrBundle): ChildSessionSummary[] {
  return bundle.children.map((child) => {
    const summary: ChildSessionSummary = { id: child.session.id, events: child.session.events.length };
    if (child.session.source.nativeSessionId !== undefined) summary.nativeSessionId = child.session.source.nativeSessionId;
    if (child.label !== undefined) summary.label = child.label;
    if (child.session.meta.title !== undefined) summary.title = child.session.meta.title;
    if (child.session.meta.profile !== undefined) summary.profile = child.session.meta.profile;
    if (child.viaToolCallId !== undefined) summary.viaToolCallId = child.viaToolCallId;
    return summary;
  });
}

export async function readSession(agent: AgentId, ref: SessionRefInput, limit = 400, childId?: string): Promise<ReadResult> {
  const adapter = await requireReader(
    agent,
    'session.noReader',
    agent + ' 还没有 reader（当前可读：' + readableAgents().join(', ') + '）',
  );
  const bundle = await adapter.read(resolveReadInput(agent, ref));
  const picked = selectSession(bundle, childId);
  const events = picked.session.events;
  const rows: SessionEventRow[] = [];
  for (const event of events.slice(0, limit)) {
    if (event.kind === 'message') {
      const text = event.parts.map((part) => (part.type === 'text' ? part.text : '[' + part.type + ']')).join('\n');
      rows.push({ id: event.id, kind: 'message', at: event.at, role: event.role, text, synthetic: event.synthetic === true });
    } else if (event.kind === 'reasoning') {
      const text = event.reasoning.kind === 'plain' ? event.reasoning.text : '[encrypted reasoning]';
      rows.push({ id: event.id, kind: 'reasoning', at: event.at, text });
    } else if (event.kind === 'tool_call') {
      rows.push({ id: event.id, kind: 'tool_call', at: event.at, toolName: event.name, toolCallId: event.callId, text: JSON.stringify(event.input).slice(0, 2000) });
    } else if (event.kind === 'tool_result') {
      const text = event.content.map((block) => (block.type === 'text' ? block.text : '[' + block.type + ']')).join('\n');
      rows.push({ id: event.id, kind: 'tool_result', at: event.at, toolCallId: event.callId, isError: event.isError, text: text.slice(0, 8000) });
    } else {
      rows.push({ id: event.id, kind: 'boundary', at: event.at, text: event.boundary });
    }
  }
  return {
    agent,
    sessionId: picked.session.source.nativeSessionId ?? picked.session.id,
    title: picked.session.meta.title,
    cwd: picked.session.meta.cwd,
    events: rows,
    notices: picked.session.notices,
    truncated: events.length > rows.length,
    totalEvents: events.length,
    ...(picked.isChild ? { isChild: true, parentSessionId: bundle.root.id } : {}),
    children: picked.children,
  };
}

/** 加载源会话（桌面端内部用） */
export async function loadSource(agent: AgentId, ref: SessionRefInput): Promise<IrBundle> {
  const adapter = await requireReader(
    agent,
    'session.noReaderMigrate',
    agent + ' 没有 reader，无法迁移',
  );
  return adapter.read(resolveReadInput(agent, ref));
}

function buildAdapterWriteOpts(
  target: AgentId,
  bundle: IrBundle,
  options: MigrationOptions & { dryRun: boolean; id?: string; targetPath?: string; allowOverwrite?: boolean },
): AdapterWriteOptions {
  const register = options.register === true && !options.dryRun;
  return {
    dryRun: options.dryRun,
    id: options.id,
    home: options.home,
    model: options.model,
    cwd: bundle.root.meta.cwd,
    includeChildren: options.includeChildren === true,
    register,
    registerWorkspace: register,
    normalizeTools: options.normalizeTools ?? true,
    targetPath: options.targetPath,
    slim: options.slim === true,
    compact: options.compact === true,
    compactBudgetChars: options.compactBudgetChars,
    compactKeepRecentSteps: options.compactKeepRecentSteps,
    summaryCommand: options.summaryCommand,
    ...(options.handoffOnly === true ? { handoffOnly: true } : {}),
    ...(options.lsAddress !== undefined ? { lsAddress: options.lsAddress } : {}),
    ...(options.csrfToken !== undefined ? { csrfToken: options.csrfToken } : {}),
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
    ...(target === 'cursor' && !options.dryRun
      ? { confirmReal: true, ...(options.allowOverwrite ? { allowOverwrite: true } : {}) }
      : {}),
    ...(target === 'qoder' && !options.dryRun && options.allowOverwrite
      ? { overwrite: true }
      : {}),
  };
}

interface PreparedMigration {
  bundle: IrBundle;
  sync: SyncInfo;
  losses: LossEntry[];
  caps: Record<string, unknown>;
  registry: ReturnType<typeof loadRegistry>;
  extRef: ExternalRef | undefined;
  previewOutcome: AdapterWriteOutcome;
  sourcePath?: string;
  stateHome: string | undefined;
  targetId?: string;
  targetPath?: string;
}

function inferHomeFromPath(agent: AgentId, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const abs = resolve(filePath);
  if (agent === 'claude-code' || agent === 'command-code' || agent === 'qoder') {
    return dirname(dirname(dirname(abs)));
  }
  if (agent === 'dsh') {
    return dirname(dirname(dirname(abs)));
  }
  if (agent === 'codex') {
    return dirname(dirname(dirname(dirname(dirname(abs)))));
  }
  return undefined;
}

async function readTargetSessionBundle(
  agent: AgentId,
  targetId: string,
  targetPath?: string,
  targetHome?: string,
): Promise<IrBundle> {
  if (agent === 'cursor') {
    const adapter = await requireReader(agent, 'session.noReader', 'cursor 缺少 reader');
    return adapter.read(targetPath ? targetPath + '#' + targetId : targetId);
  }
  if (agent === 'opencode') {
    if (targetHome !== undefined && targetHome.length > 0) {
      const mod = await import('@sessionport/adapter-opencode');
      const raw = await mod.exportOpencodeSession(targetId, { env: { XDG_DATA_HOME: targetHome } });
      return mod.exportToBundle(raw);
    }
    const adapter = await requireReader(agent, 'session.noReader', 'opencode 缺少 reader');
    return adapter.read(targetId);
  }
  const adapter = await requireReader(agent, 'session.noReader', agent + ' 缺少 reader');
  return adapter.read(targetPath ?? targetId);
}

function backupCaveatsFor(target: AgentId, register?: boolean): string[] {
  const caveats: string[] = [];
  if (target === 'opencode') {
    caveats.push('opencode 会话写入共享数据库/外部进程，undo 仅还原 registry 而不回滚 opencode 库内消息');
  }
  if (target === 'antigravity') {
    caveats.push('若通过 ConversationService API 创建了新 Antigravity 对话，undo 仅删除本地交接文件并还原 registry，不删除 Antigravity 侧已建对话');
  }
  if (register === true) {
    caveats.push('已写入目标应用索引（如 threads/session_index.jsonl/app-state.json/workspace.json），undo 不自动删除索引条目');
  }
  return caveats;
}

async function prepareMigration(agent: AgentId, ref: SessionRefInput, target: AgentId, options: MigrationOptions): Promise<PreparedMigration> {
  const writer = await requireWriter(target);
  const bundle = await loadSource(agent, ref);
  const sourceKey = sourceKeyOf(bundle.root.source, bundle.root.id);
  const registry = loadRegistry(options.stateHome);
  const extRef = findRef(registry, sourceKey, target);
  const id = options.targetId ?? extRef?.targetId;
  const filePath = extRef?.targetPath;

  // dryRun 预测本次会写到哪里（fresh 时用来算目标端初始状态）
  const preview = await writer.write(
    bundle,
    buildAdapterWriteOpts(target, bundle, { ...options, dryRun: true, id, targetPath: filePath }),
  );
  const targetPath = filePath ?? preview.paths[0];
  const countOutcome = targetPath
    ? { ...preview, paths: [targetPath, ...preview.paths.slice(1)] }
    : preview;
  const current =
    extRef === undefined || !writer.countTarget
      ? { exists: false, units: 0 }
      : await writer.countTarget(countOutcome, { home: options.home, targetPath });
  const decision: SyncDecision = planSync({
    ref: extRef,
    source: { head: bundle.root.head, events: bundle.root.events.length },
    target: { exists: current.exists, units: current.units },
  });

  const sync: SyncInfo = {
    sourceKey,
    decision: decision.kind,
    description: describeDecision(decision),
    sourceEvents: bundle.root.events.length,
    targetUnits: current.units,
    targetExtra: decision.kind === 'diverged' ? decision.targetExtra : undefined,
    targetId: extRef?.targetId,
    targetPath,
    stateFile: sessionportHome(options.stateHome) + '/registry.json',
  };

  return {
    bundle,
    sync,
    losses: (preview.report.losses ?? []) as LossEntry[],
    caps: (preview.report.caps ?? {}) as Record<string, unknown>,
    registry,
    extRef,
    previewOutcome: preview,
    sourcePath: bundle.root.source.nativePath ?? ref.nativePath,
    stateHome: options.stateHome,
    targetId: id,
    targetPath,
  };
}

export async function previewMigration(agent: AgentId, ref: SessionRefInput, target: AgentId, options: MigrationOptions = {}): Promise<MigrationPreview> {
  const prepared = await prepareMigration(agent, ref, target, options);
  return {
    source: {
      agent,
      sessionId: prepared.bundle.root.source.nativeSessionId ?? prepared.bundle.root.id,
      title: prepared.bundle.root.meta.title,
      events: prepared.bundle.root.events.length,
    },
    target,
    losses: prepared.losses,
    caps: prepared.caps,
    warnings: prepared.bundle.root.notices.map((notice) => notice.code + (notice.count === undefined ? '' : ' x' + notice.count)),
    sync: prepared.sync,
  };
}

export async function runMigration(
  agent: AgentId,
  ref: SessionRefInput,
  target: AgentId,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const prepared = await prepareMigration(agent, ref, target, options);
  const mode = options.onDiverged ?? 'auto';

  if (prepared.sync.decision === 'diverged' && mode === 'auto') {
    return {
      target,
      sessionId: prepared.sync.targetId ?? '',
      paths: prepared.sync.targetPath ? [prepared.sync.targetPath] : [],
      losses: prepared.losses,
      imported: false,
      sync: prepared.sync,
      refused: {
        reason: prepared.sync.description + '。选择 fork（另建会话）或 force（覆盖）后重试。',
        code: 'migrate.diverged',
        params: { targetExtra: prepared.sync.targetExtra ?? 0 },
      },
    };
  }
  if (prepared.sync.decision === 'up-to-date') {
    return {
      target,
      sessionId: prepared.sync.targetId ?? '',
      paths: prepared.sync.targetPath ? [prepared.sync.targetPath] : [],
      losses: prepared.losses,
      imported: false,
      sync: prepared.sync,
    };
  }

  const fork = prepared.sync.decision === 'diverged' && mode === 'fork';
  const writer = await requireWriter(target);
  const lockedPreview = fork
    ? await writer.write(
        prepared.bundle,
        buildAdapterWriteOpts(target, prepared.bundle, { ...options, dryRun: true, id: undefined, targetPath: undefined }),
      )
    : prepared.previewOutcome;
  const lockedId = fork
    ? lockedPreview.targetId
    : (options.targetId ?? prepared.extRef?.targetId ?? lockedPreview.targetId);
  const lockedTargetPath = fork
    ? (target === 'codex' ? lockedPreview.paths[0] : undefined)
    : (prepared.extRef?.targetPath ?? (target === 'codex' ? lockedPreview.paths[0] : undefined));

  const plannedPaths =
    target === 'cursor' || target === 'opencode' ? [] : collectOutcomePaths(lockedPreview);
  const handle = beginBackup({
    stateHome: prepared.stateHome,
    action: 'desktop-migrate',
    sourceKey: prepared.sync.sourceKey,
    target,
    targetId: lockedId,
    targetHome: options.home,
    plannedPaths,
    includeRegistry: true,
    caveats: backupCaveatsFor(target, options.register),
  });

  try {
    const writeOpts = buildAdapterWriteOpts(target, prepared.bundle, {
      ...options,
      dryRun: false,
      id: lockedId,
      targetPath: lockedTargetPath,
      allowOverwrite: prepared.extRef !== undefined && !fork,
    });
    if (target === 'cursor') writeOpts.backupDir = handle.cursorBackupDir;

    const outcome = await writer.write(prepared.bundle, writeOpts);
    const writtenPath = outcome.paths[0] ?? prepared.targetPath ?? '';

    let targetIrEvents: number | undefined;
    let targetIrHead: string | null | undefined;
    let targetIrHeadHash: string | null | undefined;
    if (target !== 'antigravity' || outcome.report.delivery === 'api') {
      try {
        const readBack = await readTargetSessionBundle(target, outcome.targetId, writtenPath, options.home);
        targetIrEvents = readBack.root.events.length;
        targetIrHead = readBack.root.head;
        targetIrHeadHash = eventFingerprint(readBack.root.events.at(-1));
      } catch {
        // 个别场景无法回读目标时保留空锚点，后续 merge-back 回退内容指纹匹配
      }
    }

    const nextRef: ExternalRef = {
      sourceKey: prepared.sync.sourceKey,
      target,
      targetId: outcome.targetId,
      targetPath: writtenPath,
      unit: outcome.unit,
      targetUnits: outcome.units,
      sourceEvents: prepared.bundle.root.events.length,
      sourceHead: prepared.bundle.root.head,
      updatedAt: new Date().toISOString(),
      sourceAgent: prepared.bundle.root.source.agent,
      ...(prepared.sourcePath !== undefined ? { sourcePath: prepared.sourcePath } : {}),
      ...(options.home !== undefined ? { targetHome: options.home } : {}),
      ...(targetIrEvents !== undefined ? { targetIrEvents } : {}),
      ...(targetIrHead !== undefined ? { targetIrHead } : {}),
      ...(targetIrHeadHash !== undefined ? { targetIrHeadHash } : {}),
    };
    upsertRef(prepared.registry, nextRef);
    saveRegistry(prepared.registry, prepared.stateHome);

    const cursor: CursorUndoInfo | undefined =
      target === 'cursor'
        ? {
            dbPath: writtenPath,
            composerId: outcome.targetId,
            ...(typeof outcome.report.backupPath === 'string' ? { backupPath: outcome.report.backupPath } : {}),
          }
        : undefined;
    const backupRecord = handle.finalize({
      targetId: outcome.targetId,
      actualPaths: target === 'cursor' || target === 'opencode' ? [] : collectOutcomePaths(outcome),
      ...(cursor !== undefined ? { cursor } : {}),
    });

    const handoff = outcome.report.handoff as AntigravityHandoffInfo | undefined;
    return {
      target,
      sessionId: outcome.targetId,
      paths: outcome.paths,
      losses: (outcome.report.losses ?? []) as LossEntry[],
      imported: outcome.report.imported === true,
      sync: { ...prepared.sync, targetId: outcome.targetId, targetPath: nextRef.targetPath, targetUnits: outcome.units },
      backupId: backupRecord.id,
      ...(handoff !== undefined ? { handoff } : {}),
    };
  } catch (error) {
    handle.abort();
    throw error;
  }
}

export function listBackups(stateHome?: string, limit = 30): HistoryRecord[] {
  return listHistory(stateHome, limit);
}

export async function undoBackup(
  opId?: string,
  options: { stateHome?: string; dryRun?: boolean } = {},
): Promise<UndoResult> {
  const record = opId ? loadHistoryRecord(opId, options.stateHome) : latestUndoableRecord(options.stateHome);
  if (!record) {
    throw new AppError(
      'history.notFound',
      opId ? '找不到备份记录: ' + opId : '没有可撤销的操作记录',
      { opId: opId ?? '' },
    );
  }
  if (record.undoneAt !== undefined) {
    throw new AppError(
      'history.alreadyUndone',
      '操作 ' + record.id + ' 已经撤销过（' + record.undoneAt + '）',
      { opId: record.id },
    );
  }
  return applyUndo(record, {
    stateHome: options.stateHome,
    dryRun: options.dryRun,
    restoreCursor: async (backupPath) => {
      const mod = await import('@sessionport/adapter-cursor');
      mod.restoreCursorBackup(backupPath);
    },
  });
}

interface PreparedMergeBack {
  sourceBundle: IrBundle;
  targetBundle?: IrBundle;
  sourceAgent: AgentId;
  sourceAdapter: AgentAdapter;
  sourceKey: string;
  sourceId: string;
  sourcePath?: string;
  sourceHome?: string;
  targetHome?: string;
  registry: ReturnType<typeof loadRegistry>;
  extRef?: ExternalRef;
  decision: MergeBackDecision;
  strategy?: 'appendDelta' | 'rewrite';
  built?: ReturnType<typeof buildDeltaAndMergedBundles>;
}

async function prepareMergeBack(
  agent: AgentId,
  ref: SessionRefInput,
  target: AgentId,
  options: MergeBackOptions = {},
): Promise<PreparedMergeBack> {
  const sourceBundle = await loadSource(agent, ref);
  const sourceAgent = sourceBundle.root.source.agent;
  const sourceAdapter = (await getAdapter(sourceAgent))!;
  const sourceWritable = Boolean(sourceAdapter?.write) && sourceAdapter?.supportsInPlaceRewrite !== false;
  const sourceKey = sourceKeyOf(sourceBundle.root.source, sourceBundle.root.id);
  const sourceId = sourceBundle.root.source.nativeSessionId ?? sourceBundle.root.id;
  const registry = loadRegistry(options.stateHome);
  const extRef = findRef(registry, sourceKey, target);

  if (extRef === undefined) {
    return {
      sourceBundle,
      sourceAgent,
      sourceAdapter,
      sourceKey,
      sourceId,
      registry,
      decision: planMergeBack({
        ref: undefined,
        source: sourceBundle.root,
        target: sourceBundle.root,
        sourceWritable,
      }),
    };
  }

  const targetHome = options.targetHome ?? extRef.targetHome;
  const targetBundle = await readTargetSessionBundle(target, extRef.targetId, extRef.targetPath, targetHome);
  const decision = planMergeBack({
    ref: extRef,
    source: sourceBundle.root,
    target: targetBundle.root,
    sourceWritable,
  });

  if (decision.kind !== 'fast-forward' && decision.kind !== 'both-changed') {
    return {
      sourceBundle,
      targetBundle,
      sourceAgent,
      sourceAdapter,
      sourceKey,
      sourceId,
      targetHome,
      registry,
      extRef,
      decision,
    };
  }

  const sourcePath = sourceBundle.root.source.nativePath ?? ref.nativePath ?? extRef.sourcePath;
  const sourceHome = options.home ?? extRef.sourceHome ?? inferHomeFromPath(sourceAgent, sourcePath);
  const strategy: 'appendDelta' | 'rewrite' =
    sourceAdapter.appendDelta && sourcePath && existsSync(sourcePath) ? 'appendDelta' : 'rewrite';
  const built = buildDeltaAndMergedBundles({
    sourceBundle,
    targetAgent: target,
    targetId: extRef.targetId,
    deltaEvents: decision.deltaEvents,
    normalizeTools: options.normalizeTools !== false,
    includeDivergedBoundary: decision.kind === 'both-changed',
  });

  return {
    sourceBundle,
    targetBundle,
    sourceAgent,
    sourceAdapter,
    sourceKey,
    sourceId,
    sourcePath,
    sourceHome,
    targetHome,
    registry,
    extRef,
    decision,
    strategy,
    built,
  };
}

export async function previewMergeBack(
  agent: AgentId,
  ref: SessionRefInput,
  target: AgentId,
  options: MergeBackOptions = {},
): Promise<MergeBackPreview> {
  const prep = await prepareMergeBack(agent, ref, target, options);
  const deltaEvents =
    prep.decision.kind === 'fast-forward' || prep.decision.kind === 'both-changed'
      ? prep.decision.deltaEvents.length
      : 0;
  const sourceDelta = prep.decision.kind === 'both-changed' ? prep.decision.sourceDelta : 0;
  return {
    source: {
      agent: prep.sourceAgent,
      sessionId: prep.sourceId,
      title: prep.sourceBundle.root.meta.title,
      events: prep.sourceBundle.root.events.length,
    },
    target: {
      agent: target,
      ...(prep.extRef?.targetId !== undefined ? { sessionId: prep.extRef.targetId } : {}),
      ...(prep.targetBundle !== undefined ? { events: prep.targetBundle.root.events.length } : {}),
    },
    decision: prep.decision.kind,
    description: describeMergeBackDecision(prep.decision),
    deltaEvents,
    sourceDelta,
    ...(prep.strategy !== undefined ? { strategy: prep.strategy } : {}),
    losses: prep.built?.losses ?? [],
    ...(prep.extRef?.targetPath !== undefined ? { targetPath: prep.extRef.targetPath } : {}),
    ...(prep.sourcePath !== undefined ? { sourcePath: prep.sourcePath } : {}),
  };
}

export async function runMergeBack(
  agent: AgentId,
  ref: SessionRefInput,
  target: AgentId,
  options: MergeBackOptions = {},
): Promise<MergeBackResult> {
  const prep = await prepareMergeBack(agent, ref, target, options);
  if (prep.decision.kind === 'no-ref' || prep.decision.kind === 'source-read-only' || prep.decision.kind === 'unanchored') {
    throw new AppError('mergeBack.' + prep.decision.kind, describeMergeBackDecision(prep.decision));
  }
  if (prep.decision.kind === 'up-to-date') {
    return {
      decision: 'up-to-date',
      mergedEvents: 0,
      losses: [],
      ...(prep.sourcePath !== undefined ? { sourcePath: prep.sourcePath } : {}),
    };
  }
  if (prep.decision.kind === 'both-changed' && options.appendDiverged !== true) {
    return {
      decision: 'both-changed',
      mergedEvents: 0,
      losses: prep.built?.losses ?? [],
      refused: {
        reason: describeMergeBackDecision(prep.decision),
        code: 'mergeBack.bothChanged',
        params: { deltaEvents: prep.decision.deltaEvents.length, sourceDelta: prep.decision.sourceDelta },
      },
    };
  }

  const extRef = prep.extRef!;
  const targetBundle = prep.targetBundle!;
  const built = prep.built!;
  const strategy = prep.strategy!;

  let plannedPaths: string[] = [];
  if (prep.sourceAgent !== 'cursor' && prep.sourceAgent !== 'opencode') {
    if (strategy === 'appendDelta' && prep.sourcePath) {
      plannedPaths = [prep.sourcePath];
    } else {
      const previewWrite = await prep.sourceAdapter.write!(built.mergedBundle, {
        id: prep.sourceId,
        home: prep.sourceHome,
        cwd: prep.sourceBundle.root.meta.cwd,
        targetPath: prep.sourcePath,
        includeChildren: prep.sourceBundle.children.length > 0,
        normalizeTools: false,
        dryRun: true,
      });
      plannedPaths = collectOutcomePaths(previewWrite);
      if (prep.sourcePath && !plannedPaths.includes(resolve(prep.sourcePath))) {
        plannedPaths.unshift(resolve(prep.sourcePath));
      }
    }
  }

  const handle = beginBackup({
    stateHome: options.stateHome,
    action: 'merge-back',
    sourceKey: prep.sourceKey,
    target: prep.sourceAgent,
    targetId: prep.sourceId,
    targetHome: prep.sourceHome,
    plannedPaths,
    includeRegistry: true,
    caveats: backupCaveatsFor(prep.sourceAgent, false),
  });

  try {
    const outcome =
      strategy === 'appendDelta'
        ? await prep.sourceAdapter.appendDelta!(prep.sourcePath!, built.deltaBundle, {
            id: prep.sourceId,
            home: prep.sourceHome,
            cwd: prep.sourceBundle.root.meta.cwd,
            model: prep.sourceBundle.root.meta.model,
            normalizeTools: false,
            dryRun: false,
          })
        : await prep.sourceAdapter.write!(built.mergedBundle, {
            id: prep.sourceId,
            home: prep.sourceHome,
            dbPath: prep.sourceAgent === 'cursor' ? prep.sourcePath : undefined,
            targetPath: prep.sourcePath,
            cwd: prep.sourceBundle.root.meta.cwd,
            model: prep.sourceBundle.root.meta.model,
            includeChildren: prep.sourceBundle.children.length > 0,
            allowOverwrite: true,
            overwrite: true,
            confirmReal: true,
            backupDir: handle.cursorBackupDir,
            normalizeTools: false,
            dryRun: false,
          });

    const writtenSourcePath = outcome.paths[0] ? resolve(outcome.paths[0]) : prep.sourcePath;
    const updatedSource = await readTargetSessionBundle(
      prep.sourceAgent,
      outcome.targetId,
      writtenSourcePath,
      prep.sourceHome,
    );

    const targetAdapter = await getAdapter(target);
    const countedTarget = targetAdapter?.countTarget
      ? await targetAdapter.countTarget(
          {
            target,
            targetId: extRef.targetId,
            paths: extRef.targetPath ? [extRef.targetPath] : [],
            unit: extRef.unit,
            units: extRef.targetUnits,
            report: {},
          },
          { home: prep.targetHome, targetPath: extRef.targetPath },
        )
      : { exists: true, units: extRef.targetUnits };

    const nextRef: ExternalRef = {
      ...extRef,
      sourceAgent: prep.sourceAgent,
      ...(writtenSourcePath !== undefined ? { sourcePath: writtenSourcePath } : {}),
      ...(prep.sourceHome !== undefined ? { sourceHome: prep.sourceHome } : {}),
      ...(prep.targetHome !== undefined ? { targetHome: prep.targetHome } : {}),
      targetUnits: countedTarget.exists ? countedTarget.units : extRef.targetUnits,
      sourceEvents: updatedSource.root.events.length,
      sourceHead: updatedSource.root.head,
      targetIrEvents: targetBundle.root.events.length,
      targetIrHead: targetBundle.root.head,
      targetIrHeadHash: eventFingerprint(targetBundle.root.events.at(-1)),
      updatedAt: new Date().toISOString(),
    };
    upsertRef(prep.registry, nextRef);
    saveRegistry(prep.registry, options.stateHome);

    const cursor: CursorUndoInfo | undefined =
      prep.sourceAgent === 'cursor'
        ? {
            dbPath: outcome.paths[0] ?? '',
            composerId: outcome.targetId,
            ...(typeof outcome.report.backupPath === 'string' ? { backupPath: outcome.report.backupPath } : {}),
          }
        : undefined;
    const backupRecord = handle.finalize({
      targetId: outcome.targetId,
      actualPaths: prep.sourceAgent === 'cursor' || prep.sourceAgent === 'opencode' ? [] : collectOutcomePaths(outcome),
      ...(cursor !== undefined ? { cursor } : {}),
    });

    return {
      decision: prep.decision.kind,
      mergedEvents: prep.decision.deltaEvents.length,
      strategy,
      sourcePath: writtenSourcePath,
      backupId: backupRecord.id,
      losses: [...built.losses, ...((outcome.report.losses ?? []) as LossEntry[])],
    };
  } catch (error) {
    handle.abort();
    throw error;
  }
}

export interface PathsInfo {
  homes: Record<string, { label: string; path: string; exists: boolean }>;
  registryDir: string;
  registryFile: string;
}

function claudeDesktopDataPath(): string {
  const home = homedir();
  const candidates =
    process.platform === 'darwin'
      ? [join(home, 'Library', 'Application Support', 'Claude-3p'), join(home, 'Library', 'Application Support', 'Claude')]
      : process.platform === 'win32'
        ? [
            join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude-3p'),
            join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude'),
          ]
        : [
            join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude-3p'),
            join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude'),
          ];
  return (
    candidates.find(
      (dir) => existsSync(join(dir, 'claude-code-sessions')) || existsSync(join(dir, 'local-agent-mode-sessions')),
    ) ??
    candidates.find((dir) => existsSync(dir)) ??
    candidates[candidates.length - 1]!
  );
}

/** 各 agent 的数据目录（设置页展示 + 打开用） */
export function pathsInfo(): PathsInfo {
  const home = homedir();
  const homes = {
    kimi: { label: 'Kimi Code', path: join(home, '.kimi-code') },
    claude: { label: 'Claude Code', path: join(home, '.claude') },
    claudeDesktop: { label: 'Claude Desktop', path: claudeDesktopDataPath() },
    commandCode: { label: 'Command Code', path: join(home, '.commandcode') },
    dsh: { label: 'DeepSeek Harness', path: join(home, '.dsh') },
    codex: { label: 'Codex', path: join(home, '.codex') },
    opencode: { label: 'opencode', path: join(home, '.local', 'share', 'opencode') },
    cursor: { label: 'Cursor', path: join(home, 'Library', 'Application Support', 'Cursor') },
    qoder: { label: 'Qoder', path: join(home, '.qoder-cn') },
    workbuddy: { label: 'WorkBuddy', path: join(home, '.workbuddy') },
    antigravity: {
      label: 'Antigravity',
      path:
        !existsSync(join(home, '.gemini', 'antigravity')) && existsSync(join(home, '.gemini', 'antigravity-cli'))
          ? join(home, '.gemini', 'antigravity-cli')
          : join(home, '.gemini', 'antigravity'),
    },
  };
  const registryDir = sessionportHome();
  return {
    homes: Object.fromEntries(
      Object.entries(homes).map(([key, value]) => [key, { ...value, exists: existsSync(value.path) }]),
    ),
    registryDir,
    registryFile: join(registryDir, 'registry.json'),
  };
}

/** 测试 / 调试用：探测默认数据目录是否存在 */
export function detectHomes(): Record<string, boolean> {
  const home = homedir();
  return {
    kimi: existsSync(join(home, '.kimi-code')),
    claude: existsSync(join(home, '.claude')),
    claudeDesktop: existsSync(claudeDesktopDataPath()),
    commandCode: existsSync(join(home, '.commandcode')),
    dsh: existsSync(join(home, '.dsh')),
    codex: existsSync(join(home, '.codex')),
    opencode: existsSync(join(home, '.local/share/opencode')),
    cursor: existsSync(join(home, 'Library', 'Application Support', 'Cursor')),
    qoder: existsSync(join(home, '.qoder-cn')),
    workbuddy: existsSync(join(home, '.workbuddy')),
    antigravity:
      existsSync(join(home, '.gemini', 'antigravity')) || existsSync(join(home, '.gemini', 'antigravity-cli')),
  };
}
/** 官方导入支持矩阵（ZCode/Qoder 有，Cursor 没有） */
export function officialImports(): OfficialSupport[] {
  return OFFICIAL_IMPORTS;
}

/** 读取目标 app 自己的存储，验证官方导入结果 */
export async function officialVerify(
  target: OfficialTarget,
  options: { cwd?: string; title?: string } = {},
): Promise<OfficialVerifyResult> {
  if (!officialSupport(target).supported) {
    throw new AppError('official.unsupported', target + ' 没有官方导入路径', { target });
  }
  return verifyOfficialImport({ target, cwd: options.cwd, title: options.title });
}