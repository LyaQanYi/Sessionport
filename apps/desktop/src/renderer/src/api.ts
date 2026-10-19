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
}

export interface LossEntry {
  code: string;
  message: string;
  count: number;
  severity: 'info' | 'warning';
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

export interface Capabilities {
  readable: AgentId[];
  writable: AgentId[];
  homes: Record<string, boolean>;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface SessionportBridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  platform: string;
}

declare global {
  interface Window {
    sessionport: SessionportBridge;
  }
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await window.sessionport.invoke(channel, payload)) as IpcResult<T>;
  if (!result || typeof result !== 'object') throw new Error('IPC 返回格式异常');
  if (result.ok !== true) throw new Error(result.error);
  return result.data;
}

export const api = {
  listSessions: () => invoke<ListResult>('sessions:list'),
  readSession: (agent: AgentId, nativePath: string, limit?: number) => invoke<ReadResult>('sessions:read', { agent, nativePath, limit }),
  previewMigration: (agent: AgentId, nativePath: string, target: AgentId) => invoke<MigrationPreview>('migrate:preview', { agent, nativePath, target }),
  runMigration: (payload: { agent: AgentId; nativePath: string; target: AgentId; register?: boolean; includeChildren?: boolean; home?: string; model?: string }) =>
    invoke<MigrationResult>('migrate:run', payload),
  capabilities: () => invoke<Capabilities>('app:capabilities'),
};

export function formatTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const date = new Date(ms);
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
