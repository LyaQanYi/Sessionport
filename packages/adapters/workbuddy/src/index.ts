/**
 * WorkBuddy lister：以 projects/<project>/<session>.jsonl 为准，DB 只补元数据。
 *
 * 为什么不反过来用 DB 当主表：本机 13 条 sessions 里有 1 条云会话没有 transcript，
 * 而 12 条本地会话虽然 deleted_at 有墓碑值，transcript 仍然完整可读。
 * 列表的目标是「能读的会话」，所以文件是主表，deleted_at 映射为 archived。
 */
import { statSync } from 'node:fs';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import type { WorkBuddyHeadMetadata } from './wire.ts';
import {
  listWorkBuddyTranscripts,
  readWorkBuddyDbSessions,
  readWorkBuddyHeadMetadata,
  textOf,
  workBuddyHome,
} from './wire.ts';

export { readWorkBuddySession, parseWorkBuddyTranscript, workBuddyLinesToSession, printWorkBuddySummary } from './read.ts';
export type { ReadWorkBuddyOptions, ConvertWorkBuddyOptions, WorkBuddyConvertStats } from './read.ts';
export {
  WORKBUDDY_AGENT,
  clip,
  extractWorkBuddyUserText,
  findWorkBuddySessionFile,
  listWorkBuddySubagentFiles,
  listWorkBuddyTranscripts,
  parseWorkBuddyLines,
  readWorkBuddyDbSessions,
  readWorkBuddyHeadMetadata,
  readWorkBuddyTranscript,
  resolveWorkBuddySessionPath,
  workBuddyDbPath,
  workBuddyHome,
  workBuddyProjectKey,
  workBuddyProjectsDir,
  workBuddySessionFile,
} from './wire.ts';
export type {
  ParsedLines,
  WbAiTitleLine,
  WbContentBlock,
  WbDbSession,
  WbFileHistoryLine,
  WbFunctionCallLine,
  WbFunctionCallResultLine,
  WbLine,
  WbMessageLine,
  WbProviderData,
  WbReasoningLine,
  WbResendForkLine,
  WbSessionMetaLine,
  WorkBuddyHeadMetadata,
  WorkBuddyLine,
  WorkBuddyTranscriptFile,
} from './wire.ts';
export { verifyWorkBuddySession, verifyWorkBuddyBundle } from './verify.ts';
export type { VerifyCheck, VerifyWorkBuddyReport } from './verify.ts';

const headCache = new Map<string, { mtimeMs: number; metadata: WorkBuddyHeadMetadata }>();

function headMetadata(path: string, mtimeMs: number): WorkBuddyHeadMetadata {
  const cached = headCache.get(path);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.metadata;
  const metadata = readWorkBuddyHeadMetadata(path);
  headCache.set(path, { mtimeMs, metadata });
  return metadata;
}

export async function listWorkBuddySessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const home = workBuddyHome(options.home);
  const transcripts = listWorkBuddyTranscripts(home);
  const dbRows = await readWorkBuddyDbSessions(home);
  const summaries: SessionSummary[] = [];

  for (const file of transcripts) {
    const db = dbRows.get(file.sessionId);
    const needsHead = db?.title === undefined || db.cwd === undefined;
    const head = needsHead ? headMetadata(file.path, file.mtimeMs) : undefined;
    const title = textOf(db?.customTitle) ?? textOf(db?.title) ?? head?.title ?? head?.firstUserText;
    const cwd = textOf(db?.cwd) ?? head?.cwd;
    const createdAt = db?.createdAt ?? head?.createdAt;
    const updatedAt = db?.updatedAt ?? db?.lastActivityAt ?? new Date(file.mtimeMs).toISOString();
    const summary: SessionSummary = {
      agent: 'workbuddy',
      sessionId: file.sessionId,
      nativePath: file.path,
    };
    if (title !== undefined) summary.title = title;
    if (cwd !== undefined) summary.cwd = cwd;
    if (createdAt !== undefined) summary.createdAt = createdAt;
    if (updatedAt !== undefined) summary.updatedAt = updatedAt;
    if (db?.archived === true) summary.archived = true;
    summaries.push(summary);
  }

  // 没有 DB 的机器：只靠文件头也能列出（title 可能缺失，仍可用 sessionId 打开）
  return finalizeSessionList(summaries, options.limit);
}

/** 只统计（不做 IO 校验）的轻量信息，CLI/桌面端可用 */
export function workBuddyTranscriptInfo(path: string): { sessionId: string; size: number; mtimeMs: number } {
  const info = statSync(path);
  const base = path.split('/').pop() ?? path;
  return { sessionId: base.replace(/\.jsonl$/, ''), size: info.size, mtimeMs: info.mtimeMs };
}