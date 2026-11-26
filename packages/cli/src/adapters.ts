import type { AgentAdapter, AgentId } from '@sessionport/core';

const LOADERS: Record<AgentId, () => Promise<AgentAdapter>> = {
  antigravity: async () => (await import('@sessionport/adapter-antigravity')).antigravityAdapter,
  'claude-code': async () => (await import('@sessionport/adapter-claude-code')).claudeCodeAdapter,
  codex: async () => (await import('@sessionport/adapter-codex')).codexAdapter,
  'command-code': async () => (await import('@sessionport/adapter-command-code')).commandCodeAdapter,
  cursor: async () => (await import('@sessionport/adapter-cursor')).cursorAdapter,
  dsh: async () => (await import('@sessionport/adapter-dsh')).dshAdapter,
  'kimi-code': async () => (await import('@sessionport/adapter-kimi-code')).kimiCodeAdapter,
  opencode: async () => (await import('@sessionport/adapter-opencode')).opencodeAdapter,
  qoder: async () => (await import('@sessionport/adapter-qoder')).qoderAdapter,
  workbuddy: async () => (await import('@sessionport/adapter-workbuddy')).workbuddyAdapter,
};

export const WRITE_TARGETS = [
  'claude-code',
  'command-code',
  'dsh',
  'codex',
  'opencode',
  'cursor',
  'qoder',
  'antigravity',
] as const;

const PREFIXES: ReadonlyArray<[string, AgentId]> = [
  ['antigravity', 'antigravity'],
  ['agy', 'antigravity'],
  ['kimi', 'kimi-code'],
  ['claude', 'claude-code'],
  ['claudecode', 'claude-code'],
  ['commandcode', 'command-code'],
  ['cmd', 'command-code'],
  ['dsh', 'dsh'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
  ['cursor', 'cursor'],
  ['qoder', 'qoder'],
  ['workbuddy', 'workbuddy'],
  ['wb', 'workbuddy'],
];

export async function getAdapter(id: string): Promise<AgentAdapter | undefined> {
  const loader = Object.prototype.hasOwnProperty.call(LOADERS, id)
    ? LOADERS[id as AgentId]
    : undefined;
  return loader === undefined ? undefined : loader();
}

export function prefixTable(): Array<[string, AgentId]> {
  return [...PREFIXES];
}
