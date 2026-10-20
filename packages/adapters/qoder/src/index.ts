/**
 * Qoder CN lister：没有索引/DB，直接扫 ~/.qoder-cn/projects/<projectKey>/*.jsonl。
 *
 * Qoder 自己（qodercli 1.1.69 / SDK listSessions）也是这个策略：
 * - 遍历 projects/* 下所有 .jsonl
 * - 每份文件取 custom-title / ai-title / lastPrompt / summary / 首条 user 文本
 * - 用 mtime 当 updatedAt，按倒序返回；同 id 只保留最新
 * 标题优先级也照抄 SDK 的 Kn()：custom-title|ai-title > lastPrompt > summary > firstPrompt。
 */
import { existsSync } from 'node:fs';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import type { QoderHeadMetadata } from './wire.ts';
import {
  listQoderSessionFiles,
  qoderHome,
  readQoderHeadMetadata,
  textOf,
} from './wire.ts';

export { readQoderSession, parseQoderTranscript, qoderLinesToSession, qoderLinesToBundle, selectActiveQoderLines, printQoderSummary } from './read.ts';
export type { ReadQoderOptions, ConvertQoderOptions, QoderConvertStats, ActiveSelection } from './read.ts';
export { writeQoderSession, printWriteReport, QODER_CAPS } from './write.ts';
export type { WriteQoderOptions, WriteQoderResult } from './write.ts';
export { verifyQoderSession, verifyQoderLines, verifyQoderRoundTrip } from './verify.ts';
export type { VerifyCheck, VerifyQoderReport } from './verify.ts';
export {
  QODER_AGENT,
  QODER_CLI_VERSION,
  QODER_DEFAULT_MODEL,
  clip,
  findQoderSessionFile,
  isQoderSessionId,
  listQoderSessionFiles,
  newQoderSessionId,
  parseQoderLines,
  qoderAssistantText,
  qoderHome,
  qoderProjectDir,
  qoderProjectKey,
  qoderProjectsDir,
  qoderSessionIdFromPath,
  qoderSessionPath,
  qoderThinkingText,
  qoderTimestampToIso,
  qoderToolResult,
  qoderToolResultText,
  qoderToolUse,
  qoderUserText,
  readQoderHead,
  readQoderHeadMetadata,
  readQoderLines,
  readQoderTail,
  resolveQoderSessionPath,
} from './wire.ts';
export type {
  ParsedQoderLines,
  QoderActiveLeafLine,
  QoderAssistantLine,
  QoderAttachmentLine,
  QoderContentBlock,
  QoderHeadMetadata,
  QoderLastPromptLine,
  QoderLine,
  QoderMessage,
  QoderRuntimeConfigLine,
  QoderSessionFile,
  QoderTextLikeBlock,
  QoderTitleLine,
  QoderUserLine,
  QoderWorkspaceDirectoriesLine,
  QoderWorktreeStateLine,
} from './wire.ts';

const metadataCache = new Map<string, { mtimeMs: number; metadata: QoderHeadMetadata }>();

function metadataFor(path: string, mtimeMs: number): QoderHeadMetadata {
  const cached = metadataCache.get(path);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.metadata;
  const metadata = readQoderHeadMetadata(path);
  metadataCache.set(path, { mtimeMs, metadata });
  return metadata;
}

/** 只在反解目录真实存在时才采用，避免 '-' 拆错 */
function cwdFromProjectKey(projectKey: string): string | undefined {
  if (!projectKey.startsWith('-')) return undefined;
  const decoded = '/' + projectKey.slice(1).split('-').join('/');
  return existsSync(decoded) ? decoded : undefined;
}

export async function listQoderSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const home = qoderHome(options.home);
  const files = listQoderSessionFiles(home);
  const byId = new Map<string, SessionSummary>();

  for (const file of files) {
    const meta = metadataFor(file.path, file.mtimeMs);
    const title = textOf(meta.title) ?? textOf(meta.lastPrompt) ?? textOf(meta.firstPrompt);
    const cwd = textOf(meta.cwd) ?? cwdFromProjectKey(file.projectKey);
    const summary: SessionSummary = {
      agent: 'qoder',
      sessionId: file.sessionId,
      nativePath: file.path,
      resumeHint: 'qodercn --resume ' + file.sessionId,
    };
    if (title !== undefined) summary.title = title;
    if (cwd !== undefined) summary.cwd = cwd;
    if (meta.createdAt !== undefined) summary.createdAt = meta.createdAt;
    summary.updatedAt = new Date(file.mtimeMs).toISOString();
    const existing = byId.get(file.sessionId);
    if (existing === undefined || Date.parse(summary.updatedAt) > Date.parse(existing.updatedAt ?? '')) byId.set(file.sessionId, summary);
  }

  return finalizeSessionList([...byId.values()], options.limit);
}
