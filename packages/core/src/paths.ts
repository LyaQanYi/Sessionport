import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function toAbsolute(p: string, base: string = process.cwd()): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * Claude Code 的项目目录名规则（本机 129 个项目目录实测）：
 * 路径里所有非字母数字字符替换成 '-'
 *   /Users/x/Documents/Coding/0neko-kook -> -Users-x-Documents-Coding-0neko-kook
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
