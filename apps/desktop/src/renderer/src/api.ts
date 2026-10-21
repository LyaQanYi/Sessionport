/** renderer 侧的类型化 API（与主进程 services.ts 的 DTO 对齐） */
export type AgentId = 'claude-code' | 'command-code' | 'dsh' | 'codex' | 'opencode' | 'kimi-code';

export interface SessionRow {
  agent: AgentId;
  sessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  nativePath: string;
  readable: boolean;
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
  totalEvents: number;
}

export interface LossEntry {
  code: string;
  message: string;
  count: number;
  severity: 'info' | 'warning';
}

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

export interface MigrationResult {
  target: AgentId;
  sessionId: string;
  paths: string[];
  losses: LossEntry[];
  imported: boolean;
  sync: SyncInfo;
  /** code/params 是后加的结构化信息；reason 保留给旧调用方 / 未知 code 回退 */
  refused?: { reason: string; code?: string; params?: Record<string, unknown> };
}

export type DivergedMode = 'auto' | 'force' | 'fork';

export interface MigrationOptions {
  register?: boolean;
  includeChildren?: boolean;
  home?: string;
  model?: string;
  stateHome?: string;
  onDiverged?: DivergedMode;
  /** dsh：精简导入（日志也损） */
  slim?: boolean;
  /** dsh：压缩导入（保留完整日志 + compaction） */
  compact?: boolean;
  compactBudgetChars?: number;
  compactKeepRecentSteps?: number;
  /** dsh：外部 CLI 摘要命令（如 claude -p） */
  summaryCommand?: string;
}

export interface Capabilities {
  readable: AgentId[];
  writable: AgentId[];
  homes: Record<string, boolean>;
}

export interface HomeInfo {
  label: string;
  path: string;
  exists: boolean;
}

export type OfficialTarget = 'zcode' | 'qoder' | 'cursor';

export interface OfficialSupportRow {
  target: OfficialTarget;
  appName: string;
  supported: boolean;
  mechanism: string;
  sources: string[];
  store: string;
  steps: string[];
  notes: string[];
}

export interface OfficialVerifyRow {
  target: OfficialTarget;
  store: string;
  ok: boolean;
  checked: number;
  matches: Array<{ id: string; title?: string; workspace?: string; at?: string }>;
  lines: string[];
}

export interface PathsInfo {
  homes: Record<string, HomeInfo>;
  registryDir: string;
  registryFile: string;
  version: string;
  electron: string;
}

type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; params?: Record<string, unknown> };

/** 主进程返回的结构化错误；renderer 的 i18n 层按 code 映射文案 */
export class IpcError extends Error {
  readonly code?: string;
  readonly params?: Record<string, unknown>;

  constructor(message: string, code?: string, params?: Record<string, unknown>) {
    super(message);
    this.name = 'IpcError';
    if (code !== undefined) this.code = code;
    if (params !== undefined) this.params = params;
  }
}

interface SessionportBridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  platform: string;
  initialTheme?: string | null;
  initialTarget?: string | null;
}

declare global {
  interface Window {
    sessionport: SessionportBridge;
  }
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await window.sessionport.invoke(channel, payload)) as IpcResult<T>;
  if (!result || typeof result !== 'object') throw new IpcError('IPC 返回格式异常', 'ipc.badResponse');
  if (result.ok !== true) throw new IpcError(result.error, result.code, result.params);
  return result.data;
}

export interface SessionRef {
  nativePath?: string;
  sessionId?: string;
}

export function sessionRefOf(row: SessionRow): SessionRef {
  return { nativePath: row.nativePath, sessionId: row.sessionId };
}

export const api = {
  listSessions: () => invoke<ListResult>('sessions:list'),
  readSession: (agent: AgentId, ref: SessionRef, limit?: number) => invoke<ReadResult>('sessions:read', { agent, ...ref, limit }),
  previewMigration: (agent: AgentId, ref: SessionRef, target: AgentId, options: MigrationOptions = {}) =>
    invoke<MigrationPreview>('migrate:preview', { agent, ...ref, target, ...options }),
  runMigration: (payload: { agent: AgentId; ref: SessionRef; target: AgentId } & MigrationOptions) =>
    invoke<MigrationResult>('migrate:run', { ...payload, ...payload.ref, agent: payload.agent, target: payload.target }),
  capabilities: () => invoke<Capabilities>('app:capabilities'),
  paths: () => invoke<PathsInfo>('app:paths'),
  openPath: (key: string) => invoke<{ opened: string }>('app:openPath', { key }),
  officialList: () => invoke<OfficialSupportRow[]>('official:list'),
  officialVerify: (target: OfficialTarget, options: { cwd?: string; title?: string } = {}) =>
    invoke<OfficialVerifyRow>('official:verify', { target, ...options }),
  officialOpen: (target: OfficialTarget) => invoke<{ opened: boolean }>('official:open', { target }),
};

export function formatTime(iso?: string, locale: string = 'zh-CN'): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const date = new Date(ms);
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}