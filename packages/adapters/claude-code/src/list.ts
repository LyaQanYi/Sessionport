/**
 * Claude Code 会话列表（只读元数据，不解析对话全文）。
 *
 * 数据源：<CLAUDE_CONFIG_DIR>/projects/<slug>/<uuid>.jsonl（默认 ~/.claude）
 * - 每个会话一个 JSONL，行内自带会话级元数据：
 *   custom-title（用户命名）/ agent-name / cwd / timestamp；没有标题行时取首条真实 user 文本
 * - 为了轻量，只读文件头 256KB（找标题/元数据）+ 文件尾 64KB（补重命名后的标题与末条时间戳）
 * - 整段对话不解析；坏行只跳过
 *
 * 容错：projects 目录不存在返回 []；单个文件读失败/没有合法行只跳过该文件。
 */
import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import { claudeConfigDir, projectsDir } from './paths.ts';

/** 会话文件头的元数据通常出现在前几十行；256KB 足够覆盖 attachment 很多的长会话 */
const HEAD_BYTES = 256 * 1024;
/** 重命名标题可能追加在文件尾部，补扫一段 */
const TAIL_BYTES = 64 * 1024;

export async function listClaudeSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const configDir = claudeConfigDir(options.home);
  const root = projectsDir(configDir);
  const summaries: SessionSummary[] = [];

  for (const project of await readdirSafe(root)) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    for (const file of await readdirSafe(projectPath)) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const summary = await readClaudeSummary(join(projectPath, file.name), project.name);
      if (summary !== undefined) summaries.push(summary);
    }
  }
  return finalizeSessionList(summaries, options.limit);
}

interface ClaudeHeadMeta {
  customTitle?: string;
  agentName?: string;
  cwd?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  firstUserText?: string;
}

async function readClaudeSummary(filePath: string, slug: string): Promise<SessionSummary | undefined> {
  const info = await stat(filePath).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  const sessionId = basename(filePath).replace(/\.jsonl$/u, '');

  const head = await readRange(filePath, 0, Math.min(info.size, HEAD_BYTES)).catch(() => undefined);
  if (head === undefined) return undefined;
  const headLines = parseJsonLines(head);
  if (headLines.length === 0) return undefined; // 不是 transcript（或全坏），跳过

  const headMeta = extractHeadMeta(headLines);
  let tailMeta: ClaudeHeadMeta | undefined;
  if (info.size > HEAD_BYTES) {
    const tailStart = Math.max(0, info.size - TAIL_BYTES);
    const tail = await readRange(filePath, tailStart, TAIL_BYTES).catch(() => '');
    if (tail.length > 0) tailMeta = extractHeadMeta(parseJsonLines(tail));
  }

  const summary: SessionSummary = {
    agent: 'claude-code',
    sessionId,
    nativePath: filePath,
    resumeHint: 'claude --resume ' + sessionId,
  };
  const title = headMeta.customTitle ?? tailMeta?.customTitle ?? headMeta.agentName ?? tailMeta?.agentName ?? headMeta.firstUserText ?? tailMeta?.firstUserText;
  if (title !== undefined) summary.title = title;
  const cwd = headMeta.cwd ?? tailMeta?.cwd ?? cwdFromSlug(slug);
  if (cwd !== undefined) summary.cwd = cwd;
  const createdAt = headMeta.firstTimestamp;
  if (createdAt !== undefined) summary.createdAt = createdAt;
  const updatedAt = tailMeta?.lastTimestamp ?? headMeta.lastTimestamp ?? info.mtime.toISOString();
  summary.updatedAt = updatedAt;
  return summary;
}

function extractHeadMeta(lines: Array<Record<string, unknown>>): ClaudeHeadMeta {
  const meta: ClaudeHeadMeta = {};
  for (const line of lines) {
    const type = typeof line.type === 'string' ? line.type : '';
    if (type === 'custom-title') {
      const title = textOf(line.customTitle);
      if (title !== undefined && meta.customTitle === undefined) meta.customTitle = title;
    } else if (type === 'agent-name') {
      const name = textOf(line.agentName);
      if (name !== undefined && meta.agentName === undefined) meta.agentName = name;
    }
    const cwd = textOf(line.cwd);
    if (cwd !== undefined && cwd.startsWith('/') && meta.cwd === undefined) meta.cwd = cwd;
    const timestamp = normalizeIso(line.timestamp);
    if (timestamp !== undefined) {
      if (meta.firstTimestamp === undefined) meta.firstTimestamp = timestamp;
      meta.lastTimestamp = timestamp;
    }
    if (type === 'user' && meta.firstUserText === undefined) {
      const text = firstUserText(line);
      if (text !== undefined) meta.firstUserText = text;
    }
  }
  return meta;
}

/** 首条“真实”用户消息（跳过 sidechain / meta / 工具结果回灌 / 注入指令） */
function firstUserText(line: Record<string, unknown>): string | undefined {
  if (line.isSidechain === true || line.isMeta === true) return undefined;
  if (line.toolUseResult !== undefined) return undefined;
  const message = line.message;
  if (message === null || typeof message !== 'object') return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== 'user') return undefined;
  const content = record.content;
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
  if (joined.length === 0) return undefined;
  // <system-reminder> / <local-command-caveat> / [Request interrupted by user] 不是对话主题
  if (joined.startsWith('<') || joined.startsWith('[Request interrupted')) return undefined;
  return clip(joined, 100);
}

/**
 * slug 反解 cwd：-Users-me-Documents-Coding -> /Users/me/Documents/Coding。
 * 目录名里的 '-' 会被误拆，所以只在反解结果真实存在时才采用。
 */
function cwdFromSlug(slug: string): string | undefined {
  if (!slug.startsWith('-')) return undefined;
  const decoded = '/' + slug.slice(1).split('-').join('/');
  return existsSync(decoded) ? decoded : undefined;
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

/** 宽松 JSONL 解析：坏行跳过（head/tail 截断导致的半行也会自然失败） */
function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // 坏行/截断行跳过
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

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
