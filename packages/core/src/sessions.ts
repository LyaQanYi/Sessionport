/**
 * 跨 agent 的会话列表（只读元数据，不解析对话内容）。
 *
 * 设计目标：给桌面端/CLI 一个统一的「本机有哪些会话」数据源。
 * - 每家 adapter 提供 listXxxSessions(options?)，返回 SessionSummary[]
 * - 本模块做聚合：并发调用各家、按 updatedAt 倒序、默认截断 200 条
 * - 单个 adapter 失败只记 warning，不阻断其它家
 *
 * 注意：core 不声明对 adapter 的包依赖（避免包图成环），默认 lister 用「字面量动态 import」
 * 直接加载 workspace 内的 adapter 源码。字面量形式可被 Node/Vite/Rollup 静态分析，
 * 因此桌面端 electron-vite 打包时这些 adapter 会被正常打进主进程 bundle。
 * 测试/自定义场景可通过 options.loaders 注入替身。
 */
import type { AgentId } from './ir.ts';

/** 统一会话摘要。只含元数据；标题优先取源端自己的标题，其次首条用户消息片段 */
export interface SessionSummary {
  agent: AgentId;
  /** 源端原生会话 id（可原样喂给 resume / reader） */
  sessionId: string;
  title?: string;
  /** 会话工作目录（源端口径） */
  cwd?: string;
  /** ISO 8601 */
  createdAt?: string;
  /** ISO 8601；排序依据 */
  updatedAt?: string;
  /** 原生数据位置：目录或文件。sqlite 后端的 agent（opencode）是数据库文件 */
  nativePath: string;
  /** 目标端 resume 命令的可执行片段（会话 id / transcript 路径） */
  resumeHint?: string;
  /** 源端标记为已归档 */
  archived?: boolean;
  /** 子代理/子会话的父会话 id（DSH subagent、opencode parent_id 等） */
  parentSessionId?: string;
}

/** 单个 adapter 的 listXxxSessions 选项 */
export interface ListSessionsOptions {
  /** 覆盖该 agent 的数据根目录（默认按各家的 env / ~ 规则推断），主要给测试和多 profile 用 */
  home?: string;
  /** 最多返回多少条；adapter 排序后截断 */
  limit?: number;
}

/** adapter 列表函数签名（每家实现一致） */
export type SessionLister = (options?: ListSessionsOptions) => Promise<SessionSummary[]>;

/** 聚合选项 */
export interface ListAllSessionsOptions extends ListSessionsOptions {
  /** 只列这些 agent；默认 6 家全列 */
  agents?: readonly AgentId[];
  /** 按 agent 覆盖数据根目录（优先于 home） */
  homes?: Partial<Record<AgentId, string>>;
  /** 注入替身 lister（测试 / 自定义数据源） */
  loaders?: Partial<Record<AgentId, SessionLister>>;
}

export interface ListAllSessionsResult {
  sessions: SessionSummary[];
  /** 人类可读的降级信息（某个 adapter 整体失败等）；空数组表示全部成功 */
  warnings: string[];
}

/** 固定顺序：CLI / UI 展示时保持稳定 */
export const SESSION_AGENTS: readonly AgentId[] = [
  'claude-code',
  'codex',
  'opencode',
  'kimi-code',
  'command-code',
  'dsh',
];

export const DEFAULT_SESSION_LIMIT = 200;

/**
 * 按 updatedAt 倒序排序并截断。
 * 缺 updatedAt 的排最后（用 createdAt 兜底），保证列表稳定可复现。
 */
export function finalizeSessionList(sessions: SessionSummary[], limit?: number): SessionSummary[] {
  const sorted = [...sessions].sort(compareSessions);
  const max = normalizeLimit(limit);
  return max === undefined ? sorted : sorted.slice(0, max);
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const byUpdated = timeOf(b.updatedAt) - timeOf(a.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  const byCreated = timeOf(b.createdAt) - timeOf(a.createdAt);
  if (byCreated !== 0) return byCreated;
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

function timeOf(iso: string | undefined): number {
  if (iso === undefined) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** limit 非法（undefined/0/负数/NaN）时返回 undefined 表示不截断 */
function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  const floored = Math.floor(limit);
  return floored > 0 ? floored : undefined;
}

/** 默认 lister：按 agent 加载对应 adapter。字面量 import 便于打包器静态分析。 */
async function loadBuiltinLister(agent: AgentId): Promise<SessionLister> {
  switch (agent) {
    case 'claude-code': {
      const mod = await import('../../adapters/claude-code/src/index.ts');
      return (options) => mod.listClaudeSessions(options);
    }
    case 'codex': {
      const mod = await import('../../adapters/codex/src/index.ts');
      return (options) => mod.listCodexSessions(options);
    }
    case 'opencode': {
      const mod = await import('../../adapters/opencode/src/index.ts');
      return (options) => mod.listOpencodeSessions(options);
    }
    case 'kimi-code': {
      const mod = await import('../../adapters/kimi-code/src/index.ts');
      return (options) => mod.listKimiSessions(options);
    }
    case 'command-code': {
      const mod = await import('../../adapters/command-code/src/index.ts');
      return (options) => mod.listCommandCodeSessions(options);
    }
    case 'dsh': {
      const mod = await import('../../adapters/dsh/src/index.ts');
      return (options) => mod.listDshSessions(options);
    }
  }
}

/**
 * 聚合列出本机所有 agent 的会话。
 *
 * - 默认 6 家全列，按 updatedAt 倒序，最多 200 条（可覆盖）
 * - 单个 adapter 抛错时降级为 warning，其它家照常返回
 * - 结果里的 agent 字段以请求的 agent 为准（防 adapter 标错）
 */
export async function listAllSessions(options: ListAllSessionsOptions = {}): Promise<ListAllSessionsResult> {
  const warnings: string[] = [];
  const requested = options.agents === undefined ? SESSION_AGENTS : options.agents;
  const agents: AgentId[] = [];
  for (const agent of requested) {
    if (SESSION_AGENTS.includes(agent)) agents.push(agent);
    else warnings.push('未知 agent: ' + String(agent) + '（可选 ' + SESSION_AGENTS.join(' / ') + '）');
  }
  const limit = normalizeLimit(options.limit) ?? DEFAULT_SESSION_LIMIT;
  const loaders = options.loaders ?? {};

  const perAgent = await Promise.all(
    agents.map(async (agent): Promise<SessionSummary[]> => {
      try {
        const lister = loaders[agent] ?? (await loadBuiltinLister(agent));
        const home = options.homes?.[agent] ?? options.home;
        const rows = await lister({ home, limit });
        const normalized: SessionSummary[] = [];
        for (const row of rows) {
          const summary = normalizeSummary(agent, row);
          if (summary !== undefined) normalized.push(summary);
        }
        return normalized;
      } catch (error) {
        warnings.push(agent + ': 读取会话列表失败 — ' + errorMessage(error));
        return [];
      }
    }),
  );

  const collected: SessionSummary[] = [];
  for (const rows of perAgent) collected.push(...rows);
  return { sessions: finalizeSessionList(collected, limit), warnings };
}

function normalizeSummary(agent: AgentId, row: SessionSummary): SessionSummary | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId.trim() : '';
  const nativePath = typeof row.nativePath === 'string' ? row.nativePath.trim() : '';
  if (sessionId.length === 0 || nativePath.length === 0) return undefined;
  const summary: SessionSummary = { agent, sessionId, nativePath };
  const title = trimString(row.title);
  if (title !== undefined) summary.title = title;
  const cwd = trimString(row.cwd);
  if (cwd !== undefined) summary.cwd = cwd;
  const createdAt = normalizeIso(row.createdAt);
  if (createdAt !== undefined) summary.createdAt = createdAt;
  const updatedAt = normalizeIso(row.updatedAt);
  if (updatedAt !== undefined) summary.updatedAt = updatedAt;
  const resumeHint = trimString(row.resumeHint);
  if (resumeHint !== undefined) summary.resumeHint = resumeHint;
  if (row.archived === true) summary.archived = true;
  const parentSessionId = trimString(row.parentSessionId);
  if (parentSessionId !== undefined) summary.parentSessionId = parentSessionId;
  return summary;
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
