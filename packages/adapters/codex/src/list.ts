/**
 * Codex 会话列表（只读元数据，不解析对话全文）。
 *
 * 数据源：<CODEX_HOME>/{sessions,archived_sessions}/YYYY/MM/DD/rollout-*.jsonl(.zst)（默认 ~/.codex）
 * - 自动将同一线程的分页段（rollout-<ts>-<threadId>_<segId>.jsonl.zst）聚合为 1 条会话
 * - 标题优先取 state_5.sqlite 的 threads.name / session_index.jsonl 的 thread_name / 首条真实用户消息
 * - 默认过滤 subagent 与 guardian_review 后台线程（传 includeChildren: true 时一并列出）
 * - 兼容：返回值额外保留 id/path 两个旧字段（桌面端兜底代码在用），语义等同 sessionId/nativePath。
 */
import { stat } from 'node:fs/promises';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import type { CodexIndexEntry, CodexLine, CodexSessionMeta } from './wire.ts';
import {
  archivedSessionsRoot,
  classifyCodexThread,
  codexHome,
  isCodexInjectedUserText,
  listRolloutFiles,
  readRolloutHead,
  readSessionIndex,
  readStateThreads,
  rolloutTimestampFromPath,
  sessionIdFromRolloutPath,
} from './wire.ts';

export interface CodexSessionSummary extends SessionSummary {
  /** @deprecated 用 sessionId（兼容桌面端旧兜底代码） */
  id: string;
  /** @deprecated 用 nativePath（兼容桌面端旧兜底代码） */
  path: string;
}

interface RolloutSegment {
  filePath: string;
  mtimeMs: number;
  nameTimestamp?: number;
}

export async function listCodexSessions(options: ListSessionsOptions | string = {}): Promise<CodexSessionSummary[]> {
  const home = codexHome(typeof options === 'string' ? options : options.home);
  const limit = typeof options === 'string' ? undefined : options.limit;
  const includeChildren = typeof options === 'string' ? false : options.includeChildren === true;
  const index = safeIndex(home);
  const stateThreads = readStateThreads(home);
  const archivedDirPrefix = archivedSessionsRoot(home) + '/';

  const grouped = new Map<string, RolloutSegment[]>();
  for (const filePath of listRolloutFiles(home)) {
    const info = await stat(filePath).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    const threadId = sessionIdFromRolloutPath(filePath) ?? filePath;
    const list = grouped.get(threadId) ?? [];
    list.push({
      filePath,
      mtimeMs: info.mtimeMs,
      nameTimestamp: rolloutTimestampFromPath(filePath),
    });
    grouped.set(threadId, list);
  }

  const summaries: CodexSessionSummary[] = [];
  for (const [threadId, segments] of grouped) {
    segments.sort((a, b) => {
      const aTime = a.nameTimestamp ?? a.mtimeMs;
      const bTime = b.nameTimestamp ?? b.mtimeMs;
      if (aTime !== bTime) return aTime - bTime;
      return a.mtimeMs - b.mtimeMs;
    });
    const firstFile = segments[0]!;
    const latestFile = segments[segments.length - 1]!;
    const head = await readRolloutHead(firstFile.filePath).catch(() => '');
    const lines = parseJsonLines(head);
    const meta = lines.find((line) => line.type === 'session_meta')?.payload as CodexSessionMeta | undefined;
    const stateRow = stateThreads.get(threadId);
    const classification = classifyCodexThread(meta, stateRow);
    // Guardian 内部后台审查永远不展示；subagent 仅在 includeChildren=true 时作为子节点返回
    if (classification.isGuardian) continue;
    if (!includeChildren && classification.isSubagent) continue;

    const indexEntry = index.get(threadId);
    const summary: CodexSessionSummary = {
      agent: 'codex',
      sessionId: threadId,
      id: threadId,
      nativePath: latestFile.filePath,
      path: latestFile.filePath,
      resumeHint: 'codex exec resume ' + threadId,
    };

    const rawUserTitle = firstUserText(lines);
    let title =
      textOf(stateRow?.name) ??
      textOf(indexEntry?.thread_name) ??
      textOf(stateRow?.title);
    if (title === undefined) {
      if (classification.isSubagent && classification.agentLabel !== undefined) {
        title = rawUserTitle !== undefined ? classification.agentLabel + ' · ' + rawUserTitle : classification.agentLabel;
      } else {
        title = rawUserTitle;
      }
    }
    if (title !== undefined) summary.title = title;

    const cwd = textOf(meta?.cwd) ?? textOf(stateRow?.cwd);
    if (cwd !== undefined) summary.cwd = cwd;

    const createdAt =
      normalizeIso(meta?.timestamp) ??
      msToIso(stateRow?.createdAtMs ?? (stateRow?.createdAt !== undefined ? stateRow.createdAt * 1000 : undefined)) ??
      createdAtFromRolloutName(firstFile.filePath);
    if (createdAt !== undefined) summary.createdAt = createdAt;

    const updatedAt =
      msToIso(stateRow?.updatedAtMs) ??
      normalizeIso(indexEntry?.updated_at) ??
      msToIso(stateRow?.updatedAt !== undefined ? stateRow.updatedAt * 1000 : undefined) ??
      new Date(latestFile.mtimeMs).toISOString();
    summary.updatedAt = updatedAt;

    if (stateRow?.archived === true || latestFile.filePath.startsWith(archivedDirPrefix)) {
      summary.archived = true;
    }
    if (includeChildren && classification.parentThreadId !== undefined) {
      summary.parentSessionId = classification.parentThreadId;
    }
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
    if (isCodexInjectedUserText(joined)) continue;
    return joined.length > 100 ? joined.slice(0, 100) + '…' : joined;
  }
  return undefined;
}

/** rollout-2026-10-16T14-40-28-<uuid>.jsonl(.zst) 里的本地时间（无时区，按本地时区还原） */
function createdAtFromRolloutName(filePath: string): string | undefined {
  const ms = rolloutTimestampFromPath(filePath);
  return ms !== undefined ? new Date(ms).toISOString() : undefined;
}

function msToIso(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
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
