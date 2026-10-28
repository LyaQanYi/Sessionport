/**
 * Qoder CN（阿里 Qoder，SDK qodercli 1.1.69）本机会话格式。
 *
 * 实测（2026-10-20，macOS，Qoder CN 0.4.8 / qodercli 1.1.69）：
 * - 路径：~/.qoder-cn/projects/<projectKey>/<sessionId>.jsonl
 *   projectKey = cwd.replace(/[^a-zA-Z0-9]/g,'-')（超长路径再拼 djb2 base36 后缀）
 * - 没有索引/DB：Qoder 的 listSessions 直接扫 projects/*，读每个 *.jsonl 的
 *   custom-title/ai-title/lastPrompt/summary/首条 user 文本 + mtime（见 verify 文档）
 * - 每行一个 JSON；assistant 的每个 content block 单独占一行，共用 message.id
 * - parentUuid 是树：tool_result 的 parent 指向包含对应 tool_use 的那一行，而不是上一行
 * - active-leaf 记录当前分支的叶子，Qoder 读会话时从它回溯 parentUuid
 *
 * 行类型：workspace-directories / runtime-config / worktree-state / user / assistant /
 *         attachment / active-leaf / last-prompt（另有 custom-title/ai-title/system/progress）
 *
 * 这里只做解析与路径规则，不做 IR 映射。
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentId } from '@sessionport/core';

/** core 的 AgentId 已包含 qoder（2026-10-20 由 Lead 扩展） */
export const QODER_AGENT: AgentId = 'qoder';

export const QODER_CLI_VERSION = '1.1.69';
export const QODER_DEFAULT_MODEL = 'qfmodel';

export type QoderContentBlock =
  | { type: 'text'; text?: string; citations?: unknown; [key: string]: unknown }
  | { type: 'thinking'; thinking?: string; signature?: string; [key: string]: unknown }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown; [key: string]: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: string | QoderTextLikeBlock[]; is_error?: boolean; [key: string]: unknown }
  | { type: 'redacted_thinking'; data?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface QoderTextLikeBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface QoderMessage {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  /** 真实子代理 transcript 的首条 user 用字符串 content（主会话用 block 数组） */
  content?: string | QoderContentBlock[];
  usage?: unknown;
  [key: string]: unknown;
}

export interface QoderLineBase {
  type?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string | number;
  cwd?: string;
  version?: string;
  entrypoint?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  [key: string]: unknown;
}

export interface QoderWorkspaceDirectoriesLine extends QoderLineBase {
  type: 'workspace-directories';
  directories?: string[];
}

export interface QoderRuntimeConfigLine extends QoderLineBase {
  type: 'runtime-config';
  model?: string;
  reasoningEffort?: string | null;
  contextWindow?: number | null;
  generation?: string | null;
}

export interface QoderWorktreeStateLine extends QoderLineBase {
  type: 'worktree-state';
  worktreeSession?: unknown;
}

export interface QoderUserLine extends QoderLineBase {
  type: 'user';
  message?: QoderMessage;
  humanInput?: { text?: string; mode?: string; [key: string]: unknown };
  origin?: { kind?: string; [key: string]: unknown };
  promptId?: string;
  requestSetId?: string;
  permissionMode?: string;
  businessModelKey?: string;
  userType?: string;
  sourceToolAssistantUUID?: string;
  toolUseResult?: Record<string, unknown>;
}

export interface QoderAssistantLine extends QoderLineBase {
  type: 'assistant';
  message?: QoderMessage;
  requestTokenAnchor?: { request?: string; response?: string; requestId?: string; [key: string]: unknown };
  userType?: string;
}

export interface QoderAttachmentLine extends QoderLineBase {
  type: 'attachment';
  attachment?: { type?: string; content?: string; [key: string]: unknown };
}

export interface QoderActiveLeafLine extends QoderLineBase {
  type: 'active-leaf';
  leafUuid?: string | null;
  explicit?: boolean;
}

export interface QoderLastPromptLine extends QoderLineBase {
  type: 'last-prompt';
  lastPrompt?: string;
}

export interface QoderTitleLine extends QoderLineBase {
  type: 'custom-title' | 'ai-title';
  customTitle?: string;
  aiTitle?: string;
}

export type QoderLine =
  | QoderWorkspaceDirectoriesLine
  | QoderRuntimeConfigLine
  | QoderWorktreeStateLine
  | QoderUserLine
  | QoderAssistantLine
  | QoderAttachmentLine
  | QoderActiveLeafLine
  | QoderLastPromptLine
  | QoderTitleLine
  | QoderLineBase;

export interface QoderSessionFile {
  sessionId: string;
  projectKey: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface QoderHeadMetadata {
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  cwd?: string;
  createdAt?: string;
  model?: string;
  gitBranch?: string;
}

export function qoderHome(explicit?: string): string {
  const raw = explicit ?? process.env.SESSIONPORT_QODER_HOME ?? process.env.QODERCN_CONFIG_DIR ?? process.env.QODER_CONFIG_DIR ?? join(homedir(), '.qoder-cn');
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function qoderProjectsDir(home: string): string {
  return join(home, 'projects');
}

export function isQoderSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function djb2(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = hash * 33 ^ text.charCodeAt(index);
  return hash;
}

/** 与 SDK 的 N(cwd) 完全一致：非字母数字 -> '-'；超过 200 字符追加 djb2 base36 */
export function qoderProjectKey(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '');
  const key = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length <= 200) return key;
  return key.slice(0, 200) + '-' + Math.abs(djb2(normalized)).toString(36);
}

export function qoderProjectDir(home: string, cwd: string): string {
  return join(qoderProjectsDir(home), qoderProjectKey(cwd));
}

export function qoderSessionPath(home: string, cwd: string, sessionId: string): string {
  return join(qoderProjectDir(home, cwd), sessionId + '.jsonl');
}

/** <projectDir>/<sessionId>：主 transcript 的伴生目录（子代理、压缩快照） */
export function qoderSessionDir(home: string, cwd: string, sessionId: string): string {
  return join(qoderProjectDir(home, cwd), sessionId);
}

/** <projectDir>/<sessionId>/subagents：Qoder 原生子代理 transcript 目录 */
export function qoderSubagentsDir(home: string, cwd: string, sessionId: string): string {
  return join(qoderSessionDir(home, cwd, sessionId), 'subagents');
}

/** <sessionId>/subagents/agent-<agentId>.jsonl（agentId 原样拼入文件名） */
export function qoderSubagentPath(home: string, cwd: string, sessionId: string, agentId: string): string {
  return join(qoderSubagentsDir(home, cwd, sessionId), 'agent-' + agentId + '.jsonl');
}

/** <sessionId>/subagents/agent-<agentId>.meta.json（Qoder SDK 从这里读 toolUseId/parentAgentId） */
export function qoderSubagentMetaPath(home: string, cwd: string, sessionId: string, agentId: string): string {
  return join(qoderSubagentsDir(home, cwd, sessionId), 'agent-' + agentId + '.meta.json');
}

export function listQoderSessionFiles(home: string): QoderSessionFile[] {
  const projects = qoderProjectsDir(home);
  if (!existsSync(projects)) return [];
  const out: QoderSessionFile[] = [];
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
      if (!isQoderSessionId(sessionId)) continue;
      const path = join(projectDir, name);
      try {
        const info = statSync(path);
        out.push({ sessionId, projectKey: entry.name, path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // 忽略刚被删的文件
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findQoderSessionFile(home: string, sessionId: string): string | undefined {
  const projects = qoderProjectsDir(home);
  if (!existsSync(projects)) return undefined;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projects, entry.name, sessionId + '.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function resolveQoderSessionPath(input: string, home: string): string {
  const raw = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  if (existsSync(raw)) {
    const info = statSync(raw);
    if (info.isFile()) return raw;
    if (info.isDirectory()) {
      const base = raw.replace(/\/+$/, '');
      const named = join(base, base.split('/').pop()! + '.jsonl');
      if (existsSync(named)) return named;
      const candidates = readdirSync(base).filter((name: string) => isQoderSessionId(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl'));
      if (candidates.length === 1) return join(base, candidates[0]!);
      if (candidates.length > 1) throw new Error('目录里有多个 Qoder 会话，请直接传文件路径: ' + raw);
    }
  }
  const found = findQoderSessionFile(home, input);
  if (found !== undefined) return found;
  throw new Error('找不到 Qoder 会话: ' + input + '（home=' + home + '）');
}

export interface ParsedQoderLines {
  lines: QoderLine[];
  badLines: number;
  totalLines: number;
}

export function parseQoderLines(text: string): ParsedQoderLines {
  const lines: QoderLine[] = [];
  let badLines = 0;
  let totalLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    totalLines += 1;
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) lines.push(value as QoderLine);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines, totalLines };
}

export function readQoderLines(path: string): ParsedQoderLines {
  return parseQoderLines(readFileSync(path, 'utf8'));
}

export function qoderTimestampToIso(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return undefined;
}

export function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max).trimEnd() + '…';
}

/** 从 user message content 里取纯文本；遇 tool_result 返回 undefined */
export function qoderUserText(line: QoderUserLine): string | undefined {
  const content = line.message?.content;
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result') return undefined;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (parts.length === 0) {
    const human = textOf(line.humanInput?.text);
    if (human !== undefined) return human;
    return undefined;
  }
  return parts.join('\n');
}

export function qoderToolResultText(block: QoderContentBlock): string {
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (typeof record['text'] === 'string') return record['text'];
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join('\n');
  }
  return '';
}

export function qoderAssistantText(block: QoderContentBlock): string {
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

export function qoderThinkingText(block: QoderContentBlock): string {
  if (block.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
  return '';
}

export function qoderToolUse(block: QoderContentBlock): { callId: string; name: string; input: unknown } | undefined {
  if (block.type !== 'tool_use') return undefined;
  const callId = textOf(block.id);
  if (callId === undefined) return undefined;
  return { callId, name: textOf(block.name) ?? 'unknown', input: block.input ?? {} };
}

export function qoderToolResult(block: QoderContentBlock): { callId: string; text: string; isError: boolean } | undefined {
  if (block.type !== 'tool_result') return undefined;
  const callId = textOf(block.tool_use_id);
  if (callId === undefined) return undefined;
  return { callId, text: qoderToolResultText(block), isError: block.is_error === true };
}

function readFrom(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, Math.min(start, size));
    const count = Math.max(0, Math.min(length, size - from));
    const buffer = Buffer.alloc(count);
    const read = readSync(fd, buffer, 0, count, from);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readQoderHead(path: string, bytes = 128 * 1024): string {
  return readFrom(path, 0, bytes);
}

/** 从尾部读；丢掉第一行（可能被截断），只解析完整行 */
export function readQoderTail(path: string, bytes = 128 * 1024): string {
  const text = readFrom(path, Math.max(0, statSync(path).size - bytes), bytes);
  const newline = text.indexOf('\n');
  return newline < 0 ? text : text.slice(newline + 1);
}

/**
 * 列表用轻量元数据：头部取 cwd/createdAt/首条 user，尾部取最后一次
 * custom-title / ai-title / last-prompt / runtime-config（与 SDK 的 Kn() 对齐：
 * 多个 last-prompt 时最后一个生效；custom-title 优先于 ai-title）。
 */
export function readQoderHeadMetadata(path: string): QoderHeadMetadata {
  const head = parseQoderLines(readQoderHead(path));
  const tail = parseQoderLines(readQoderTail(path));
  const out: QoderHeadMetadata = {};
  let headCustom: string | undefined;
  let headAi: string | undefined;
  let headLastPrompt: string | undefined;
  let headModel: string | undefined;
  let tailCustom: string | undefined;
  let tailAi: string | undefined;
  let tailLastPrompt: string | undefined;
  let tailModel: string | undefined;

  for (const line of head.lines) {
    if (out.cwd === undefined) {
      const dirs = (line as QoderWorkspaceDirectoriesLine).directories;
      if (line.type === 'workspace-directories' && Array.isArray(dirs) && dirs.length > 0) out.cwd = dirs[0];
      else if (typeof line.cwd === 'string') out.cwd = line.cwd;
    }
    if (out.createdAt === undefined) out.createdAt = qoderTimestampToIso(line.timestamp);
    if (out.gitBranch === undefined && typeof line.gitBranch === 'string') out.gitBranch = line.gitBranch;
    if (line.type === 'runtime-config') headModel = textOf((line as QoderRuntimeConfigLine).model) ?? headModel;
    if (line.type === 'custom-title') headCustom = textOf((line as QoderTitleLine).customTitle) ?? headCustom;
    if (line.type === 'ai-title') headAi = textOf((line as QoderTitleLine).aiTitle) ?? headAi;
    if (line.type === 'last-prompt') headLastPrompt = textOf((line as QoderLastPromptLine).lastPrompt) ?? headLastPrompt;
    if (line.type === 'user') {
      const text = qoderUserText(line as QoderUserLine);
      if (out.firstPrompt === undefined && text !== undefined) {
        const trimmed = text.trim();
        if (trimmed.length > 0 && !trimmed.startsWith('<')) out.firstPrompt = clip(trimmed, 200);
      }
    }
  }

  for (const line of tail.lines) {
    if (line.type === 'runtime-config') tailModel = textOf((line as QoderRuntimeConfigLine).model) ?? tailModel;
    if (line.type === 'custom-title') tailCustom = textOf((line as QoderTitleLine).customTitle) ?? tailCustom;
    if (line.type === 'ai-title') tailAi = textOf((line as QoderTitleLine).aiTitle) ?? tailAi;
    if (line.type === 'last-prompt') tailLastPrompt = textOf((line as QoderLastPromptLine).lastPrompt) ?? tailLastPrompt;
  }

  const custom = tailCustom ?? headCustom;
  const ai = tailAi ?? headAi;
  out.model = tailModel ?? headModel;
  out.lastPrompt = tailLastPrompt ?? headLastPrompt;
  out.title = custom ?? ai ?? out.lastPrompt ?? out.firstPrompt;
  return out;
}

export function qoderSummary(meta: QoderHeadMetadata): string | undefined {
  return meta.title ?? meta.lastPrompt ?? meta.firstPrompt;
}

export function newQoderSessionId(): string {
  return randomUUID();
}

export function qoderSessionIdFromPath(path: string): string {
  return path.split('/').pop()?.replace(/\.jsonl$/, '') ?? path;
}
