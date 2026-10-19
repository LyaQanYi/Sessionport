/**
 * opencode 会话列表（只读 sqlite，不解析消息/part 表）。
 *
 * 数据源：<数据目录>/opencode.db（默认 ~/.local/share/opencode；可用 $OPENCODE_DB 覆盖）
 * - 只读 session 表：id/title/directory/time_created/time_updated/parent_id/time_archived
 * - 用 node:sqlite 的 readOnly 模式打开，绝不写库；DB 文件的 -wal 由 sqlite 自己处理
 *
 * 容错：db 文件不存在或 session 表不存在返回 []；表结构缺列时按实际列降级查询。
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import { opencodeDbPath } from './wire.ts';

export interface OpencodeListOptions extends ListSessionsOptions {
  /** 直接指定 opencode.db；优先于 home。home 也可以直接传 db 文件路径 */
  dbPath?: string;
}

export async function listOpencodeSessions(options: OpencodeListOptions = {}): Promise<SessionSummary[]> {
  const dbPath = await resolveDbPath(options);
  if (dbPath === undefined || !existsSync(dbPath)) return [];

  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get();
    if (table === undefined) return []; // 旧库/新库没有 session 表：没有可列的东西

    const columns = new Set<string>();
    for (const row of db.prepare('PRAGMA table_info(session)').all() as Array<Record<string, unknown>>) {
      if (typeof row['name'] === 'string') columns.add(row['name']);
    }
    const select = ['id', 'title', 'directory', 'time_created', 'time_updated'];
    if (columns.has('parent_id')) select.push('parent_id');
    if (columns.has('time_archived')) select.push('time_archived');
    const rows = db.prepare('SELECT ' + select.join(', ') + ' FROM session ORDER BY time_updated DESC').all() as Array<Record<string, unknown>>;

    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      const sessionId = textOf(row['id']);
      if (sessionId === undefined) continue;
      const summary: SessionSummary = {
        agent: 'opencode',
        sessionId,
        nativePath: dbPath,
        resumeHint: 'opencode run --session ' + sessionId,
      };
      const title = textOf(row['title']);
      if (title !== undefined) summary.title = title;
      const cwd = textOf(row['directory']);
      if (cwd !== undefined) summary.cwd = cwd;
      const createdAt = msToIso(row['time_created']);
      if (createdAt !== undefined) summary.createdAt = createdAt;
      const updatedAt = msToIso(row['time_updated']);
      if (updatedAt !== undefined) summary.updatedAt = updatedAt;
      const parentSessionId = textOf(row['parent_id']);
      if (parentSessionId !== undefined) summary.parentSessionId = parentSessionId;
      if (row['time_archived'] !== undefined && row['time_archived'] !== null) summary.archived = true;
      summaries.push(summary);
    }
    return finalizeSessionList(summaries, options.limit);
  } finally {
    db.close();
  }
}

/** 解析 db 路径：dbPath > home（文件则直接用，目录则拼 opencode.db）> 默认规则 */
async function resolveDbPath(options: OpencodeListOptions): Promise<string | undefined> {
  const explicit = textOf(options.dbPath);
  if (explicit !== undefined) return explicit;
  const home = textOf(options.home);
  if (home !== undefined) {
    if (home.endsWith('.db')) return home;
    const info = await stat(home).catch(() => undefined);
    if (info !== undefined && info.isFile()) return home;
    return join(home, 'opencode.db');
  }
  return opencodeDbPath();
}

function msToIso(value: unknown): string | undefined {
  const ms = typeof value === 'bigint' ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
