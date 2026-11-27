import type { AgentAdapter, AgentId } from '@sessionport/core';

const LOADERS: Record<AgentId, () => Promise<AgentAdapter>> = {
  antigravity: async () => (await import('@sessionport/adapter-antigravity')).antigravityAdapter,
  'claude-code': async () => (await import('@sessionport/adapter-claude-code')).claudeCodeAdapter,
  'claude-desktop': async () => (await import('@sessionport/adapter-claude-code')).claudeDesktopAdapter,
  codex: async () => (await import('@sessionport/adapter-codex')).codexAdapter,
  'command-code': async () => (await import('@sessionport/adapter-command-code')).commandCodeAdapter,
  cursor: async () => (await import('@sessionport/adapter-cursor')).cursorAdapter,
  dsh: async () => (await import('@sessionport/adapter-dsh')).dshAdapter,
  'kimi-code': async () => (await import('@sessionport/adapter-kimi-code')).kimiCodeAdapter,
  opencode: async () => (await import('@sessionport/adapter-opencode')).opencodeAdapter,
  qoder: async () => (await import('@sessionport/adapter-qoder')).qoderAdapter,
  workbuddy: async () => (await import('@sessionport/adapter-workbuddy')).workbuddyAdapter,
};

export const READABLE_AGENTS: readonly AgentId[] = [
  'claude-code',
  'claude-desktop',
  'kimi-code',
  'command-code',
  'dsh',
  'codex',
  'opencode',
  'cursor',
  'qoder',
  'workbuddy',
  'antigravity',
];

export const WRITABLE_AGENTS: readonly AgentId[] = [
  'claude-code',
  'command-code',
  'dsh',
  'codex',
  'opencode',
  'cursor',
  'qoder',
  'antigravity',
];

/** 按 agent id 懒加载对应的 AgentAdapter；未知 id 返回 undefined */
export async function getAdapter(id: string): Promise<AgentAdapter | undefined> {
  const loader = Object.prototype.hasOwnProperty.call(LOADERS, id)
    ? LOADERS[id as AgentId]
    : undefined;
  return loader === undefined ? undefined : loader();
}
