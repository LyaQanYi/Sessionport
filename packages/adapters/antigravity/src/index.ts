/**
 * Antigravity lister：合并扫描 ~/.gemini/antigravity（App/IDE）与 ~/.gemini/antigravity-cli（agy CLI），
 * 以 brain/<id>/.system_generated/logs/transcript_full.jsonl（回落 transcript.jsonl）为准，
 * 用 conversation_summaries.db 与 annotations/<id>.pbtxt 补充 title/cwd/时间/归档/父子关系。
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import type { AntigravityHeadMetadata, AntigravitySummaryRow } from './wire.ts';
import {
  antigravityDefaultHomes,
  listAntigravityTranscripts,
  readAntigravityAnnotation,
  readAntigravityHeadMetadata,
  readAntigravitySummaries,
  textOf,
} from './wire.ts';

export {
  readAntigravitySession,
  parseAntigravityTranscript,
  antigravityLinesToSession,
  printAntigravitySummary,
} from './read.ts';
export type {
  ReadAntigravityOptions,
  ConvertAntigravityOptions,
  AntigravityConvertStats,
} from './read.ts';
export {
  ANTIGRAVITY_AGENT,
  antigravityAnnotationsDir,
  antigravityBrainDir,
  antigravityDefaultHomes,
  antigravityHome,
  antigravityLogsDir,
  antigravitySummaryDbPath,
  cleanGenericOutput,
  clip,
  extractUserRequestText,
  findAntigravityTranscriptFile,
  inferAntigravityHomeFromPath,
  listAntigravityTranscripts,
  parseAntigravityDbTime,
  parseAntigravityLines,
  readAntigravityAnnotation,
  readAntigravityHeadMetadata,
  readAntigravitySummaries,
  resolveAntigravitySessionPath,
  textOf,
  workspaceUriToPath,
} from './wire.ts';
export type {
  AntigravityAnnotation,
  AntigravityHeadMetadata,
  AntigravityStepLine,
  AntigravitySummaryRow,
  AntigravityToolCall,
  AntigravityTranscriptFile,
  ParsedAntigravityLines,
} from './wire.ts';
export { verifyAntigravitySession, verifyAntigravityBundle } from './verify.ts';
export type { VerifyCheck, VerifyAntigravityReport } from './verify.ts';
export { antigravityAdapter } from './adapter.ts';

const headCache = new Map<string, { mtimeMs: number; metadata: AntigravityHeadMetadata }>();

function headMetadata(path: string, mtimeMs: number): AntigravityHeadMetadata {
  const cached = headCache.get(path);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.metadata;
  const metadata = readAntigravityHeadMetadata(path);
  headCache.set(path, { mtimeMs, metadata });
  return metadata;
}

export async function listAntigravitySessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const homes = antigravityDefaultHomes(options.home);
  const transcripts = listAntigravityTranscripts(homes);

  const summaryByHome = new Map<string, Map<string, AntigravitySummaryRow>>();
  for (const home of homes) {
    summaryByHome.set(home, readAntigravitySummaries(home));
  }

  const summaries: SessionSummary[] = [];
  for (const file of transcripts) {
    const db = summaryByHome.get(file.home)?.get(file.conversationId);
    const ann = readAntigravityAnnotation(file.home, file.conversationId);
    const needsHead =
      textOf(ann?.title) === undefined &&
      textOf(db?.title) === undefined &&
      textOf(db?.preview) === undefined;
    const head = needsHead ? headMetadata(file.path, file.mtimeMs) : undefined;

    const title =
      textOf(ann?.title) ??
      textOf(db?.title) ??
      textOf(db?.preview) ??
      head?.firstUserText;
    const cwd = db?.cwd;
    const createdAt = head?.createdAt;
    const updatedAt = db?.updatedAt ?? new Date(file.mtimeMs).toISOString();
    const archived = ann?.archived ?? db?.archived;

    const summary: SessionSummary = {
      agent: 'antigravity',
      sessionId: file.conversationId,
      nativePath: file.path,
    };
    if (title !== undefined) summary.title = title;
    if (cwd !== undefined) summary.cwd = cwd;
    if (createdAt !== undefined) summary.createdAt = createdAt;
    if (updatedAt !== undefined) summary.updatedAt = updatedAt;
    if (archived === true) summary.archived = true;
    if (db?.parentConversationId !== undefined) summary.parentSessionId = db.parentConversationId;
    summaries.push(summary);
  }

  return finalizeSessionList(summaries, options.limit);
}

/** 只统计（不做全文解析）的轻量信息，CLI/桌面端可用 */
export function antigravityTranscriptInfo(path: string): { conversationId: string; size: number; mtimeMs: number } {
  const info = statSync(path);
  const parts = path.split('/');
  const brainIdx = parts.lastIndexOf('brain');
  const conversationId =
    brainIdx >= 0 && parts[brainIdx + 1] !== undefined
      ? parts[brainIdx + 1]!
      : basename(path).replace(/\.jsonl$/u, '');
  return { conversationId, size: info.size, mtimeMs: info.mtimeMs };
}
