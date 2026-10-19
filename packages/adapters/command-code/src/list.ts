/**
 * Command Code 会话列表（只读元数据，不解析对话全文）。
 *
 * 数据源：~/.commandcode/projects/<slug>/<uuid>.jsonl（+ 同名 .meta.json）
 * - 首行是 session 头：id / timestamp(createdAt) / cwd
 * - .meta.json 里有 title / entrypoint；没有标题时取首条真实 user 文本
 * - 只读文件头 128KB；updatedAt 用文件 mtime（transcript 是追加写的）
 *
 * 容错：projects 目录不存在返回 []；没有合法 v3 头的文件跳过；meta 缺失/损坏不影响列表。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import { commandCodeHome, commandCodeProjectsDir, isCcHeader, isCcTranscriptFileName } from './wire.ts';
import type { CcMetaFile } from './wire.ts';

const HEAD_BYTES = 128 * 1024;

export async function listCommandCodeSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const home = commandCodeHome(options.home);
  const projectsRoot = commandCodeProjectsDir(home);
  const summaries: SessionSummary[] = [];

  for (const project of await readdirSafe(projectsRoot)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projectsRoot, project.name);
    for (const file of await readdirSafe(projectDir)) {
      if (!file.isFile() || !isCcTranscriptFileName(file.name)) continue;
      const summary = await readCcSummary(join(projectDir, file.name));
      if (summary !== undefined) summaries.push(summary);
    }
  }
  return finalizeSessionList(summaries, options.limit);
}

async function readCcSummary(filePath: string): Promise<SessionSummary | undefined> {
  const info = await stat(filePath).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  const stem = basename(filePath).replace(/\.jsonl$/u, '');
  const head = await readRange(filePath, 0, Math.min(info.size, HEAD_BYTES)).catch(() => undefined);
  if (head === undefined) return undefined;
  const records = parseJsonLines(head);
  const header = records.find((record) => isCcHeader(record));
  if (header === undefined) return undefined; // 不是 Command Code v3 transcript

  const meta = await readMeta(join(dirname(filePath), stem + '.meta.json'));
  const summary: SessionSummary = {
    agent: 'command-code',
    sessionId: header.id,
    nativePath: filePath,
    resumeHint: 'command-code -p --session ' + filePath,
  };
  const title = textOf(meta?.title) ?? firstUserText(records);
  if (title !== undefined) summary.title = title;
  const cwd = textOf(header.cwd);
  if (cwd !== undefined) summary.cwd = cwd;
  const createdAt = normalizeIso(header.timestamp);
  if (createdAt !== undefined) summary.createdAt = createdAt;
  summary.updatedAt = info.mtime.toISOString();
  const parentSessionId = textOf(meta?.parentSessionId);
  if (parentSessionId !== undefined) summary.parentSessionId = parentSessionId;
  return summary;
}

async function readMeta(metaPath: string): Promise<CcMetaFile | undefined> {
  try {
    const value = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
    return value !== null && typeof value === 'object' ? (value as CcMetaFile) : undefined;
  } catch {
    return undefined;
  }
}

/** 首条真实用户消息（跳过 isMeta/摘要类注入） */
function firstUserText(records: Array<Record<string, unknown>>): string | undefined {
  for (const record of records) {
    if (record.type !== 'message') continue;
    const message = record.message;
    if (message === null || typeof message !== 'object') continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== 'user') continue;
    const meta = messageRecord.meta;
    if (meta !== null && typeof meta === 'object' && (meta as Record<string, unknown>).isMeta === true) continue;
    const content = messageRecord.content;
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const blockRecord = block as Record<string, unknown>;
        if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') texts.push(blockRecord.text);
      }
    }
    const joined = texts.join('\n').replace(/\s+/gu, ' ').trim();
    if (joined.length === 0) continue;
    if (joined.startsWith('<')) continue;
    return joined.length > 100 ? joined.slice(0, 100) + '…' : joined;
  }
  return undefined;
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

/** 宽松 JSONL 解析：坏行/截断行跳过 */
function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

async function readdirSafe(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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
