import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectSlug } from '@sessionport/core';

/**
 * Claude Code 的会话目录解析。
 * - 真实环境：~/.claude/projects/<slug>/<uuid>.jsonl
 * - 隔离测试：CLAUDE_CONFIG_DIR 覆盖，<configDir>/projects/<slug>/<uuid>.jsonl
 */
export function claudeConfigDir(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.claude');
}

export function projectsDir(configDir: string): string {
  return join(configDir, 'projects');
}

export function projectDir(configDir: string, cwd: string): string {
  return join(projectsDir(configDir), claudeProjectSlug(cwd));
}

export function sessionFilePath(configDir: string, cwd: string, sessionId: string): string {
  return join(projectDir(configDir, cwd), sessionId + '.jsonl');
}
