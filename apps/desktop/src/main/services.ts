/**
 * 桌面端服务层：全部业务逻辑都在主进程，renderer 只拿到可序列化的视图数据。
 * 这里不 import electron，便于在 Node 里单测 / 复用。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describeDecision, findRef, loadRegistry, OFFICIAL_IMPORTS, officialSupport, planSync, saveRegistry, sessionportHome, sourceKeyOf, upsertRef, verifyOfficialImport } from '@sessionport/core';
import { READABLE_AGENTS, WRITABLE_AGENTS, getAdapter } from './adapters.ts';
import { AppError } from './errors.ts';
import type { AdapterWriteOptions, AgentAdapter, AgentId, ExternalRef, IrBundle, IrSession, LossEntry, OfficialSupport, OfficialTarget, OfficialVerifyResult, SyncDecision } from '@sessionport/core';

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
}

export interface MigrationResult {
  target: AgentId;
  sessionId: string;
  paths: string[];
  losses: LossEntry[];
  imported: boolean;
  sync: SyncInfo;
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
  if (agent === 'codex' || agent === 'cursor') return input.sessionId ?? requirePath(input);
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
      const result = (await core.listAllSessions({ limit: 500 })) as { sessions?: unknown[]; warnings?: string[] } | unknown[];
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
  stateHome: string | undefined;
  targetId?: string;
  targetPath?: string;
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
  const outcome = await writer.write(
    prepared.bundle,
    buildAdapterWriteOpts(target, prepared.bundle, {
      ...options,
      dryRun: false,
      id: fork ? undefined : (options.targetId ?? prepared.extRef?.targetId),
      targetPath: fork ? undefined : prepared.extRef?.targetPath,
      allowOverwrite: prepared.extRef !== undefined && !fork,
    }),
  );

  const nextRef: ExternalRef = {
    sourceKey: prepared.sync.sourceKey,
    target,
    targetId: outcome.targetId,
    targetPath: outcome.paths[0] ?? prepared.targetPath ?? '',
    unit: outcome.unit,
    targetUnits: outcome.units,
    sourceEvents: prepared.bundle.root.events.length,
    sourceHead: prepared.bundle.root.head,
    updatedAt: new Date().toISOString(),
  };
  upsertRef(prepared.registry, nextRef);
  saveRegistry(prepared.registry, prepared.stateHome);

  return {
    target,
    sessionId: outcome.targetId,
    paths: outcome.paths,
    losses: (outcome.report.losses ?? []) as LossEntry[],
    imported: outcome.report.imported === true,
    sync: { ...prepared.sync, targetId: outcome.targetId, targetPath: nextRef.targetPath, targetUnits: outcome.units },
  };
}

export interface PathsInfo {
  homes: Record<string, { label: string; path: string; exists: boolean }>;
  registryDir: string;
  registryFile: string;
}

/** 各 agent 的数据目录（设置页展示 + 打开用） */
export function pathsInfo(): PathsInfo {
  const home = homedir();
  const homes = {
    kimi: { label: 'Kimi Code', path: join(home, '.kimi-code') },
    claude: { label: 'Claude Code', path: join(home, '.claude') },
    commandCode: { label: 'Command Code', path: join(home, '.commandcode') },
    dsh: { label: 'DeepSeek Harness', path: join(home, '.dsh') },
    codex: { label: 'Codex', path: join(home, '.codex') },
    opencode: { label: 'opencode', path: join(home, '.local', 'share', 'opencode') },
    cursor: { label: 'Cursor', path: join(home, 'Library', 'Application Support', 'Cursor') },
    qoder: { label: 'Qoder', path: join(home, '.qoder-cn') },
    workbuddy: { label: 'WorkBuddy', path: join(home, '.workbuddy') },
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
    commandCode: existsSync(join(home, '.commandcode')),
    dsh: existsSync(join(home, '.dsh')),
    codex: existsSync(join(home, '.codex')),
    opencode: existsSync(join(home, '.local/share/opencode')),
    cursor: existsSync(join(home, 'Library', 'Application Support', 'Cursor')),
    qoder: existsSync(join(home, '.qoder-cn')),
    workbuddy: existsSync(join(home, '.workbuddy')),
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