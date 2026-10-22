import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { claudeProjectSlug } from '@sessionport/core';

/**
 * Claude Code 的会话目录解析。
 * - 真实环境：~/.claude/projects/<slug>/<uuid>.jsonl
 * - 隔离测试：CLAUDE_CONFIG_DIR 覆盖，<configDir>/projects/<slug>/<uuid>.jsonl
 */
export function claudeConfigDir(explicit?: string): string {
  // 必须绝对化：claude 子进程的 cwd 可能和当前进程不同，
  // 相对路径会被它按自己的 cwd 解析，导致找不到会话（实测 "No conversation found"）。
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(p));
  if (explicit) return abs(explicit);
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv && fromEnv.length > 0) return abs(fromEnv);
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

/** 主会话旁边的同名目录：<projectDir>/<sessionId>/ */
export function sessionDirPath(configDir: string, cwd: string, sessionId: string): string {
  return join(projectDir(configDir, cwd), sessionId);
}

/** Claude 原生子代理 transcript 目录：<projectDir>/<sessionId>/subagents/ */
export function subagentsDirPath(configDir: string, cwd: string, sessionId: string): string {
  return join(sessionDirPath(configDir, cwd, sessionId), 'subagents');
}

export function subagentFilePath(configDir: string, cwd: string, sessionId: string, agentId: string): string {
  return join(subagentsDirPath(configDir, cwd, sessionId), 'agent-' + agentId + '.jsonl');
}

export function subagentMetaPath(configDir: string, cwd: string, sessionId: string, agentId: string): string {
  return join(subagentsDirPath(configDir, cwd, sessionId), 'agent-' + agentId + '.meta.json');
}