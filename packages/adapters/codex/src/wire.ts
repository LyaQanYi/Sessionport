/**
 * Codex CLI 0.163 的 rollout JSONL 类型与解析。
 *
 * 事实来源：本机真实会话 rollout（0.162 写入、0.163 读取），每行 {timestamp, type, payload}。
 * 注意 Codex 是双轨记录：
 * - response_item 是模型层（message / reasoning / function_call / function_call_output）
 * - event_msg 是 UI 层镜像（user_message / agent_message / agent_reasoning / token_count …）
 * reader 以 response_item 为准，event_msg 只计数跳过（否则内容会翻倍）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CodexSessionMeta {
  session_id?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  runtime_workspace_roots?: string[];
  originator?: string;
  cli_version?: string;
  source?: string;
  thread_source?: string;
  model_provider?: string;
  base_instructions?: unknown;
  history_mode?: string;
  context_window?: number;
  git?: { branch?: string; sha?: string; origin_url?: string };
}

export interface CodexContentBlock {
  type?: string;
  text?: string;
}

export const CODEX_DIR = '.codex';

export function codexHome(explicit?: string): string {
  if (explicit) return explicit.startsWith('~/') ? join(homedir(), explicit.slice(2)) : explicit;
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.codex');
}

export function sessionsRoot(home: string): string {
  return join(home, 'sessions');
}

export function threadIndexPath(home: string): string {
  return join(home, 'session_index.jsonl');
}

/** 递归找 sessions/ 下所有 rollout 文件（按 mtime 降序） */
export function listRolloutFiles(home: string): string[] {
  const root = sessionsRoot(home);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

/** rollout 文件名里的会话 id：rollout-2026-10-16T14-40-28-<uuid>.jsonl */
export function sessionIdFromRolloutPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return match?.[1];
}

export function parseRollout(text: string): { lines: CodexLine[]; badLines: number } {
  const lines: CodexLine[] = [];
  let badLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object') lines.push(value as CodexLine);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines };
}

export function readRollout(path: string): { lines: CodexLine[]; badLines: number } {
  return parseRollout(readFileSync(path, 'utf8'));
}

/** session_index.jsonl：{id, thread_name, updated_at} */
export interface CodexIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

export function readSessionIndex(home: string): CodexIndexEntry[] {
  const path = threadIndexPath(home);
  if (!existsSync(path)) return [];
  const out: CodexIndexEntry[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as CodexIndexEntry;
      if (value && typeof value.id === 'string') out.push(value);
    } catch {
      // 索引行坏了就跳过
    }
  }
  return out;
}
/** rollout 文件名里的本地时间：2026-10-16T14-40-28 */
export function rolloutTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
}

/** sessions/YYYY/MM/DD/rollout-<local ts>-<sessionId>.jsonl */
export function codexRolloutPath(home: string, sessionId: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const dateDir = join(sessionsRoot(home), String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  return join(dateDir, 'rollout-' + rolloutTimestamp(at) + '-' + sessionId + '.jsonl');
}
