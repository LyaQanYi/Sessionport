/**
 * DSH 会话列表（只读元数据，不解析对话全文）。
 *
 * 数据源：<DSH_HOME>/sessions/<projectKey>/<sessionDir>/session.v<N>.jsonl.zstd（默认 ~/.dsh）
 * - 会话头在第一帧：readZstdHeaderLine 只解首帧，成本很低，拿 id/cwd/createdAt/parentSession
 * - 标题取投影缓存 <DSH_HOME>/storages/session_projcache/sessions/<id>.json 的 record.rows.title.val；
 *   没有缓存时，从文件头部 256KB 的完整帧里找首条 user/message（仍然不读全文）
 * - updatedAt 用日志文件 mtime（DSH 是追加写）
 *
 * 容错：sessions 目录不存在返回 []；坏 zstd / 缺头 / 无日志的会话目录跳过。
 */
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { finalizeSessionList } from '@sessionport/core';
import type { ListSessionsOptions, SessionSummary } from '@sessionport/core';

import { dshHome, findLogInDir, readdirSafe, sessionsRoot } from './paths.ts';
import { readZstdHeaderLine, scanZstdFrames } from './zstd.ts';

/** 找标题兜底时最多读这么多字节的日志头（只解完整帧） */
const HEAD_BYTES = 256 * 1024;

interface DshSessionHeader {
  type?: string;
  id?: string;
  version?: number;
  createdAt?: number;
  cwd?: string;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
}

interface DshProjCacheInfo {
  title?: string;
  cwd?: string;
  createdAt?: number;
}

export async function listDshSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const home = dshHome(options.home);
  const root = sessionsRoot(home);
  const cache = await loadProjCache(home);
  const summaries: SessionSummary[] = [];

  for (const project of await readdirSafe(root)) {
    const projectDir = join(root, project);
    for (const sessionDirName of await readdirSafe(projectDir)) {
      const sessionDir = join(projectDir, sessionDirName);
      const summary = await readDshSummary(sessionDir, cache);
      if (summary !== undefined) summaries.push(summary);
    }
  }
  return finalizeSessionList(summaries, options.limit);
}

async function readDshSummary(sessionDir: string, cache: Map<string, DshProjCacheInfo>): Promise<SessionSummary | undefined> {
  const logPath = await findLogInDir(sessionDir);
  if (logPath === undefined) return undefined;
  const info = await stat(logPath).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;

  let header: DshSessionHeader;
  try {
    header = JSON.parse(await readZstdHeaderLine(logPath)) as DshSessionHeader;
  } catch {
    return undefined; // 坏日志（撕裂/无头）跳过
  }
  if (header === null || typeof header !== 'object') return undefined;
  const sessionId = typeof header.id === 'string' && header.id.length > 0 ? header.id : basename(sessionDir);
  const cached = cache.get(sessionId);

  const summary: SessionSummary = {
    agent: 'dsh',
    sessionId,
    nativePath: logPath,
    resumeHint: 'dsh headless --session-id ' + sessionId,
  };
  const title = cached?.title ?? (await readFirstUserText(logPath));
  if (title !== undefined) summary.title = title;
  const cwd = textOf(header.cwd) ?? cached?.cwd;
  if (cwd !== undefined) summary.cwd = cwd;
  const createdAt = msToIso(header.createdAt) ?? msToIso(cached?.createdAt);
  if (createdAt !== undefined) summary.createdAt = createdAt;
  summary.updatedAt = info.mtime.toISOString();
  const parentSessionId = textOf(header.parentSession);
  if (parentSessionId !== undefined) summary.parentSessionId = parentSessionId;
  return summary;
}

/** 投影缓存：<home>/storages/session_projcache/sessions/<sessionId>.json */
async function loadProjCache(home: string): Promise<Map<string, DshProjCacheInfo>> {
  const cache = new Map<string, DshProjCacheInfo>();
  const dir = join(home, 'storages', 'session_projcache', 'sessions');
  const names = await readdirSafe(dir);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -'.json'.length);
    try {
      const value = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        record?: { rows?: Record<string, { val?: unknown }>; identity?: { cwd?: unknown; createdAt?: unknown } };
      };
      const record = value.record;
      const title = textOf(record?.rows?.['title']?.val);
      const cwd = textOf(record?.identity?.cwd);
      const createdAt = typeof record?.identity?.createdAt === 'number' ? record.identity.createdAt : undefined;
      if (title !== undefined || cwd !== undefined || createdAt !== undefined) {
        const entry: DshProjCacheInfo = {};
        if (title !== undefined) entry.title = title;
        if (cwd !== undefined) entry.cwd = cwd;
        if (createdAt !== undefined) entry.createdAt = createdAt;
        cache.set(sessionId, entry);
      }
    } catch {
      // 坏缓存跳过
    }
  }
  return cache;
}

/** 从日志头部完整 zstd 帧里找首条真实 user/message 文本（不读全文） */
async function readFirstUserText(logPath: string): Promise<string | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readHead(logPath, HEAD_BYTES);
  } catch {
    return undefined;
  }
  let frames;
  try {
    frames = scanZstdFrames(buffer).frames;
  } catch {
    return undefined;
  }
  for (const frame of frames) {
    let text: string;
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== 'user/message') continue;
      const data = event.data;
      if (data === null || typeof data !== 'object') continue;
      const dataRecord = data as Record<string, unknown>;
      const source = dataRecord.source;
      const sourceKind = source !== null && typeof source === 'object' ? textOf((source as Record<string, unknown>).kind) : undefined;
      // 只认真人输入；time-context / runtime-context 等注入不算标题
      if (sourceKind !== undefined && sourceKind !== 'user' && sourceKind !== 'user-approval' && sourceKind !== 'agent-message') continue;
      const content = dataRecord.content;
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
      }
      const joined = texts.join('\n').replace(/\s+/gu, ' ').trim();
      if (joined.length === 0) continue;
      return joined.length > 100 ? joined.slice(0, 100) + '…' : joined;
    }
  }
  return undefined;
}

async function readHead(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const size = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function msToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
