/**
 * Codex 会话列表（只读元数据，不解析对话全文）。
 *
 * 数据源：<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl（默认 ~/.codex）
 * - 标题来自 <CODEX_HOME>/session_index.jsonl 的 thread_name
 * - cwd / createdAt 只读 rollout 文件头 128KB 里的 session_meta 行
 * - updatedAt 优先用索引的 updated_at，否则文件 mtime
 *
 * 兼容：返回值额外保留 id/path 两个旧字段（桌面端兜底代码在用），语义等同 sessionId/nativePath。
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import type { CodexIndexEntry, CodexLine, CodexSessionMeta } from './wire.ts';
import { codexHome, listRolloutFiles, readSessionIndex, sessionIdFromRolloutPath } from './wire.ts';

/** 首页大小：session_meta 在第一行，首条 user 文本通常也在前面 */
const HEAD_BYTES = 128 * 1024;

export interface CodexSessionSummary extends SessionSummary {
  /** @deprecated 用 sessionId（兼容桌面端旧兜底代码） */
  id: string;
  /** @deprecated 用 nativePath（兼容桌面端旧兜底代码） */
  path: string;
}

export async function listCodexSessions(options: ListSessionsOptions | string = {}): Promise<CodexSessionSummary[]> {
  const home = codexHome(typeof options === 'string' ? options : options.home);
  const limit = typeof options === 'string' ? undefined : options.limit;
  const index = safeIndex(home);
  const summaries: CodexSessionSummary[] = [];

  for (const filePath of listRolloutFiles(home)) {
    const info = await stat(filePath).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    const sessionId = sessionIdFromRolloutPath(filePath) ?? filePath;
    const head = await readRange(filePath, 0, Math.min(info.size, HEAD_BYTES)).catch(() => '');
    const lines = parseJsonLines(head);
    const meta = lines.find((line) => line.type === 'session_meta')?.payload as CodexSessionMeta | undefined;
    const indexEntry = index.get(sessionId);

    const summary: CodexSessionSummary = {
      agent: 'codex',
      sessionId,
      id: sessionId,
      nativePath: filePath,
      path: filePath,
      resumeHint: 'codex exec resume ' + sessionId,
    };
    const title = textOf(indexEntry?.thread_name) ?? firstUserText(lines);
    if (title !== undefined) summary.title = title;
    const cwd = textOf(meta?.cwd);
    if (cwd !== undefined) summary.cwd = cwd;
    const createdAt = normalizeIso(meta?.timestamp) ?? createdAtFromRolloutName(filePath);
    if (createdAt !== undefined) summary.createdAt = createdAt;
    const updatedAt = normalizeIso(indexEntry?.updated_at) ?? info.mtime.toISOString();
    summary.updatedAt = updatedAt;
    summaries.push(summary);
  }
  return finalizeSessionList(summaries, limit) as CodexSessionSummary[];
}

function safeIndex(home: string): Map<string, CodexIndexEntry> {
  const map = new Map<string, CodexIndexEntry>();
  try {
    for (const entry of readSessionIndex(home)) map.set(entry.id, entry);
  } catch {
    // 索引坏了不影响列表
  }
  return map;
}

/** Codex 会把 AGENTS.md / 环境上下文伪装成 user 消息注入，不作为标题 */
const INJECTED_USER_PREFIXES = ['# AGENTS.md instructions for ', '<environment_context>', '<skills_instructions>', '<user_instructions>'];

function firstUserText(lines: CodexLine[]): string | undefined {
  for (const line of lines) {
    if (line.type !== 'response_item') continue;
    const payload = (line.payload ?? {}) as Record<string, unknown>;
    if (payload.type !== 'message' || payload.role !== 'user') continue;
    const content = payload.content;
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if ((record.type === 'input_text' || record.type === 'text') && typeof record.text === 'string') texts.push(record.text);
    }
    const joined = texts.join('\n').replace(/\s+/gu, ' ').trim();
    if (joined.length === 0) continue;
    if (INJECTED_USER_PREFIXES.some((prefix) => joined.startsWith(prefix))) continue;
    return joined.length > 100 ? joined.slice(0, 100) + '…' : joined;
  }
  return undefined;
}

/** rollout-2026-10-16T14-40-28-<uuid>.jsonl 里的本地时间（无时区，按本地时区还原） */
function createdAtFromRolloutName(filePath: string): string | undefined {
  const match = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(filePath);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return undefined;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

async function readRange(filePath: string, start: number, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text: string): CodexLine[] {
  const out: CodexLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value as CodexLine);
    } catch {
      // 坏行/截断行跳过
    }
  }
  return out;
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
