/**
 * 桌面端服务层：全部业务逻辑都在主进程，renderer 只拿到可序列化的视图数据。
 * 这里不 import electron，便于在 Node 里单测 / 复用。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describeDecision, findRef, loadRegistry, planSync, saveRegistry, sessionportHome, sourceKeyOf, upsertRef } from '@sessionport/core';
import type { AgentId, ExternalRef, IrBundle, LossEntry, SyncDecision } from '@sessionport/core';

export type ReadableAgent = 'kimi-code' | 'command-code' | 'dsh' | 'codex' | 'opencode';

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
}

export interface MigrationResult {
  target: AgentId;
  sessionId: string;
  paths: string[];
  losses: LossEntry[];
  imported: boolean;
  sync: SyncInfo;
  refused?: { reason: string };
}

export interface SessionRefInput {
  /** 会话在磁盘上的路径（opencode 除外：它指向共用 db） */
  nativePath?: string;
  /** 会话 id（opencode 必需，其他 adapter 优先路径） */
  sessionId?: string;
}

const READERS: Record<string, (input: SessionRefInput) => Promise<IrBundle>> = {
  'claude-code': async (input) => (await import('@sessionport/adapter-claude-code')).readClaudeSession(requirePath(input)),
  'kimi-code': async (input) => (await import('@sessionport/adapter-kimi-code')).readKimiBundle(requirePath(input)),
  'command-code': async (input) => (await import('@sessionport/adapter-command-code')).readCommandCodeSession(requirePath(input)),
  dsh: async (input) => (await import('@sessionport/adapter-dsh')).readDshSession(requirePath(input)),
  codex: async (input) => (await import('@sessionport/adapter-codex')).readCodexSession(input.sessionId ?? requirePath(input)),
  opencode: async (input) => (await import('@sessionport/adapter-opencode')).readOpencodeSession(requireId(input)),
  cursor: async (input) => (await import('@sessionport/adapter-cursor')).readCursorSession(input.sessionId ?? requirePath(input)),
  qoder: async (input) => (await import('@sessionport/adapter-qoder')).readQoderSession(requirePath(input)),
  workbuddy: async (input) => (await import('@sessionport/adapter-workbuddy')).readWorkBuddySession(requirePath(input)),
};

function requirePath(input: SessionRefInput): string {
  if (!input.nativePath) throw new Error('这个会话缺少磁盘路径，无法读取');
  return input.nativePath;
}

function requireId(input: SessionRefInput): string {
  if (!input.sessionId) throw new Error('opencode 会话需要 sessionId 才能读取（nativePath 指向共用 db）');
  return input.sessionId;
}

export function readableAgents(): ReadableAgent[] {
  return Object.keys(READERS) as ReadableAgent[];
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

export async function readSession(agent: AgentId, ref: SessionRefInput, limit = 400): Promise<ReadResult> {
  const reader = READERS[agent];
  if (!reader) throw new Error(agent + ' 还没有 reader（当前可读：' + readableAgents().join(', ') + '）');
  const bundle = await reader(ref);
  const events = bundle.root.events;
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
    sessionId: bundle.root.source.nativeSessionId ?? bundle.root.id,
    title: bundle.root.meta.title,
    cwd: bundle.root.meta.cwd,
    events: rows,
    notices: bundle.root.notices,
    truncated: events.length > rows.length,
    totalEvents: events.length,
  };
}

/** 加载源会话（桌面端内部用） */
export async function loadSource(agent: AgentId, ref: SessionRefInput): Promise<IrBundle> {
  const reader = READERS[agent];
  if (!reader) throw new Error(agent + ' 没有 reader，无法迁移');
  return reader(ref);
}

const WRITERS: Record<string, (bundle: IrBundle, options: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
  'claude-code': async (bundle, options) => (await import('@sessionport/adapter-claude-code')).writeClaudeSession(bundle, options as never) as unknown as Promise<Record<string, unknown>>,
  'command-code': async (bundle, options) => (await import('@sessionport/adapter-command-code')).writeCommandCodeSession(bundle, options as never) as unknown as Promise<Record<string, unknown>>,
  dsh: async (bundle, options) => (await import('@sessionport/adapter-dsh')).writeDshSession(bundle, options as never) as unknown as Promise<Record<string, unknown>>,
  codex: async (bundle, options) => (await import('@sessionport/adapter-codex')).writeCodexSession(bundle, options as never) as unknown as Promise<Record<string, unknown>>,
  opencode: async (bundle, options) => (await import('@sessionport/adapter-opencode')).writeOpencodeSession(bundle, options as never) as unknown as Promise<Record<string, unknown>>,
  cursor: async (bundle, options) => (await import('@sessionport/adapter-cursor')).writeCursorSession(bundle, { ...(options as object), composerId: (options as { id?: string }).id, confirmReal: (options as { dryRun?: boolean }).dryRun !== true } as never) as unknown as Promise<Record<string, unknown>>,
  qoder: async (bundle, options) => (await import('@sessionport/adapter-qoder')).writeQoderSession(bundle, { ...(options as object), sessionId: (options as { id?: string }).id } as never) as unknown as Promise<Record<string, unknown>>,
};

export function writableAgents(): AgentId[] {
  return Object.keys(WRITERS) as AgentId[];
}

interface WriteOutcome {
  sessionId: string;
  paths: string[];
  losses: LossEntry[];
  caps: Record<string, unknown>;
  imported: boolean;
  units: number;
  unit: 'rows' | 'events';
}

/** 调目标 adapter 写（或 dryRun 预览），返回统一的度量 */
async function writeTarget(
  target: AgentId,
  bundle: IrBundle,
  options: MigrationOptions & { dryRun?: boolean; id?: string; filePath?: string },
): Promise<WriteOutcome> {
  const base = {
    dryRun: options.dryRun === true,
    includeChildren: options.includeChildren === true,
    model: options.model,
    register: options.register === true && options.dryRun !== true,
  };
  if (target === 'claude-code') {
    const mod = await import('@sessionport/adapter-claude-code');
    const report = await mod.writeClaudeSession(bundle, { ...base, configDir: options.home, sessionId: options.id, cwd: bundle.root.meta.cwd });
    return { sessionId: report.sessionId, paths: report.paths, losses: report.losses, caps: report.caps as unknown as Record<string, unknown>, imported: false, units: report.rows.length, unit: 'rows' };
  }
  if (target === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    const report = await mod.writeCommandCodeSession(bundle, { ...base, home: options.home, id: options.id });
    return { sessionId: report.sessionId, paths: report.paths, losses: report.losses, caps: report.caps as unknown as Record<string, unknown>, imported: false, units: report.rows.length + 1, unit: 'rows' };
  }
  if (target === 'dsh') {
    const mod = await import('@sessionport/adapter-dsh');
    const report = await mod.writeDshSession(bundle, { ...base, home: options.home, id: options.id });
    return { sessionId: report.sessionId, paths: report.paths, losses: report.losses, caps: report.caps as unknown as Record<string, unknown>, imported: false, units: report.written.events, unit: 'events' };
  }
  if (target === 'codex') {
    const mod = await import('@sessionport/adapter-codex');
    const report = await mod.writeCodexSession(bundle, { ...base, home: options.home, id: options.id, filePath: options.filePath });
    return { sessionId: report.sessionId, paths: report.paths, losses: report.losses, caps: report.caps as unknown as Record<string, unknown>, imported: false, units: report.rows.length + 1, unit: 'rows' };
  }
  const mod = await import('@sessionport/adapter-opencode');
  const report = await mod.writeOpencodeSession(bundle, { dryRun: options.dryRun === true, includeChildren: options.includeChildren === true, model: options.model, id: options.id });
  return {
    sessionId: report.sessionId,
    paths: report.paths,
    losses: report.losses,
    caps: report.caps as unknown as Record<string, unknown>,
    imported: report.imported,
    units: report.exportData.messages?.length ?? 0,
    unit: 'rows',
  };
}

async function countLineFile(path: string | undefined): Promise<{ exists: boolean; units: number }> {
  if (!path) return { exists: false, units: 0 };
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path, 'utf8');
    return { exists: true, units: text.split('\n').filter((line) => line.trim().length > 0).length };
  } catch {
    return { exists: false, units: 0 };
  }
}

async function countTargetUnits(
  target: AgentId,
  state: { targetId?: string; targetPath?: string; home?: string },
): Promise<{ exists: boolean; units: number }> {
  if (target === 'claude-code' || target === 'codex') return countLineFile(state.targetPath);
  if (target === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    return mod.countCommandCodeTarget(state.targetPath ?? '');
  }
  if (target === 'dsh') {
    if (!state.targetId) return { exists: false, units: 0 };
    const mod = await import('@sessionport/adapter-dsh');
    return mod.countDshTarget({ home: state.home, sessionId: state.targetId });
  }
  if (!state.targetId) return { exists: false, units: 0 };
  try {
    const mod = await import('@sessionport/adapter-opencode');
    const raw = await mod.exportOpencodeSession(state.targetId);
    return mod.countOpencodeTarget(raw);
  } catch {
    return { exists: false, units: 0 };
  }
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
  if (!WRITERS[target]) throw new Error(target + ' 还没有 writer（当前可写：' + writableAgents().join(', ') + '）');
  const bundle = await loadSource(agent, ref);
  const sourceKey = sourceKeyOf(bundle.root.source, bundle.root.id);
  const registry = loadRegistry(options.stateHome);
  const extRef = findRef(registry, sourceKey, target);
  const id = options.targetId ?? extRef?.targetId;
  const filePath = extRef?.targetPath;

  // dryRun 预测本次会写到哪里（fresh 时用来算目标端初始状态）
  const preview = await writeTarget(target, bundle, { ...options, dryRun: true, id, filePath });
  const targetPath = filePath ?? preview.paths[0];
  const current = extRef === undefined ? { exists: false, units: 0 } : await countTargetUnits(target, { targetId: extRef.targetId, targetPath, home: options.home });
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

  return { bundle, sync, losses: preview.losses, caps: preview.caps, registry, extRef, stateHome: options.stateHome, targetId: id, targetPath };
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
      refused: { reason: prepared.sync.description + '。选择 fork（另建会话）或 force（覆盖）后重试。' },
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
  const outcome = await writeTarget(target, prepared.bundle, {
    ...options,
    dryRun: false,
    id: fork ? undefined : (options.targetId ?? prepared.extRef?.targetId),
    filePath: fork ? undefined : prepared.extRef?.targetPath,
  });

  const nextRef: ExternalRef = {
    sourceKey: prepared.sync.sourceKey,
    target,
    targetId: outcome.sessionId,
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
    sessionId: outcome.sessionId,
    paths: outcome.paths,
    losses: outcome.losses,
    imported: outcome.imported,
    sync: { ...prepared.sync, targetId: outcome.sessionId, targetPath: nextRef.targetPath, targetUnits: outcome.units },
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