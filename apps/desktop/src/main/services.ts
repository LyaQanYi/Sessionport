/**
 * 桌面端服务层：全部业务逻辑都在主进程，renderer 只拿到可序列化的视图数据。
 * 这里不 import electron，便于在 Node 里单测 / 复用。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentId, IrBundle, LossEntry } from '@sessionport/core';

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
  truncated: boolean;
}

export interface MigrationPreview {
  source: { agent: AgentId; sessionId: string; title?: string; events: number };
  target: AgentId;
  losses: LossEntry[];
  caps: Record<string, unknown>;
  warnings: string[];
}

export interface MigrationResult {
  target: AgentId;
  sessionId: string;
  paths: string[];
  losses: LossEntry[];
  imported: boolean;
}

export interface SessionRefInput {
  /** 会话在磁盘上的路径（opencode 除外：它指向共用 db） */
  nativePath?: string;
  /** 会话 id（opencode 必需，其他 adapter 优先路径） */
  sessionId?: string;
}

const READERS: Record<string, (input: SessionRefInput) => Promise<IrBundle>> = {
  'kimi-code': async (input) => (await import('@sessionport/adapter-kimi-code')).readKimiBundle(requirePath(input)),
  'command-code': async (input) => (await import('@sessionport/adapter-command-code')).readCommandCodeSession(requirePath(input)),
  dsh: async (input) => (await import('@sessionport/adapter-dsh')).readDshSession(requirePath(input)),
  codex: async (input) => (await import('@sessionport/adapter-codex')).readCodexSession(input.sessionId ?? requirePath(input)),
  opencode: async (input) => (await import('@sessionport/adapter-opencode')).readOpencodeSession(requireId(input)),
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
    truncated: events.length > limit,
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
};

export function writableAgents(): AgentId[] {
  return Object.keys(WRITERS) as AgentId[];
}

export async function previewMigration(agent: AgentId, ref: SessionRefInput, target: AgentId): Promise<MigrationPreview> {
  const writer = WRITERS[target];
  if (!writer) throw new Error(target + ' 还没有 writer（当前可写：' + writableAgents().join(', ') + '）');
  const bundle = await loadSource(agent, ref);
  const report = (await writer(bundle, { dryRun: true })) as { losses?: LossEntry[]; caps?: Record<string, unknown> };
  return {
    source: {
      agent,
      sessionId: bundle.root.source.nativeSessionId ?? bundle.root.id,
      title: bundle.root.meta.title,
      events: bundle.root.events.length,
    },
    target,
    losses: report.losses ?? [],
    caps: report.caps ?? {},
    warnings: bundle.root.notices.map((notice) => notice.code + (notice.count === undefined ? '' : ' x' + notice.count)),
  };
}

export async function runMigration(
  agent: AgentId,
  ref: SessionRefInput,
  target: AgentId,
  options: { register?: boolean; includeChildren?: boolean; home?: string; model?: string } = {},
): Promise<MigrationResult> {
  const writer = WRITERS[target];
  if (!writer) throw new Error(target + ' 还没有 writer');
  const bundle = await loadSource(agent, ref);
  const report = (await writer(bundle, {
    register: options.register === true,
    includeChildren: options.includeChildren === true,
    home: options.home,
    model: options.model,
  })) as { sessionId?: string; paths?: string[]; losses?: LossEntry[]; imported?: boolean; rows?: unknown[] };
  return {
    target,
    sessionId: String(report.sessionId ?? ''),
    paths: Array.isArray(report.paths) ? report.paths : [],
    losses: report.losses ?? [],
    imported: report.imported === true,
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
  };
}