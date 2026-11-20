/**
 * opencode 1.x / 2.x 会话导出格式与 CLI 工具函数。
 *
 * - 1.x（1.19.x，opencode export / import）：
 *   `{ info: { id, directory, version, ... }, messages: [{ info: { role, ... }, parts: [...] }] }`
 * - 2.x（2.2.x，opencode session export / session import）：
 *   `{ info: { id, location: { directory }, ... }, messages: [{ id, type: 'user'|'assistant'|..., ... }] }`
 *   assistant 消息用 `content[]`（text / reasoning / tool），不再用 `info + parts`。
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type OpencodeExportFormat = 'v1' | 'v2';

export interface OpencodeCliVersion {
  raw: string;
  major?: number;
  minor?: number;
  patch?: number;
}

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
  ran?: number;
  streamed?: number;
  busy?: number;
  idle?: number;
  viewed?: number;
}

export interface OpencodeV2Location {
  directory?: string;
  [key: string]: unknown;
}

export interface OpencodeSessionInfo {
  id?: string;
  slug?: string;
  projectID?: string;
  parentID?: string;
  directory?: string;
  path?: string;
  subpath?: string;
  location?: OpencodeV2Location;
  title?: string;
  agent?: string;
  model?: OpencodeModel;
  version?: string;
  outcome?: string;
  permissions?: unknown[];
  summary?: Record<string, unknown>;
  cost?: number;
  tokens?: Record<string, unknown>;
  time?: OpencodeTime;
  [key: string]: unknown;
}

export interface OpencodeToolState {
  status?: 'pending' | 'running' | 'completed' | 'error' | string;
  input?: unknown;
  output?: string;
  error?: string | OpencodeV2ToolError;
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

export interface OpencodeV2ToolError {
  type?: string;
  message?: string;
  [key: string]: unknown;
}

export interface OpencodeV2ToolContentItem {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpencodeV2ToolState {
  status?: 'pending' | 'running' | 'completed' | 'error' | string;
  input?: Record<string, unknown>;
  content?: OpencodeV2ToolContentItem[];
  error?: OpencodeV2ToolError;
  metadata?: Record<string, unknown>;
}

export interface OpencodeV2ContentBlock {
  type?: 'text' | 'reasoning' | 'tool' | 'file' | string;
  text?: string;
  id?: string;
  name?: string;
  executed?: boolean;
  state?: OpencodeV2ToolState & { signature?: string };
  native?: Record<string, unknown>;
  time?: OpencodeTime;
  [key: string]: unknown;
}

export interface OpencodeV2Message {
  id?: string;
  type?: 'user' | 'assistant' | 'idle' | 'synthetic' | 'system' | 'model-switched' | 'agent-switched' | string;
  time?: OpencodeTime;
  text?: string;
  description?: string;
  files?: unknown[];
  agents?: unknown[];
  metadata?: Record<string, unknown>;
  agent?: string;
  model?: OpencodeModel;
  previous?: unknown;
  content?: OpencodeV2ContentBlock[];
  snapshot?: Record<string, unknown>;
  finish?: string;
  rawFinish?: string;
  error?: Record<string, unknown>;
  outcome?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpencodeMessage extends OpencodeV2Message {
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

/** 识别导出 JSON 属于 1.x（v1: message.info + parts）还是 2.x（v2: 扁平 message.type + content / info.location） */
export function detectOpencodeExportFormat(raw: OpencodeExport): OpencodeExportFormat {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.type === 'string' && message.info === undefined) return 'v2';
    if (message.info !== undefined && typeof message.info === 'object') return 'v1';
  }
  if (raw.info?.location && typeof raw.info.location === 'object' && raw.info.directory === undefined) return 'v2';
  return 'v1';
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

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command: string, envPath = process.env.PATH ?? ''): string | undefined {
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 解析 opencode CLI 路径：
 * explicit > $OPENCODE_BIN > ~/.opencode/bin/opencode > PATH 里的 opencode > macOS OpenCode.app 内置 CLI > 'opencode'
 */
export function opencodeCliBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const standalone = join(homedir(), '.opencode', 'bin', 'opencode');
  if (existsSync(standalone)) return standalone;
  const onPath = findOnPath('opencode');
  if (onPath) return onPath;
  if (process.platform === 'darwin') {
    const appCandidates = [
      '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
      join(homedir(), 'Applications', 'OpenCode.app', 'Contents', 'Resources', 'opencode-cli'),
    ];
    for (const candidate of appCandidates) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return 'opencode';
}

export function parseOpencodeVersion(text: string): OpencodeCliVersion | undefined {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return undefined;
  const match = /\bv?(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(text);
  if (!match) return undefined;
  return {
    raw: line,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? undefined : Number(match[3]),
  };
}

const versionCache = new Map<string, OpencodeCliVersion | null>();

/** 探测 opencode CLI 版本（1.x vs 2.x）；失败返回 undefined，不抛错 */
export async function detectOpencodeCliVersion(binary: string, env?: Record<string, string>): Promise<OpencodeCliVersion | undefined> {
  let cacheKey: string | undefined;
  if (isAbsolute(binary)) {
    try {
      const info = statSync(binary);
      cacheKey = binary + '\0' + String(info.mtimeMs) + '\0' + String(info.size);
    } catch {
      cacheKey = undefined;
    }
  }
  if (cacheKey !== undefined && versionCache.has(cacheKey)) {
    return versionCache.get(cacheKey) ?? undefined;
  }
  try {
    const { stdout, stderr } = await execFileAsync(binary, ['--version'], {
      env: { ...process.env, ...env },
      timeout: 5000,
    });
    const parsed = parseOpencodeVersion(stdout + '\n' + stderr);
    if (cacheKey !== undefined) versionCache.set(cacheKey, parsed ?? null);
    return parsed;
  } catch {
    if (cacheKey !== undefined) versionCache.set(cacheKey, null);
    return undefined;
  }
}

export function opencodeExportArgs(sessionId: string, format: OpencodeExportFormat): string[] {
  // 2.x 把 export 挪到了 session 子命令下；--standalone 强制走私有 stdio server，避免与已运行后台服务争端口或串库
  if (format === 'v2') return ['session', 'export', '--standalone', sessionId];
  return ['export', sessionId, '--pure'];
}

export function opencodeImportArgs(jsonPath: string, format: OpencodeExportFormat, directory?: string): string[] {
  if (format === 'v2') {
    return ['session', 'import', '--standalone', ...(directory ? ['--directory', directory] : []), jsonPath];
  }
  return ['import', jsonPath, '--pure'];
}

export function opencodeRunArgs(
  options: { sessionId: string; prompt: string; model?: string },
  format: OpencodeExportFormat,
): string[] {
  return [
    'run',
    ...(format === 'v2' ? ['--standalone'] : []),
    '--session',
    options.sessionId,
    '--format',
    'json',
    ...(options.model === undefined ? [] : ['-m', options.model]),
    options.prompt,
  ];
}

/** 生成 opencode 风格 id：ses_/msg_/prt_ 前缀 + 24 位 hex */
export function opencodeId(prefix: 'ses' | 'msg' | 'prt', randomHex: string): string {
  return prefix + '_' + randomHex.slice(0, 24);
}
