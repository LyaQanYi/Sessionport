/**
 * DSH（$DSH_HOME）目录布局。
 *
 * 规则来源：反编译安装包 app.asar 内
 * @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js 的
 * projectKey / encodeSegment / sessionDir / generationLogFilename，
 * 并用本机 ~/.dsh/sessions 的真实目录名验证。
 *
 * - sessions 根：<DSH_HOME>/sessions
 * - 项目目录：-- + 路径逐字符转义 + --；'/'、'\'、':' 连续段折叠成一个 '-'，
 *   开头的 '-' 去掉；[A-Za-z0-9._-] 原样保留；其他字符（空格、'~'、中文）
 *   按 UTF-16 code unit 转成 ~XXXX（大写 16 进制 4 位）；最长 251 字符；空路径 -> 'root'
 *   例：/Users/me/Documents/GitHub/sessionport -> --Users-me-Documents-GitHub-sessionport--
 *     /Users/me/A B/C -> --Users-me-A~0020B-C--
 * - 会话目录：项目目录/<encodeSegment(sessionId)>；sessionId 同样逐字符转义
 * - 会话文件：session.v<formatVersion>.jsonl.zstd（v0 为 session.jsonl）
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { expandHome } from '@sessionport/core';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]$/;

/** 目标 DSH_HOME：显式参数 > $DSH_HOME > ~/.dsh（绝对路径） */
export function dshHome(explicit?: string): string {
  const raw = explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** sessions 根目录 */
export function sessionsRoot(home: string): string {
  return join(home, 'sessions');
}

/** 把任意字符串转成一个安全路径段（与官方 encodeSegment 等价）。 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_SEGMENT.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** 项目路径 -> 可读的项目目录名（与官方 projectKey 等价）。 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && SAFE_SEGMENT.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--';
}

/** <sessions>/<projectKey> 或 <sessions>/_no-cwd */
export function projectDir(root: string, cwd?: string): string {
  if (cwd === undefined) return join(root, '_no-cwd');
  return join(root, projectKey(cwd));
}

/** 一个会话的目录：<sessions>/<projectKey>/<encodeSegment(id)> */
export function dshSessionDir(root: string, cwd: string | undefined, id: string): string {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/** 会话日志文件名（v0 特例 session.jsonl）。 */
export function sessionLogFilename(version: number): string {
  return version === 0 ? 'session.jsonl' : 'session.v' + version + '.jsonl';
}

/** 会话日志完整路径。 */
export function dshSessionFilePath(root: string, cwd: string | undefined, id: string, version = 4, compression: 'zstd' | 'none' = 'zstd'): string {
  const suffix = compression === 'zstd' ? '.zstd' : '';
  return join(dshSessionDir(root, cwd, id), sessionLogFilename(version) + suffix);
}

export interface ResolvedDshSession {
  /** .jsonl(.zstd) 文件路径 */
  filePath: string;
  /** 会话目录（含 session.lock） */
  sessionDir: string;
  /** sessions 根 */
  sessionsRoot: string;
  /** 目录名（encodeSegment 后的 session id） */
  dirName: string;
}

/**
 * 解析输入为会话文件：
 * - 会话目录 / 日志文件路径
 * - session id（含不带 session- 前缀的写法；会自动在 $DSH_HOME/sessions/* 下查找）
 */
export async function resolveDshSessionPath(input: string, home?: string): Promise<ResolvedDshSession> {
  const expanded = expandHome(input);
  const asPath = isAbsolute(expanded) ? expanded : resolve(expanded);
  const direct = await stat(asPath).catch(() => undefined);
  if (direct !== undefined) {
    if (direct.isDirectory()) {
      const filePath = await findLogInDir(asPath);
      if (filePath === undefined) throw new Error('DSH 会话目录里没有 session.v*.jsonl.zstd: ' + asPath);
      return { filePath, sessionDir: asPath, sessionsRoot: dirname(dirname(asPath)), dirName: basename2(asPath) };
    }
    if (direct.isFile()) {
      const sessionDir = dirname(asPath);
      return { filePath: asPath, sessionDir, sessionsRoot: dirname(dirname(sessionDir)), dirName: basename2(sessionDir) };
    }
  }
  if (input.includes('/') || input.includes('\\') || input.endsWith('.zstd')) {
    throw new Error('DSH 会话不存在: ' + asPath);
  }
  const root = sessionsRoot(dshHome(home));
  const projects = await readdir(root).catch(() => [] as string[]);
  const candidates: Array<{ filePath: string; mtime: number }> = [];
  const ids = input.startsWith('session-') ? [input] : [input, 'session-' + input];
  for (const project of projects) {
    for (const id of ids) {
      const dir = join(root, project, encodeSegment(id));
      const filePath = await findLogInDir(dir);
      if (filePath === undefined) continue;
      const info = await stat(filePath).catch(() => undefined);
      candidates.push({ filePath, mtime: info?.mtimeMs ?? 0 });
    }
  }
  if (candidates.length === 0) throw new Error('在 ' + root + ' 下找不到 DSH 会话: ' + input);
  candidates.sort((a, b) => b.mtime - a.mtime);
  const chosen = candidates[0]!.filePath;
  const sessionDir = dirname(chosen);
  return { filePath: chosen, sessionDir, sessionsRoot: dirname(dirname(sessionDir)), dirName: basename2(sessionDir) };
}

function basename2(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** readdir，目录不存在时返回空数组。 */
export async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** 在一个会话目录里按版本从高到低找日志文件。 */
export async function findLogInDir(dir: string): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const versions: Array<{ name: string; version: number }> = [];
  if (names.includes('session.jsonl.zstd')) versions.push({ name: 'session.jsonl.zstd', version: 0 });
  if (names.includes('session.jsonl')) versions.push({ name: 'session.jsonl', version: 0 });
  for (const name of names) {
    const match = /^session\.v(\d+)\.jsonl\.zstd$/u.exec(name);
    if (match !== null && match[1] !== undefined) versions.push({ name, version: Number(match[1]) });
  }
  if (versions.length === 0) return undefined;
  versions.sort((a, b) => b.version - a.version);
  return join(dir, versions[0]!.name);
}
