/**
 * Cursor（VS Code fork）数据目录与 workspace 映射。
 *
 * 本机实测（Cursor 3.25.9 / macOS）：
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb  主库（sqlite, WAL）
 *   ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json
 *
 * workspaceStorage 目录名不是简单的 md5(path)：实测是 md5(fsPath + birthtimeMs)
 * （darwin 用 birthtime，linux 用 inode，见 cursor-agent 内嵌的 userData 推导代码）。
 *
 * 只做路径解析，不打开数据库；数据库访问在 wire.ts。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 覆盖 Cursor 用户数据目录（默认按平台推断；测试/多 profile 用） */
export const CURSOR_HOME_ENV = 'SESSIONPORT_CURSOR_HOME';

export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

export function defaultCursorUserDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Cursor');
    case 'win32': {
      const appData = process.env.APPDATA;
      return appData !== undefined && appData.length > 0
        ? join(appData, 'Cursor')
        : join(homedir(), 'AppData', 'Roaming', 'Cursor');
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME;
      return xdg !== undefined && xdg.length > 0 ? join(xdg, 'Cursor') : join(homedir(), '.config', 'Cursor');
    }
  }
}

/**
 * Cursor 用户数据根目录（= VS Code 的 userDataPath）。
 * 优先级：显式参数 > SESSIONPORT_CURSOR_HOME > 平台默认。
 */
export function cursorUserDataDir(explicit?: string): string {
  const raw = explicit !== undefined && explicit.length > 0 ? explicit : process.env[CURSOR_HOME_ENV];
  if (raw === undefined || raw.length === 0) return defaultCursorUserDataDir();
  const expanded = expandHomePath(raw);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function cursorGlobalDbPath(userDataDir: string): string {
  return join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
}

export function cursorWorkspaceStorageDir(userDataDir: string): string {
  return join(userDataDir, 'User', 'workspaceStorage');
}

export function cursorLogsDir(userDataDir: string): string {
  return join(userDataDir, 'logs');
}

/** 兼容 VS Code 的 workspace.json：单根是 folder，多根是 workspace(.code-workspace) */
export interface CursorWorkspaceJson {
  folder?: string;
  workspace?: string;
}

export interface CursorWorkspaceInfo {
  workspaceId: string;
  /** workspace.json 原样内容 */
  json?: CursorWorkspaceJson;
  /** file:// URI 字符串（folder 或 workspace 文件） */
  uri?: string;
  /** 单根 workspace 的本地目录；多根 workspace 为 .code-workspace 所在目录 */
  cwd?: string;
  /** workspace.json 的 mtime（ISO） */
  updatedAt?: string;
}

function uriToFsPath(uri: string | undefined): string | undefined {
  if (uri === undefined || uri.length === 0) return undefined;
  if (!uri.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * 解析 workspace 标识里的 URI：
 * - { uri: { fsPath } }（Cursor composerData / header value）
 * - { uri: "file:///..." }（VS Code URI.toJSON 的 external 形态）
 */
export function fsPathFromWorkspaceIdentifier(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const uri = record.uri;
  if (typeof uri === 'string') return uriToFsPath(uri);
  if (uri !== null && typeof uri === 'object') {
    const uriRecord = uri as Record<string, unknown>;
    if (typeof uriRecord.fsPath === 'string' && uriRecord.fsPath.length > 0) return uriRecord.fsPath;
    if (typeof uriRecord.external === 'string') return uriToFsPath(uriRecord.external);
    if (typeof uriRecord.path === 'string' && uriRecord.path.length > 0) return uriRecord.path;
  }
  if (typeof record.fsPath === 'string' && record.fsPath.length > 0) return record.fsPath;
  return undefined;
}

/** 读所有 workspaceStorage/<id>/workspace.json（跳过坏文件） */
export function listCursorWorkspaces(userDataDir: string): CursorWorkspaceInfo[] {
  const root = cursorWorkspaceStorageDir(userDataDir);
  if (!existsSync(root)) return [];
  const out: CursorWorkspaceInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const workspaceId of entries) {
    const dir = join(root, workspaceId);
    const jsonPath = join(dir, 'workspace.json');
    const dbPath = join(dir, 'state.vscdb');
    if (!existsSync(jsonPath) && !existsSync(dbPath)) continue;
    const info: CursorWorkspaceInfo = { workspaceId };
    if (existsSync(jsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as CursorWorkspaceJson;
        if (parsed !== null && typeof parsed === 'object') {
          info.json = parsed;
          const uri = parsed.folder ?? parsed.workspace;
          if (typeof uri === 'string' && uri.length > 0) {
            info.uri = uri;
            if (parsed.folder !== undefined) {
              info.cwd = uriToFsPath(parsed.folder);
            } else {
              const configPath = uriToFsPath(parsed.workspace);
              if (configPath !== undefined) info.cwd = dirname(configPath);
            }
          }
        }
      } catch {
        // workspace.json 坏了不影响其它 workspace
      }
      try {
        info.updatedAt = statSync(dbPath).mtime.toISOString();
      } catch {
        // ignore
      }
    }
    out.push(info);
  }
  return out;
}

function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 目标 cwd 已存在于 Cursor 的 workspaceStorage 时返回其 workspaceId */
export function findWorkspaceIdByCwd(userDataDir: string, cwd: string): string | undefined {
  const target = normalizeForCompare(cwd);
  const matches = listCursorWorkspaces(userDataDir).filter(
    (info) => info.cwd !== undefined && normalizeForCompare(info.cwd) === target,
  );
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return matches[0]?.workspaceId;
}

/**
 * 为新 cwd 推导 VS Code workspaceStorage id。
 *
 * 实测算法（本机 78 个 workspace.json 中可 stat 的目录全部命中）：
 *   darwin: md5(fsPath + birthtime.getTime())
 *   win32 : md5(fsPath + birthtimeMs)
 *   linux : md5(fsPath + ino)
 * 目录不存在（无法 stat）时返回 undefined。
 */
export function computeWorkspaceId(cwd: string): string | undefined {
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) return undefined;
  const path = resolve(cwd);
  let suffix: string;
  if (process.platform === 'linux') suffix = String(stat.ino);
  else if (process.platform === 'win32') suffix = String(Math.floor(stat.birthtimeMs));
  else suffix = String(stat.birthtime.getTime());
  return createHash('md5').update(path).update(suffix).digest('hex');
}

/** 目标 cwd 的 workspaceId：优先复用已有 workspace，否则按 VS Code 算法推导 */
export function resolveWorkspaceId(userDataDir: string, cwd: string): string | undefined {
  return findWorkspaceIdByCwd(userDataDir, cwd) ?? computeWorkspaceId(cwd);
}

export interface CursorWorkspaceIdentifier {
  id: string;
  uri: {
    $mid: 1;
    fsPath: string;
    external: string;
    path: string;
    scheme: 'file';
  };
  [key: string]: unknown;
}

export interface CursorPaths {
  /** Cursor 用户数据根目录 */
  home: string;
  /** 主库 state.vscdb 路径 */
  dbPath: string;
}

/** 统一解析读写用到的两个路径（home 可被显式参数/ENV 覆盖，dbPath 可单独覆盖） */
export function resolveCursorPaths(options: { home?: string; dbPath?: string } = {}): CursorPaths {
  const home = cursorUserDataDir(options.home);
  return { home, dbPath: options.dbPath !== undefined && options.dbPath.length > 0 ? options.dbPath : cursorGlobalDbPath(home) };
}

/** 与 Cursor composerData.workspaceIdentifier / header.value.workspaceIdentifier 同构 */
export function workspaceIdentifierFor(workspaceId: string, cwd: string): CursorWorkspaceIdentifier {
  const fsPath = resolve(cwd);
  return {
    id: workspaceId,
    uri: {
      $mid: 1,
      fsPath,
      external: pathToFileURL(fsPath).toString(),
      path: fsPath,
      scheme: 'file',
    },
  };
}

// ---------------------------------------------------------------------------
// ~/.cursor（agent-transcripts / chats CLI 存储）
// ---------------------------------------------------------------------------

export interface CursorChatMeta {
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export interface CursorTranscriptFile {
  composerId: string;
  filePath: string;
  projectSlug: string;
  mtimeMs: number;
  chatMeta?: CursorChatMeta;
}

/**
 * 解析 Cursor ~/.cursor 根目录。
 * 默认按 homedir()/.cursor；显式传 test temp home 时隔离到 <home>/.cursor（除非传的本身就是平台默认 UserData 目录）。
 */
export function cursorDotDir(explicitHome?: string): string {
  const raw = explicitHome !== undefined && explicitHome.length > 0 ? explicitHome : process.env[CURSOR_HOME_ENV];
  if (raw === undefined || raw.length === 0) return join(homedir(), '.cursor');
  const expanded = expandHomePath(raw);
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
  if (resolve(abs) === resolve(defaultCursorUserDataDir())) {
    return join(homedir(), '.cursor');
  }
  return join(abs, '.cursor');
}

function readCursorChatsMetaMap(dotDir: string): Map<string, CursorChatMeta> {
  const map = new Map<string, CursorChatMeta>();
  const chatsRoot = join(dotDir, 'chats');
  if (!existsSync(chatsRoot)) return map;
  let hashes: string[];
  try {
    hashes = readdirSync(chatsRoot);
  } catch {
    return map;
  }
  for (const hashDir of hashes) {
    const hashPath = join(chatsRoot, hashDir);
    let sessions: string[];
    try {
      sessions = readdirSync(hashPath);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const metaPath = join(hashPath, sid, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
        const meta: CursorChatMeta = {};
        if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) meta.cwd = parsed.cwd;
        if (typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs)) meta.createdAtMs = parsed.createdAtMs;
        if (typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)) meta.updatedAtMs = parsed.updatedAtMs;
        map.set(sid, meta);
      } catch {
        // 坏 meta.json 跳过
      }
    }
  }
  return map;
}

/** 扫描 ~/.cursor/projects/<slug>/agent-transcripts 下所有根会话 JSONL（排除 subagents） */
export function listCursorAgentTranscripts(dotDir: string): CursorTranscriptFile[] {
  const projectsRoot = join(dotDir, 'projects');
  if (!existsSync(projectsRoot)) return [];
  const chatMetaMap = readCursorChatsMetaMap(dotDir);
  const byId = new Map<string, CursorTranscriptFile>();

  let slugs: string[];
  try {
    slugs = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  for (const projectSlug of slugs) {
    if (projectSlug.startsWith('.')) continue;
    const atDir = join(projectsRoot, projectSlug, 'agent-transcripts');
    if (!existsSync(atDir)) continue;
    let entries;
    try {
      entries = readdirSync(atDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      let composerId: string | undefined;
      let filePath: string | undefined;
      if (entry.isDirectory()) {
        const candidate = join(atDir, entry.name, entry.name + '.jsonl');
        if (existsSync(candidate)) {
          composerId = entry.name;
          filePath = candidate;
        }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        composerId = entry.name.slice(0, -'.jsonl'.length);
        filePath = join(atDir, entry.name);
      }
      if (composerId === undefined || filePath === undefined) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      const existing = byId.get(composerId);
      if (existing !== undefined && existing.mtimeMs >= mtimeMs) continue;
      const chatMeta = chatMetaMap.get(composerId);
      byId.set(composerId, {
        composerId,
        filePath,
        projectSlug,
        mtimeMs,
        ...(chatMeta !== undefined ? { chatMeta } : {}),
      });
    }
  }

  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findCursorAgentTranscript(dotDir: string, idOrPrefix: string): CursorTranscriptFile | undefined {
  const list = listCursorAgentTranscripts(dotDir);
  return list.find((item) => item.composerId === idOrPrefix) ?? list.find((item) => item.composerId.startsWith(idOrPrefix));
}

/** 列举同目录下的 subagents/*.jsonl */
export function listCursorTranscriptSubagents(transcriptPath: string): string[] {
  const subDir = join(dirname(transcriptPath), 'subagents');
  if (!existsSync(subDir)) return [];
  try {
    return readdirSync(subDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(subDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** 尽量在本地文件系统上把 Cursor project slug（如 Users-me-Documents-Open-App）还原成真实存在的 cwd */
export function cwdFromCursorProjectSlug(slug: string): string | undefined {
  if (!slug || /^\d+$/.test(slug)) return undefined;
  const parts = slug.split('-').filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;

  const toSlugToken = (name: string): string =>
    name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

  let current = '/';
  let idx = 0;
  // 若首段并非根目录真实子项（如 private-var-... 中的 var），尝试直接作为顶级判断
  while (idx < parts.length) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return undefined;
    }
    const candidates: Array<{ next: string; consume: number }> = [];
    for (const entry of entries) {
      const tok = toSlugToken(entry);
      if (!tok) continue;
      const tokParts = tok.split('-');
      if (idx + tokParts.length > parts.length) continue;
      let match = true;
      for (let k = 0; k < tokParts.length; k += 1) {
        if (parts[idx + k]!.toLowerCase() !== tokParts[k]) {
          match = false;
          break;
        }
      }
      if (match) {
        candidates.push({ next: join(current, entry), consume: tokParts.length });
      }
    }
    if (candidates.length === 0) {
      // macOS 上 var/folders... 实际在 /private/var/...
      if (current === '/' && parts[0]?.toLowerCase() === 'var' && existsSync('/private/var')) {
        current = '/private';
        continue;
      }
      return undefined;
    }
    // 优先消费更多段（匹配带连字符/空格的目录名）
    candidates.sort((a, b) => b.consume - a.consume);
    current = candidates[0]!.next;
    idx += candidates[0]!.consume;
  }
  return existsSync(current) ? current : undefined;
}
