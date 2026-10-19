/**
 * Kimi Code 会话列表（只读元数据）。
 *
 * 数据源：~/.kimi-code/sessions/<wd>_<hash>/session_<uuid>/state.json
 * - state.json 本身很小，直接读就能拿到 id/title/cwd/createdAt/updatedAt/archived/lastPrompt
 * - ~/.kimi-code/session_index.jsonl 提供 sessionDir -> workDir 映射，作为 cwd 的兜底
 *
 * 容错：目录不存在返回 []；单个 state.json 解析失败只跳过该会话。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { expandHome, finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

/** Kimi 数据根目录（含 sessions/ 与 session_index.jsonl）：显式参数 > ~/.kimi-code */
export function kimiListHome(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(expandHome(explicit));
  return join(homedir(), '.kimi-code');
}

interface KimiIndexEntry {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
}

export async function listKimiSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const home = kimiListHome(options.home);
  const sessionsRoot = await resolveSessionsRoot(home);
  const indexCwd = await readIndexCwd(home);
  const summaries: SessionSummary[] = [];

  for (const workspace of await readdirSafe(sessionsRoot)) {
    if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue;
    const workspaceDir = join(sessionsRoot, workspace.name);
    for (const entry of await readdirSafe(workspaceDir)) {
      if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue;
      const summary = await readSessionSummary(join(workspaceDir, entry.name), indexCwd);
      if (summary !== undefined) summaries.push(summary);
    }
  }
  return finalizeSessionList(summaries, options.limit);
}

/** 兼容两种 home 传法：<root>（含 sessions/）或直接就是 sessions 目录 */
async function resolveSessionsRoot(home: string): Promise<string> {
  const nested = join(home, 'sessions');
  try {
    if ((await stat(nested)).isDirectory()) return nested;
  } catch {
    // 没有 sessions/ 子目录：把 home 本身当 sessions 根（空目录会自然返回 []）
  }
  return home;
}

async function readSessionSummary(dir: string, indexCwd: Map<string, string>): Promise<SessionSummary | undefined> {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (state === null || typeof state !== 'object') return undefined;
  const sessionId = typeof state.id === 'string' && state.id.length > 0 ? state.id : basename(dir);
  const summary: SessionSummary = {
    agent: 'kimi-code',
    sessionId,
    nativePath: dir,
    resumeHint: 'kimi --session ' + sessionId,
  };
  const title = firstString(state.title) ?? firstLine(state.lastPrompt);
  if (title !== undefined) summary.title = title;
  const cwd = firstString(state.cwd) ?? indexCwd.get(resolve(dir));
  if (cwd !== undefined) summary.cwd = cwd;
  const createdAt = msToIso(state.createdAt);
  if (createdAt !== undefined) summary.createdAt = createdAt;
  const updatedAt = msToIso(state.updatedAt);
  if (updatedAt !== undefined) summary.updatedAt = updatedAt;
  if (state.archived === true) summary.archived = true;
  return summary;
}

/** session_index.jsonl: {sessionId, sessionDir, workDir}；坏行跳过 */
async function readIndexCwd(home: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return map;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line) as KimiIndexEntry;
      if (typeof entry.sessionDir === 'string' && typeof entry.workDir === 'string') {
        map.set(resolve(entry.sessionDir), entry.workDir);
      }
    } catch {
      // 坏行跳过
    }
  }
  return map;
}

async function readdirSafe(dir: string): Promise<Array<{ name: string; isDirectory(): boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function msToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function firstString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 把 lastPrompt 压成一行做标题兜底 */
function firstLine(value: unknown): string | undefined {
  const text = firstString(value);
  if (text === undefined) return undefined;
  const line = text.replace(/\s+/gu, ' ').trim();
  if (line.length === 0) return undefined;
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}
