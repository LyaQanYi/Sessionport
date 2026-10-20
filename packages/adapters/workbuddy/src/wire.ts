/**
 * WorkBuddy（腾讯 CodeBuddy 桌面端，5.8.x）本机存储格式。
 *
 * 实测（2026-10-20，macOS）：
 * - 会话正文：~/.workbuddy/projects/<slug>/<sessionId>.jsonl
 *   slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')，与 Claude Code 的项目目录规则一致
 * - 子代理：<projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl
 * - 元数据：~/.workbuddy/workbuddy.db 的 sessions 表（只读；正文不在库里）
 * - 附件/快照：file-history-snapshot、credit-usage 等行只做诊断，不进 IR
 *
 * 行格式是 OpenAI Responses API 风格（不是 Anthropic）：
 *   { type:'message', role:'user', content:[{type:'input_text',text}] }
 *   { type:'message', role:'assistant', content:[{type:'output_text',text}] }
 *   { type:'reasoning', rawContent:[{type:'reasoning_text',text}] }
 *   { type:'function_call', callId, name, arguments:'<json string>' }
 *   { type:'function_call_result', callId, name, status, output }
 * 另有 session-meta / ai-title / file-history-snapshot / credit-usage / resend-fork-notice。
 *
 * 注意：DB 里的 deleted_at 对本机 12 个可读会话全部有值（UI 侧删除/关闭的墓碑），
 * 但 transcript 仍完整保留，因此 lister 以文件为准、deleted_at 只映射成 archived。
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentId } from '@sessionport/core';

/** core 的 AgentId 已包含 workbuddy（2026-10-20 由 Lead 扩展） */
export const WORKBUDDY_AGENT: AgentId = 'workbuddy';

export interface WbContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface WbProviderData {
  agent?: string;
  model?: string;
  requestModelId?: string;
  requestModelName?: string;
  conversationRequestId?: string;
  messageId?: string;
  stepSeq?: number;
  traceId?: string;
  error?: { message?: string; [key: string]: unknown };
  skipRun?: boolean;
  teammateMessage?: unknown;
  usage?: unknown;
  rawUsage?: unknown;
  [key: string]: unknown;
}

export interface WbLine {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: number;
  sessionId?: string;
  cwd?: string;
  providerData?: WbProviderData;
  [key: string]: unknown;
}

export interface WbSessionMetaLine extends WbLine {
  type: 'session-meta';
  meta?: Record<string, unknown>;
}

export interface WbMessageLine extends WbLine {
  type: 'message';
  role?: 'user' | 'assistant' | string;
  content?: WbContentBlock[];
  status?: string;
  message?: { usage?: unknown; [key: string]: unknown };
}

export interface WbReasoningLine extends WbLine {
  type: 'reasoning';
  content?: WbContentBlock[];
  rawContent?: WbContentBlock[];
}

export interface WbFunctionCallLine extends WbLine {
  type: 'function_call';
  callId?: string;
  name?: string;
  arguments?: string;
  message?: Record<string, unknown>;
}

export interface WbFunctionCallResultLine extends WbLine {
  type: 'function_call_result';
  callId?: string;
  name?: string;
  status?: string;
  output?: unknown;
}

export interface WbAiTitleLine extends WbLine {
  type: 'ai-title';
  aiTitle?: string;
}

export interface WbFileHistoryLine extends WbLine {
  type: 'file-history-snapshot';
  messageId?: string;
  isSnapshotUpdate?: boolean;
  snapshot?: Record<string, unknown>;
}

export interface WbResendForkLine extends WbLine {
  type: 'resend-fork-notice';
  editedUserItemId?: string;
}

export type WorkBuddyLine =
  | WbSessionMetaLine
  | WbMessageLine
  | WbReasoningLine
  | WbFunctionCallLine
  | WbFunctionCallResultLine
  | WbAiTitleLine
  | WbFileHistoryLine
  | WbResendForkLine
  | WbLine;

/** DB sessions 表里与列表/元数据相关的列（正文不在 DB） */
export interface WbDbSession {
  id: string;
  cwd?: string;
  title?: string;
  customTitle?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  archived: boolean;
  model?: string;
  mode?: string;
  transport?: string;
}

export interface WorkBuddyTranscriptFile {
  sessionId: string;
  projectKey: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface WorkBuddyHeadMetadata {
  title?: string;
  cwd?: string;
  createdAt?: string;
  firstUserText?: string;
  model?: string;
}

export function workBuddyHome(explicit?: string): string {
  const raw = explicit ?? process.env.SESSIONPORT_WORKBUDDY_HOME ?? process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy');
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function workBuddyDbPath(home: string): string {
  return join(home, 'workbuddy.db');
}

export function workBuddyProjectsDir(home: string): string {
  return join(home, 'projects');
}

/** 与本机 projects 目录名实测一致：斜杠/点/下划线全部替换成 '-' */
export function workBuddyProjectKey(cwd: string): string {
  return cwd.replace(/\/+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

export function workBuddySessionFile(home: string, cwd: string, sessionId: string): string {
  return join(workBuddyProjectsDir(home), workBuddyProjectKey(cwd), sessionId + '.jsonl');
}

export function listWorkBuddyTranscripts(home: string): WorkBuddyTranscriptFile[] {
  const projects = workBuddyProjectsDir(home);
  if (!existsSync(projects)) return [];
  const out: WorkBuddyTranscriptFile[] = [];
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(projects, entry.name);
    let names: string[];
    try {
      names = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (sessionId.length === 0) continue;
      const path = join(projectDir, name);
      try {
        const info = statSync(path);
        out.push({ sessionId, projectKey: entry.name, path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // 文件刚被删/没权限：跳过
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function listWorkBuddySubagentFiles(sessionFile: string): string[] {
  const dir = join(sessionFile.slice(0, -'.jsonl'.length), 'subagents');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('agent-') && name.endsWith('.jsonl')) out.push(join(dir, name));
  }
  return out.sort();
}

export function findWorkBuddySessionFile(home: string, sessionId: string): string | undefined {
  const direct = listWorkBuddyTranscripts(home).find((file) => file.sessionId === sessionId);
  if (direct !== undefined) return direct.path;
  // sessionId 可能带 projectKey 前缀或本身就是相对路径
  const projects = workBuddyProjectsDir(home);
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projects, entry.name, sessionId + '.jsonl');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveWorkBuddySessionPath(input: string, home: string): string {
  const raw = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  if (existsSync(raw)) {
    const info = statSync(raw);
    if (info.isFile()) return raw;
    if (info.isDirectory()) {
      const base = raw.replace(/\/+$/, '');
      const named = join(base, base.split('/').pop()! + '.jsonl');
      if (existsSync(named)) return named;
      const candidates = readdirSync(base).filter((name: string) => name.endsWith('.jsonl'));
      if (candidates.length === 1) return join(base, candidates[0]!);
      if (candidates.length > 1) throw new Error('目录里有多个 .jsonl，请直接传文件路径: ' + raw);
    }
  }
  const found = findWorkBuddySessionFile(home, input);
  if (found !== undefined) return found;
  throw new Error('找不到 WorkBuddy 会话: ' + input + '（home=' + home + '）');
}

export interface ParsedLines {
  lines: WorkBuddyLine[];
  badLines: number;
  totalLines: number;
}

/** 宽松 JSONL：坏行只计数，不阻断（App 写入过程可能留下半行） */
export function parseWorkBuddyLines(text: string): ParsedLines {
  const lines: WorkBuddyLine[] = [];
  let badLines = 0;
  let totalLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    totalLines += 1;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) lines.push(value as WorkBuddyLine);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines, totalLines };
}

export function readWorkBuddyTranscript(path: string): ParsedLines {
  return parseWorkBuddyLines(readFileSync(path, 'utf8'));
}

export function readFileText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function workBuddyMsToIso(value: unknown): string | undefined {
  const ms = typeof value === 'bigint' ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function numberOf(value: unknown): number | undefined {
  const n = typeof value === 'bigint' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 只读 sessions 表；DB 不存在/没权限/没表都返回空 Map（不阻断文件读取） */
export async function readWorkBuddyDbSessions(home: string): Promise<Map<string, WbDbSession>> {
  const out = new Map<string, WbDbSession>();
  const dbPath = workBuddyDbPath(home);
  if (!existsSync(dbPath)) return out;
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    const sqlite = await import('node:sqlite');
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
    if (table === undefined) return out;
    const columns = new Set<string>();
    for (const row of db.prepare('PRAGMA table_info(sessions)').all() as Array<Record<string, unknown>>) {
      if (typeof row['name'] === 'string') columns.add(row['name']);
    }
    const wanted = [
      'cwd',
      'title',
      'custom_title',
      'status',
      'created_at',
      'updated_at',
      'last_activity_at',
      'deleted_at',
      'model',
      'mode',
      'transport',
    ].filter((name) => columns.has(name));
    const select = ['id', ...wanted].join(', ');
    const rows = db.prepare('SELECT ' + select + ' FROM sessions').all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = textOf(row['id']);
      if (id === undefined) continue;
      const deletedAt = numberOf(row['deleted_at']);
      const rowOut: WbDbSession = { id, archived: deletedAt !== undefined && deletedAt > 0 };
      const cwd = textOf(row['cwd']);
      if (cwd !== undefined) rowOut.cwd = cwd;
      const title = textOf(row['title']);
      if (title !== undefined) rowOut.title = title;
      const customTitle = textOf(row['custom_title']);
      if (customTitle !== undefined) rowOut.customTitle = customTitle;
      const status = textOf(row['status']);
      if (status !== undefined) rowOut.status = status;
      const createdAt = workBuddyMsToIso(row['created_at']);
      if (createdAt !== undefined) rowOut.createdAt = createdAt;
      const updatedAt = workBuddyMsToIso(row['updated_at']);
      if (updatedAt !== undefined) rowOut.updatedAt = updatedAt;
      const lastActivityAt = workBuddyMsToIso(row['last_activity_at']);
      if (lastActivityAt !== undefined) rowOut.lastActivityAt = lastActivityAt;
      const model = textOf(row['model']);
      if (model !== undefined) rowOut.model = model;
      const mode = textOf(row['mode']);
      if (mode !== undefined) rowOut.mode = mode;
      const transport = textOf(row['transport']);
      if (transport !== undefined) rowOut.transport = transport;
      out.set(id, rowOut);
    }
  } catch {
    return out;
  } finally {
    try {
      db?.close();
    } catch {
      // 已关闭
    }
  }
  return out;
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/i;
const INJECTED_PREFIX = /^<(?:system-reminder|teammate-message|task-notification|local-command|user_info)\b/i;

/**
 * WorkBuddy 会把自己的上下文塞进 user 消息：
 *   <system-reminder ...>...</system-reminder><user_query>真正的问题</user_query>
 * 读进 IR 时抽出 <user_query>，纯注入消息（tool-hint 等）标记 synthetic。
 */
export function extractWorkBuddyUserText(raw: string): { text: string; synthetic: boolean } {
  const match = USER_QUERY.exec(raw);
  if (match !== null) {
    const inner = (match[1] ?? '').trim();
    if (inner.length > 0) return { text: inner, synthetic: false };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 0 && INJECTED_PREFIX.test(trimmed)) return { text: trimmed, synthetic: true };
  return { text: raw, synthetic: false };
}

/** 宽容读取文件头部，够拿标题/首条用户消息/cwd 即可（列表不读全文） */
export function readWorkBuddyHead(path: string, bytes = 256 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** 列表用轻量元数据：ai-title / cwd / 首条真实 user 文本 / 时间戳 */
export function readWorkBuddyHeadMetadata(path: string): WorkBuddyHeadMetadata {
  const head = readWorkBuddyHead(path);
  const parsed = parseWorkBuddyLines(head);
  const out: WorkBuddyHeadMetadata = {};
  for (const line of parsed.lines) {
    const cwd = textOf(line.cwd);
    if (out.cwd === undefined && cwd !== undefined) out.cwd = cwd;
    if (out.createdAt === undefined) out.createdAt = workBuddyMsToIso(line.timestamp);
    if (line.type === 'ai-title') {
      const title = textOf((line as WbAiTitleLine).aiTitle);
      if (title !== undefined) out.title = title;
    }
    if (out.firstUserText === undefined && line.type === 'message' && (line as WbMessageLine).role === 'user') {
      const message = line as WbMessageLine;
      const texts = (message.content ?? [])
        .filter((block) => block.type === 'input_text' || block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('\n');
      if (texts.length > 0) {
        const extracted = extractWorkBuddyUserText(texts);
        if (!extracted.synthetic) out.firstUserText = clip(extracted.text, 100);
      }
    }
    if (out.model === undefined && typeof line.providerData?.model === 'string') out.model = line.providerData.model;
  }
  return out;
}

export function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max).trimEnd() + '…';
}
