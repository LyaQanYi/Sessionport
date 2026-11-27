/**
 * Claude Desktop 会话读写与元数据聚合（仅只读）。
 *
 * 数据来源（实测 macOS ~/Library/Application Support/Claude-3p 与 Claude）：
 * 1. Claude Desktop（Code 模式）：
 *    - 对话 JSONL 写在 <CLAUDE_CONFIG_DIR>/projects/<slug>/<cliSessionId>.jsonl，
 *      且行内 entrypoint 为 "claude-desktop-3p" / "claude-desktop"；
 *    - 标题 / 归档 / worktree / lastActivityAt 等桌面端元数据写在
 *      <ClaudeDesktopDir>/claude-code-sessions/<orgId>/<profileId>/local_*.json。
 * 2. Claude Desktop（Cowork / local-agent 模式）：
 *    - 元数据写在 <ClaudeDesktopDir>/local-agent-mode-sessions/<orgId>/<profileId>/local_<uuid>.json；
 *    - 对话 JSONL 独立存放在 <orgId>/<profileId>/<shortId>/.claude/projects/session/<cliSessionId>.jsonl。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { finalizeSessionList } from '@sessionport/core';
import type { AgentAdapter, IrBundle, ListSessionsOptions, SessionSummary } from '@sessionport/core';

import { readClaudeFileSummary } from './list.ts';
import { claudeConfigDir, projectsDir } from './paths.ts';
import { readClaudeSession } from './read.ts';
import type { ReadClaudeOptions } from './read.ts';

export const CLAUDE_DESKTOP_AGENT_ID = 'claude-desktop' as const;
export const CLAUDE_DESKTOP_DIR_ENV = 'CLAUDE_DESKTOP_DIR';

export interface ClaudeDesktopSessionMeta {
  desktopSessionId: string;
  cliSessionId: string;
  mode: 'code' | 'cowork';
  title?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  transcriptPath?: string;
}

function expandPath(raw: string): string {
  const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** 平台默认 Claude Desktop 数据目录列表（按优先级从高到低） */
export function defaultClaudeDesktopDirs(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        join(homedir(), 'Library', 'Application Support', 'Claude-3p'),
        join(homedir(), 'Library', 'Application Support', 'Claude'),
      ];
    case 'win32': {
      const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
      return [join(appData, 'Claude-3p'), join(appData, 'Claude')];
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
      return [join(xdg, 'Claude-3p'), join(xdg, 'Claude')];
    }
  }
}

export function claudeDesktopDirs(explicit?: string): string[] {
  if (explicit !== undefined && explicit.length > 0) return [expandPath(explicit)];
  const fromEnv = process.env[CLAUDE_DESKTOP_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return [expandPath(fromEnv)];
  return defaultClaudeDesktopDirs();
}

/** 给设置页与路径探测用：优先返回含桌面端会话目录的数据根 */
export function detectClaudeDesktopDir(): string {
  const dirs = defaultClaudeDesktopDirs();
  const withSessions = dirs.find(
    (dir) =>
      existsSync(join(dir, 'claude-code-sessions')) ||
      existsSync(join(dir, 'local-agent-mode-sessions')),
  );
  if (withSessions !== undefined) return withSessions;
  const existing = dirs.find((dir) => existsSync(dir));
  return existing ?? dirs[dirs.length - 1]!;
}

export function isClaudeDesktopEntrypoint(entrypoint: string | undefined): boolean {
  if (typeof entrypoint !== 'string') return false;
  return entrypoint.trim().toLowerCase().startsWith('claude-desktop');
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function msToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function readJsonRecordSafe(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readdirDirentsSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkLocalMetaJsons(rootDir: string, maxDepth = 4): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of readdirDirentsSafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 不进入 .claude / outputs 内部
        if (entry.name === '.claude' || entry.name === 'outputs' || entry.name === 'skills-plugin') continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('local_') && entry.name.endsWith('.json')) {
        out.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

function findCoworkTranscriptPath(metaJsonPath: string, desktopSessionId: string, cliSessionId: string): string | undefined {
  const profileDir = join(metaJsonPath, '..');
  const shortId = desktopSessionId.replace(/^local_/, '').split('-')[0];
  if (shortId === undefined || shortId.length === 0) return undefined;
  const sessionRoot = join(profileDir, shortId, '.claude', 'projects');
  if (!existsSync(sessionRoot)) return undefined;

  const preferred = join(sessionRoot, 'session', cliSessionId + '.jsonl');
  if (existsSync(preferred)) return preferred;

  try {
    for (const dirEntry of readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      const candidate = join(sessionRoot, dirEntry.name, cliSessionId + '.jsonl');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** 扫描 Claude Desktop Code 模式下的会话元数据（按 cliSessionId 建立索引） */
export function scanClaudeDesktopCodeMetadata(desktopDirs: string[]): Map<string, ClaudeDesktopSessionMeta> {
  const byCliId = new Map<string, ClaudeDesktopSessionMeta>();
  for (const baseDir of desktopDirs) {
    const sessionsDir = join(baseDir, 'claude-code-sessions');
    for (const jsonPath of walkLocalMetaJsons(sessionsDir)) {
      const record = readJsonRecordSafe(jsonPath);
      if (record === undefined) continue;
      const cliSessionId = textOf(record.cliSessionId);
      const desktopSessionId = textOf(record.sessionId) ?? basename(jsonPath, '.json');
      if (cliSessionId === undefined) continue;
      const title = textOf(record.title);
      const cwd = textOf(record.originCwd) ?? textOf(record.cwd);
      const createdAt = msToIso(record.createdAt);
      const updatedAt = msToIso(record.lastActivityAt);
      const archived = record.isArchived === true;
      const prev = byCliId.get(cliSessionId);
      if (prev !== undefined && (prev.updatedAt ?? '') >= (updatedAt ?? '')) continue;
      byCliId.set(cliSessionId, {
        desktopSessionId,
        cliSessionId,
        mode: 'code',
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(archived ? { archived: true } : {}),
      });
    }
  }
  return byCliId;
}

/** 扫描 Claude Desktop Cowork（local-agent-mode-sessions）会话及其独立 JSONL 路径 */
export function scanClaudeDesktopCoworkSessions(desktopDirs: string[]): ClaudeDesktopSessionMeta[] {
  const byCliId = new Map<string, ClaudeDesktopSessionMeta>();
  for (const baseDir of desktopDirs) {
    const lamDir = join(baseDir, 'local-agent-mode-sessions');
    for (const jsonPath of walkLocalMetaJsons(lamDir)) {
      const record = readJsonRecordSafe(jsonPath);
      if (record === undefined) continue;
      const cliSessionId = textOf(record.cliSessionId);
      const desktopSessionId = textOf(record.sessionId) ?? basename(jsonPath, '.json');
      if (cliSessionId === undefined) continue;
      const transcriptPath = findCoworkTranscriptPath(jsonPath, desktopSessionId, cliSessionId);
      if (transcriptPath === undefined) continue;
      const selectedFolder = Array.isArray(record.userSelectedFolders)
        ? textOf(record.userSelectedFolders[0])
        : undefined;
      const cwd = selectedFolder ?? textOf(record.cwd);
      const title = textOf(record.title);
      const createdAt = msToIso(record.createdAt);
      const updatedAt = msToIso(record.lastActivityAt);
      const archived = record.isArchived === true;
      const prev = byCliId.get(cliSessionId);
      if (prev !== undefined && (prev.updatedAt ?? '') >= (updatedAt ?? '')) continue;
      byCliId.set(cliSessionId, {
        desktopSessionId,
        cliSessionId,
        mode: 'cowork',
        transcriptPath,
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(archived ? { archived: true } : {}),
      });
    }
  }
  return [...byCliId.values()];
}

function resolveClaudeConfigDirForDesktop(options: { home?: string; claudeConfigDir?: string }): string {
  if (options.claudeConfigDir !== undefined && options.claudeConfigDir.length > 0) {
    return expandPath(options.claudeConfigDir);
  }
  if (options.home !== undefined && existsSync(join(expandPath(options.home), 'projects'))) {
    return expandPath(options.home);
  }
  return claudeConfigDir();
}

export interface ListClaudeDesktopOptions extends ListSessionsOptions {
  /** 测试隔离时显式覆盖 ~/.claude 目录（默认读 $CLAUDE_CONFIG_DIR / ~/.claude） */
  claudeConfigDir?: string;
}

function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function listClaudeDesktopSessions(options: ListClaudeDesktopOptions = {}): Promise<SessionSummary[]> {
  const desktopDirs = claudeDesktopDirs(options.home);
  const codeMetaByCliId = scanClaudeDesktopCodeMetadata(desktopDirs);
  const coworkSessions = scanClaudeDesktopCoworkSessions(desktopDirs);
  const configDir = resolveClaudeConfigDirForDesktop(options);
  const root = projectsDir(configDir);

  const summaries: SessionSummary[] = [];
  const seenIds = new Set<string>();

  if (existsSync(root)) {
    for (const project of readdirDirentsSafe(root)) {
      if (!project.isDirectory()) continue;
      const projectPath = join(root, project.name);
      for (const file of readdirDirentsSafe(projectPath)) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const filePath = join(projectPath, file.name);
        const inspected = await readClaudeFileSummary(filePath, project.name, { agent: CLAUDE_DESKTOP_AGENT_ID });
        if (inspected === undefined) continue;
        const desktopMeta = codeMetaByCliId.get(inspected.summary.sessionId);
        if (!isClaudeDesktopEntrypoint(inspected.entrypoint) && desktopMeta === undefined) continue;

        const summary = inspected.summary;
        if (desktopMeta !== undefined) {
          summary.title =
            inspected.customTitle ??
            desktopMeta.title ??
            inspected.summaryTitle ??
            summary.title;
          if (summary.cwd === undefined && desktopMeta.cwd !== undefined) summary.cwd = desktopMeta.cwd;
          if (desktopMeta.archived === true) summary.archived = true;
          summary.createdAt = summary.createdAt ?? desktopMeta.createdAt;
          summary.updatedAt = laterIso(summary.updatedAt, desktopMeta.updatedAt);
        }
        seenIds.add(summary.sessionId);
        summaries.push(summary);
      }
    }
  }

  for (const meta of coworkSessions) {
    if (seenIds.has(meta.cliSessionId) || meta.transcriptPath === undefined) continue;
    const inspected = await readClaudeFileSummary(meta.transcriptPath, 'session', { agent: CLAUDE_DESKTOP_AGENT_ID });
    if (inspected === undefined) continue;
    const summary: SessionSummary = {
      agent: CLAUDE_DESKTOP_AGENT_ID,
      sessionId: meta.cliSessionId,
      nativePath: meta.transcriptPath,
    };
    const title = inspected.customTitle ?? meta.title ?? inspected.summaryTitle ?? inspected.summary.title;
    if (title !== undefined) summary.title = title;
    const cwd = meta.cwd ?? inspected.summary.cwd;
    if (cwd !== undefined) summary.cwd = cwd;
    const createdAt = meta.createdAt ?? inspected.summary.createdAt;
    if (createdAt !== undefined) summary.createdAt = createdAt;
    const updatedAt = laterIso(inspected.summary.updatedAt, meta.updatedAt);
    if (updatedAt !== undefined) summary.updatedAt = updatedAt;
    if (meta.archived === true) summary.archived = true;
    seenIds.add(meta.cliSessionId);
    summaries.push(summary);
  }

  return finalizeSessionList(summaries, options.limit);
}

export interface ReadClaudeDesktopOptions extends ReadClaudeOptions {
  desktopHome?: string;
  claudeConfigDir?: string;
}

function findDesktopCodeJsonl(projectsRoot: string, idOrPrefix: string): string | undefined {
  if (!existsSync(projectsRoot)) return undefined;
  const exactName = idOrPrefix + '.jsonl';
  const candidates: string[] = [];
  for (const dir of readdirDirentsSafe(projectsRoot)) {
    if (!dir.isDirectory()) continue;
    const projectPath = join(projectsRoot, dir.name);
    const exactPath = join(projectPath, exactName);
    if (existsSync(exactPath)) return exactPath;
    for (const file of readdirDirentsSafe(projectPath)) {
      if (file.isFile() && file.name.endsWith('.jsonl') && file.name.startsWith(idOrPrefix)) {
        candidates.push(join(projectPath, file.name));
      }
    }
  }
  return candidates[0];
}

function rebrandBundleAsClaudeDesktop(bundle: IrBundle, metaOverride?: ClaudeDesktopSessionMeta): IrBundle {
  const oldRootId = bundle.root.id;
  const nativeId = bundle.root.source.nativeSessionId ?? oldRootId.replace(/^claude-code:/, '');
  const newRootId = 'claude-desktop:' + nativeId;

  bundle.root.id = newRootId;
  bundle.root.source.agent = CLAUDE_DESKTOP_AGENT_ID;
  if (metaOverride !== undefined) {
    if (bundle.root.meta.title === undefined && metaOverride.title !== undefined) {
      bundle.root.meta.title = metaOverride.title;
    } else if (metaOverride.title !== undefined && bundle.root.meta.title !== undefined && metaOverride.mode === 'cowork') {
      bundle.root.meta.title = metaOverride.title;
    }
    if (bundle.root.meta.cwd === undefined && metaOverride.cwd !== undefined) bundle.root.meta.cwd = metaOverride.cwd;
    if (metaOverride.archived === true) bundle.root.meta.archived = true;
  }

  const oldPrefix = oldRootId + ':';
  for (const child of bundle.children) {
    child.session.source.agent = CLAUDE_DESKTOP_AGENT_ID;
    child.parentSessionId = newRootId;
    if (child.session.id.startsWith(oldPrefix)) {
      child.session.id = newRootId + ':' + child.session.id.slice(oldPrefix.length);
    }
  }
  return bundle;
}

/** 读取 Claude Desktop 会话（支持直接传 .jsonl 路径、cliSessionId、local_<id> 或 'last'） */
export async function readClaudeDesktopSession(input: string, options: ReadClaudeDesktopOptions = {}): Promise<IrBundle> {
  const desktopDirs = claudeDesktopDirs(options.desktopHome);
  const codeMetaByCliId = scanClaudeDesktopCodeMetadata(desktopDirs);
  const coworkSessions = scanClaudeDesktopCoworkSessions(desktopDirs);
  const configDir = resolveClaudeConfigDirForDesktop({
    home: options.home ?? options.configDir,
    claudeConfigDir: options.claudeConfigDir,
  });

  const readAndRebrand = async (filePath: string, metaOverride?: ClaudeDesktopSessionMeta): Promise<IrBundle> => {
    let resolvedTitle = options.title;
    if (resolvedTitle === undefined && metaOverride?.title !== undefined) {
      const inspected = await readClaudeFileSummary(filePath, 'session', { agent: CLAUDE_DESKTOP_AGENT_ID });
      resolvedTitle = inspected?.customTitle ?? metaOverride.title;
    }
    const bundle = await readClaudeSession(filePath, {
      ...options,
      configDir,
      ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
    });
    return rebrandBundleAsClaudeDesktop(bundle, metaOverride);
  };

  const trimmed = input.trim();
  if (trimmed.endsWith('.jsonl') && existsSync(trimmed)) {
    const cliId = basename(trimmed, '.jsonl');
    const matchedMeta =
      codeMetaByCliId.get(cliId) ?? coworkSessions.find((item) => item.cliSessionId === cliId || item.transcriptPath === trimmed);
    return readAndRebrand(trimmed, matchedMeta);
  }

  if (trimmed === 'last') {
    const latest = (await listClaudeDesktopSessions({
      home: options.desktopHome,
      claudeConfigDir: configDir,
      limit: 1,
    }))[0];
    if (latest === undefined) throw new Error('找不到任何 Claude Desktop 会话');
    return readClaudeDesktopSession(latest.nativePath, options);
  }

  const normalizedId = trimmed.startsWith('local_') ? trimmed : 'local_' + trimmed;
  const coworkMatch = coworkSessions.find(
    (item) =>
      item.cliSessionId === trimmed ||
      item.desktopSessionId === trimmed ||
      item.desktopSessionId === normalizedId ||
      item.cliSessionId.startsWith(trimmed) ||
      item.desktopSessionId.startsWith(trimmed),
  );
  if (coworkMatch?.transcriptPath !== undefined) {
    return readAndRebrand(coworkMatch.transcriptPath, coworkMatch);
  }

  // 把桌面端的 local_<uuid> 映射回对应 cliSessionId
  let codeMetaMatch = codeMetaByCliId.get(trimmed);
  if (codeMetaMatch === undefined) {
    for (const meta of codeMetaByCliId.values()) {
      if (
        meta.desktopSessionId === trimmed ||
        meta.desktopSessionId === normalizedId ||
        meta.cliSessionId.startsWith(trimmed) ||
        meta.desktopSessionId.startsWith(trimmed)
      ) {
        codeMetaMatch = meta;
        break;
      }
    }
  }
  const targetCliId = codeMetaMatch?.cliSessionId ?? trimmed;
  const jsonlPath = findDesktopCodeJsonl(projectsDir(configDir), targetCliId);
  if (jsonlPath !== undefined) {
    return readAndRebrand(jsonlPath, codeMetaMatch ?? codeMetaByCliId.get(basename(jsonlPath, '.jsonl')));
  }

  throw new Error('找不到 Claude Desktop 会话: ' + input);
}

export const claudeDesktopAdapter: AgentAdapter = {
  id: CLAUDE_DESKTOP_AGENT_ID,
  displayName: 'Claude Desktop',
  sourcePrefixes: ['claude-desktop', 'claudedesktop'],
  read(input: string) {
    return readClaudeDesktopSession(input);
  },
};
