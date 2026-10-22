/**
 * opencode 1.19.3 的会话导出格式（opencode export / import 使用的 JSON）。
 *
 * 形状：{ info, messages: [{ info, parts }] }
 * - info: 会话元数据（id/slug/projectID/directory/title/agent/model/version/time…）
 * - message.info: 消息元数据（role/agent/model/id/sessionID/parentID/time/tokens…）
 * - parts: text / reasoning / tool / step-start / step-finish / file
 *
 * reader 以 text / reasoning / tool 为准；step-* 是流式占位，file 是附件引用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OpencodeModel {
  id?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
}

export interface OpencodeTime {
  created?: number;
  updated?: number;
  start?: number;
  end?: number;
  completed?: number;
}

export interface OpencodeSessionInfo {
  id?: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  path?: string;
  title?: string;
  agent?: string;
  model?: OpencodeModel;
  version?: string;
  summary?: Record<string, unknown>;
  cost?: number;
  tokens?: Record<string, unknown>;
  time?: OpencodeTime;
}

export interface OpencodeToolState {
  status?: 'pending' | 'running' | 'completed' | 'error' | string;
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
  time?: OpencodeTime;
  metadata?: Record<string, unknown>;
}

export interface OpencodePart {
  type?: string;
  id?: string;
  sessionID?: string;
  messageID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OpencodeToolState;
  time?: OpencodeTime;
  metadata?: Record<string, unknown>;
  filename?: string;
  mime?: string;
  url?: string;
  source?: unknown;
  [key: string]: unknown;
}

export interface OpencodeMessageInfo {
  id?: string;
  sessionID?: string;
  role?: 'user' | 'assistant' | string;
  parentID?: string | null;
  agent?: string;
  model?: OpencodeModel;
  modelID?: string;
  providerID?: string;
  mode?: string;
  finish?: string;
  time?: OpencodeTime;
  cost?: number;
  tokens?: Record<string, unknown>;
  summary?: unknown;
  path?: { cwd?: string; root?: string };
  [key: string]: unknown;
}

export interface OpencodeMessage {
  info?: OpencodeMessageInfo;
  parts?: OpencodePart[];
}

export interface OpencodeExport {
  info?: OpencodeSessionInfo;
  messages?: OpencodeMessage[];
}

export function parseOpencodeExport(text: string): OpencodeExport {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('不是 opencode 导出 JSON（顶层不是对象）');
  return parsed as OpencodeExport;
}

export function readOpencodeExportFile(path: string): OpencodeExport {
  return parseOpencodeExport(readFileSync(path, 'utf8'));
}

/** opencode 数据目录（XDG_DATA_HOME/opencode，默认 ~/.local/share/opencode） */
export function opencodeDataDir(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.OPENCODE_DATA_DIR;
  if (fromEnv) return fromEnv;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'opencode');
  return join(homedir(), '.local', 'share', 'opencode');
}

/** 默认数据库路径：$OPENCODE_DB 或 <dataDir>/opencode.db */
export function opencodeDbPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  return join(opencodeDataDir(), 'opencode.db');
}

export function opencodeCliBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const candidate = join(homedir(), '.opencode', 'bin', 'opencode');
  return existsSync(candidate) ? candidate : 'opencode';
}

/** 生成 opencode 风格 id：ses_/msg_/prt_ 前缀 + 24 位 base62 近似 */
export function opencodeId(prefix: 'ses' | 'msg' | 'prt', randomHex: string): string {
  return prefix + '_' + randomHex.slice(0, 24);
}
