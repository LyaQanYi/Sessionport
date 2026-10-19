import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { AgentId } from './ir.ts';

/**
 * 同步登记表：记录「某个源会话已经同步到某个目标端」的状态。
 *
 * 目的不是缓存内容，而是回答一个问题：*这次重推会不会覆盖目标端新增的对话？*
 * 因此只存最小的对齐信息：源端同步到哪个 head、目标端当时有多少行/事件。
 */
export interface ExternalRef {
  /** 源会话身份：<sourceAgent>:<nativeSessionId>（没有 native id 时用 IR session id） */
  sourceKey: string;
  target: AgentId;
  /** 目标端会话 id */
  targetId: string;
  /** 目标端主文件路径 */
  targetPath: string;
  /** 目标端计量单位：文件行数（transcript）或事件数（事件流） */
  unit: 'rows' | 'events';
  /** 上次同步后目标端的行数 / 事件数 */
  targetUnits: number;
  /** 上次同步时的源端事件数 */
  sourceEvents: number;
  /** 上次同步时的 IR 链尾事件 id */
  sourceHead: string | null;
  updatedAt: string;
}

export interface RegistryFile {
  version: 1;
  refs: ExternalRef[];
}

export function sessionportHome(explicit?: string): string {
  const raw = explicit ?? process.env.SESSIONPORT_HOME ?? join(homedir(), '.sessionport');
  const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function registryPath(home?: string): string {
  return join(sessionportHome(home), 'registry.json');
}

export function emptyRegistry(): RegistryFile {
  return { version: 1, refs: [] };
}

export function loadRegistry(home?: string): RegistryFile {
  const path = registryPath(home);
  if (!existsSync(path)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.refs)) return emptyRegistry();
    return { version: 1, refs: parsed.refs.filter((ref): ref is ExternalRef => Boolean(ref) && typeof ref === 'object') };
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(registry: RegistryFile, home?: string): string {
  const path = registryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
  return path;
}

export function sourceKeyOf(source: { agent: AgentId; nativeSessionId?: string }, fallbackId: string): string {
  return source.agent + ':' + (source.nativeSessionId ?? fallbackId);
}

export function findRef(registry: RegistryFile, sourceKey: string, target: AgentId): ExternalRef | undefined {
  return registry.refs.find((ref) => ref.sourceKey === sourceKey && ref.target === target);
}

export function upsertRef(registry: RegistryFile, ref: ExternalRef): void {
  const index = registry.refs.findIndex((item) => item.sourceKey === ref.sourceKey && item.target === ref.target);
  if (index >= 0) registry.refs[index] = ref;
  else registry.refs.push(ref);
}

export function removeRef(registry: RegistryFile, sourceKey: string, target: AgentId): boolean {
  const before = registry.refs.length;
  registry.refs = registry.refs.filter((ref) => !(ref.sourceKey === sourceKey && ref.target === target));
  return registry.refs.length !== before;
}
