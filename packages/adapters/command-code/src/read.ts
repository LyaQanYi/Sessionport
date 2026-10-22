import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { IR_VERSION, bundleEventCount } from '@sessionport/core';
import type { IrBundle, IrContent, IrEvent, IrEventInput, IrMessageEvent, IrNotice, IrPart, IrSession, SourceFingerprint } from '@sessionport/core';

import {
  commandCodeHome,
  commandCodeProjectsDir,
  isCcEntry,
  isCcHeader,
  isCcTranscriptFileName,
  isoToMs,
  normalizeIso,
  parseJsonl,
} from './wire.ts';
import type { CcBlock, CcEntry, CcImageBlock, CcMetaFile, CcSessionHeader } from './wire.ts';

const SYSTEM_REMINDER_PREFIX = '<system-reminder>';

export interface ReadCommandCodeOptions {
  /** 覆盖数据根目录（默认 ~/.commandcode）。CLI 自身只认 $HOME，这里主要给测试/预览用 */
  home?: string;
  /** 输入是目录（项目目录 / 数据根目录）时选择哪个会话；也用于按 id 前缀解析 */
  sessionId?: string;
  /** 源端 CLI 版本，探测不到就留空 */
  cliVersion?: string;
  /** 是否把源端原始 payload 放进 _native（默认 true） */
  keepNative?: boolean;
}

interface ResolvedSessionFile {
  filePath: string;
  metaPath: string;
  sessionId: string;
}

function sessionFileMetaPath(filePath: string): string {
  return filePath.endsWith('.jsonl') ? filePath.slice(0, -'.jsonl'.length) + '.meta.json' : filePath + '.meta.json';
}

async function readMetaFile(metaPath: string): Promise<CcMetaFile | undefined> {
  if (!existsSync(metaPath)) return undefined;
  try {
    const value = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
    return typeof value === 'object' && value !== null ? (value as CcMetaFile) : undefined;
  } catch {
    return undefined;
  }
}

async function listTranscriptFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter(isCcTranscriptFileName);
  } catch {
    return [];
  }
}

/** 在 <home>/projects/<slug>/ 里按会话 id（或唯一前缀）找 transcript */
async function findSessionFileById(home: string, idRef: string): Promise<ResolvedSessionFile> {
  const projectsRoot = commandCodeProjectsDir(home);
  const ids: Array<{ id: string; filePath: string }> = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    projectDirs = [];
  }
  for (const projectDirName of projectDirs) {
    const dir = join(projectsRoot, projectDirName);
    for (const name of await listTranscriptFiles(dir)) {
      ids.push({ id: name.slice(0, -'.jsonl'.length), filePath: join(dir, name) });
    }
  }
  const exact = ids.filter((entry) => entry.id === idRef);
  const prefix = ids.filter((entry) => entry.id.startsWith(idRef));
  const matches = exact.length > 0 ? exact : prefix;
  if (matches.length === 0) {
    throw new Error('找不到 Command Code 会话: ' + idRef + '（在 ' + projectsRoot + ' 下按 id 搜索）');
  }
  if (matches.length > 1) {
    throw new Error('会话 id 前缀有歧义: ' + idRef + ' -> ' + matches.map((entry) => entry.id).join(', '));
  }
  const hit = matches[0]!;
  return { filePath: hit.filePath, metaPath: sessionFileMetaPath(hit.filePath), sessionId: hit.id };
}

async function resolveFromHomeRoot(home: string, sessionId?: string): Promise<ResolvedSessionFile> {
  if (sessionId) return findSessionFileById(home, sessionId);
  const projectsRoot = commandCodeProjectsDir(home);
  const projectDirs = (await readdir(projectsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  let newest: { filePath: string; mtime: number } | undefined;
  for (const projectDirName of projectDirs) {
    const dir = join(projectsRoot, projectDirName);
    for (const name of await listTranscriptFiles(dir)) {
      const filePath = join(dir, name);
      const st = await stat(filePath);
      if (!newest || st.mtimeMs > newest.mtime) newest = { filePath, mtime: st.mtimeMs };
    }
  }
  if (!newest) throw new Error('数据根目录下没有 transcript: ' + projectsRoot);
  return {
    filePath: newest.filePath,
    metaPath: sessionFileMetaPath(newest.filePath),
    sessionId: basename(newest.filePath, '.jsonl'),
  };
}

async function resolveInput(input: string, options: ReadCommandCodeOptions): Promise<ResolvedSessionFile> {
  const home = commandCodeHome(options.home);
  const ref = input.trim();
  if (!ref) throw new Error('readCommandCodeSession: input 为空');
  const absolute = resolve(ref);
  if (existsSync(absolute)) {
    const st = await stat(absolute);
    if (st.isFile()) {
      if (!absolute.endsWith('.jsonl') || !isCcTranscriptFileName(absolute)) {
        throw new Error('不是 Command Code transcript 文件: ' + absolute);
      }
      return {
        filePath: absolute,
        metaPath: sessionFileMetaPath(absolute),
        sessionId: basename(absolute, '.jsonl'),
      };
    }
    if (st.isDirectory()) {
      if (existsSync(join(absolute, 'projects'))) return resolveFromHomeRoot(absolute, options.sessionId);
      const names = await listTranscriptFiles(absolute);
      if (names.length === 0) {
        throw new Error('目录里没有 Command Code transcript（*.jsonl，排除 checkpoints）: ' + absolute);
      }
      let picked: string | undefined;
      if (options.sessionId) {
        picked = names.find((name) => name === options.sessionId + '.jsonl')
          ?? names.find((name) => name.startsWith(options.sessionId as string));
      }
      if (!picked) {
        let newestMs = -1;
        for (const name of names) {
          const st2 = await stat(join(absolute, name));
          if (st2.mtimeMs > newestMs) {
            newestMs = st2.mtimeMs;
            picked = name;
          }
        }
      }
      const filePath = join(absolute, picked as string);
      return { filePath, metaPath: sessionFileMetaPath(filePath), sessionId: basename(filePath, '.jsonl') };
    }
  }
  return findSessionFileById(home, options.sessionId ?? ref);
}

function imageRef(block: CcImageBlock): string {
  const media = block.source?.media_type ?? 'image/png';
  return 'data:' + media + ';base64,' + (block.source?.data ?? '');
}

function mapToolResultBlockContent(block: CcBlock, skipped: Map<string, number>): IrContent {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return { type: 'image', ref: imageRef(block) };
  skipped.set('tool_result:' + String((block as { type?: string }).type), (skipped.get('tool_result:' + String((block as { type?: string }).type)) ?? 0) + 1);
  return { type: 'json', value: block };
}

function mapToolResultContent(content: CcBlock[] | string | undefined, skipped: Map<string, number>): IrContent[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'json', value: content }];
  return content.map((block) => mapToolResultBlockContent(block, skipped));
}

function textPartsOfContent(content: string | CcBlock[]): IrPart[] {
  const parts: IrPart[] = [];
  if (typeof content === 'string') {
    if (content.length > 0) parts.push({ type: 'text', text: content });
    return parts;
  }
  for (const block of content) {
    if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text });
    if (block.type === 'image') parts.push({ type: 'image', ref: imageRef(block) });
  }
  return parts;
}

export interface ReadCommandCodeResult {
  bundle: IrBundle;
  filePath: string;
  metaPath: string;
  sessionId: string;
}

interface MappingContext {
  keepNative: boolean;
  skippedBlocks: Map<string, number>;
  entryCounts: Map<string, number>;
  sourceCounts: Map<string, number>;
  subagentCalls: number;
  orphanResults: number;
  missingResults: number;
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
}

function pushIfKeep(context: MappingContext, event: IrEvent, native: unknown): IrEvent {
  if (context.keepNative) event._native = native;
  return event;
}

/** 把一条 message entry 映射成 0..n 个 IR 事件（id/parentId 由调用方补） */
function mapMessageEntry(entry: CcEntry, context: MappingContext): Array<IrEventInput> {
  if (entry.type !== 'message') return [];
  const message = entry.message;
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const synthetic = message.meta?.isMeta === true;
  const source = typeof message.meta?.source === 'string' ? message.meta.source : undefined;
  if (source) context.sourceCounts.set(source, (context.sourceCounts.get(source) ?? 0) + 1);
  const out: Array<IrEventInput> = [];
  let pendingParts: IrPart[] = [];
  const at = normalizeIso(entry.timestamp) ?? new Date(0).toISOString();
  const flushParts = (): void => {
    if (pendingParts.length === 0) return;
    const event: Omit<IrMessageEvent, 'id' | 'parentId'> = {
      kind: 'message',
      at,
      role,
      parts: pendingParts,
    };
    if (synthetic) event.synthetic = true;
    out.push(pushIfKeep(context, event as IrEvent, { entryId: entry.id, blocks: pendingParts }) as IrEventInput);
    pendingParts = [];
  };
  const content = Array.isArray(message.content) ? message.content : [];
  if (!Array.isArray(message.content)) {
    context.skippedBlocks.set('content:' + typeof message.content, (context.skippedBlocks.get('content:' + typeof message.content) ?? 0) + 1);
  }
  for (const block of content) {
    const type = (block as { type?: string }).type;
    if (type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) pendingParts.push({ type: 'text', text });
      continue;
    }
    if (type === 'image') {
      pendingParts.push({ type: 'image', ref: imageRef(block as CcImageBlock) });
      continue;
    }
    if (type === 'thinking') {
      flushParts();
      const thinking = typeof (block as { thinking?: unknown }).thinking === 'string' ? (block as { thinking: string }).thinking : '';
      if (thinking.length === 0) continue;
      const signature = typeof (block as { signature?: unknown }).signature === 'string' ? (block as { signature: string }).signature : '';
      const reasoning = signature.length > 0 ? { kind: 'plain' as const, text: thinking, signature } : { kind: 'plain' as const, text: thinking };
      out.push(pushIfKeep(context, { kind: 'reasoning', at, reasoning } as IrEvent, block) as IrEventInput);
      continue;
    }
    if (type === 'tool_use') {
      flushParts();
      const id = typeof (block as { id?: unknown }).id === 'string' ? (block as { id: string }).id : '';
      const name = typeof (block as { name?: unknown }).name === 'string' ? (block as { name: string }).name : 'unknown';
      if (id.length === 0) {
        context.skippedBlocks.set('tool_use:no-id', (context.skippedBlocks.get('tool_use:no-id') ?? 0) + 1);
        continue;
      }
      context.toolUseIds.add(id);
      if (name === 'agent') context.subagentCalls += 1;
      out.push(pushIfKeep(context, {
        kind: 'tool_call',
        at,
        callId: id,
        name,
        input: (block as { input?: unknown }).input ?? null,
      } as IrEvent, block) as IrEventInput);
      continue;
    }
    if (type === 'tool_result') {
      flushParts();
      const callId = typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string' ? (block as { tool_use_id: string }).tool_use_id : '';
      if (callId.length === 0) {
        context.skippedBlocks.set('tool_result:no-id', (context.skippedBlocks.get('tool_result:no-id') ?? 0) + 1);
        continue;
      }
      context.toolResultIds.add(callId);
      const event: IrEventInput = {
        kind: 'tool_result',
        at,
        callId,
        content: mapToolResultContent((block as { content?: CcBlock[] | string }).content, context.skippedBlocks),
      };
      if ((block as { is_error?: unknown }).is_error === true) (event as { isError?: boolean }).isError = true;
      out.push(pushIfKeep(context, event as IrEvent, block) as IrEventInput);
      continue;
    }
    context.skippedBlocks.set('block:' + String(type), (context.skippedBlocks.get('block:' + String(type)) ?? 0) + 1);
  }
  flushParts();
  return out;
}

function bumpEntry(context: MappingContext, type: string): void {
  context.entryCounts.set(type, (context.entryCounts.get(type) ?? 0) + 1);
}

export interface ReadCommandCodeDetailedResult extends ReadCommandCodeResult {
  metaFile?: CcMetaFile;
  header: CcSessionHeader;
  notices: IrNotice[];
}

/** 读一份 transcript 并返回 bundle + 路径信息（CLI 里 stat 输出用） */
export async function readCommandCodeSessionDetailed(
  input: string,
  options: ReadCommandCodeOptions = {},
): Promise<ReadCommandCodeDetailedResult> {
  const resolved = await resolveInput(input, options);
  const text = await readFile(resolved.filePath, 'utf8');
  const parsed = parseJsonl(text);
  if (parsed.records.length === 0) throw new Error('空 transcript: ' + resolved.filePath);
  const first = parsed.records[0];
  if (!isCcHeader(first)) {
    const version = (first as { version?: unknown } | null)?.version;
    if (typeof version === 'number' && version > 3) {
      throw new Error('会话格式 v' + version + ' 高于本 adapter 支持的 v3：' + resolved.filePath);
    }
    throw new Error('不是 Command Code v3 会话（首行缺合法 session 头）: ' + resolved.filePath);
  }
  const header = first;
  const metaFile = await readMetaFile(resolved.metaPath);

  const context: MappingContext = {
    keepNative: options.keepNative !== false,
    skippedBlocks: new Map(),
    entryCounts: new Map(),
    sourceCounts: new Map(),
    subagentCalls: 0,
    orphanResults: 0,
    missingResults: 0,
    toolUseIds: new Set(),
    toolResultIds: new Set(),
  };
  const notices: IrNotice[] = [];
  const events: IrEvent[] = [];
  let invalidEntries = 0;
  let index = 0;
  let model: string | undefined;
  let effort: string | undefined;
  let sessionInfoName: string | undefined;
  let lastAt: string | undefined;
  let firstUserText: string | undefined;

  const appendEvent = (event: IrEventInput): void => {
    index += 1;
    const withIds = event as IrEvent;
    withIds.id = 'cc:e' + String(index).padStart(6, '0');
    withIds.parentId = events.length > 0 ? events[events.length - 1]!.id : null;
    events.push(withIds);
  };

  for (const record of parsed.records.slice(1)) {
    if (!isCcEntry(record)) {
      invalidEntries += 1;
      continue;
    }
    const entry = record;
    if (lastAt === undefined || (isoToMs(entry.timestamp) ?? 0) > (isoToMs(lastAt) ?? 0)) lastAt = entry.timestamp;
    if (entry.type === 'message') {
      const message = entry.message;
      if (message?.role === 'assistant' && typeof entry.model === 'string') model = entry.model;
      if (message?.role === 'assistant' && typeof entry.effort === 'string') effort = entry.effort;
      if (typeof message?.meta?.source === 'string' && !context.sourceCounts.has(message.meta.source)) {
        context.sourceCounts.set(message.meta.source, 1);
      }
      const mapped = mapMessageEntry(entry, context);
      for (const event of mapped) appendEvent(event);
      if (firstUserText === undefined && message?.role === 'user') {
        const parts = textPartsOfContent(message.content);
        const firstText = parts.find((part) => part.type === 'text');
        if (firstText && firstText.type === 'text') firstUserText = firstText.text.slice(0, 120);
      }
      continue;
    }
    if (entry.type === 'compaction') {
      bumpEntry(context, entry.type);
      const detail = 'tokensBefore=' + String(entry.tokensBefore ?? '?')
        + ' firstKeptEntryId=' + String(entry.firstKeptEntryId ?? '?')
        + (entry.fromMod === true ? ' fromMod=true' : '');
      appendEvent(pushIfKeep(context, { kind: 'boundary', at: normalizeIso(entry.timestamp) ?? new Date(0).toISOString(), boundary: 'compact', detail } as IrEvent, entry) as IrEventInput);
      continue;
    }
    if (entry.type === 'branch_summary') {
      bumpEntry(context, entry.type);
      appendEvent(pushIfKeep(context, { kind: 'boundary', at: normalizeIso(entry.timestamp) ?? new Date(0).toISOString(), boundary: 'fork', detail: 'branch_summary' } as IrEvent, entry) as IrEventInput);
      continue;
    }
    if (entry.type === 'custom_message') {
      bumpEntry(context, entry.type);
      const parts = textPartsOfContent(entry.content);
      if (parts.length > 0) {
        const event: Omit<IrMessageEvent, 'id' | 'parentId'> = {
          kind: 'message',
          at: normalizeIso(entry.timestamp) ?? new Date(0).toISOString(),
          role: 'user',
          parts,
          synthetic: true,
        };
        appendEvent(pushIfKeep(context, event as IrEvent, entry) as IrEventInput);
      }
      continue;
    }
    if (entry.type === 'session_info') {
      bumpEntry(context, entry.type);
      if (typeof entry.name === 'string' && entry.name.length > 0) sessionInfoName = entry.name;
      continue;
    }
    if (entry.type === 'model_change') {
      bumpEntry(context, entry.type);
      if (typeof entry.model === 'string') model = entry.model;
      continue;
    }
    if (entry.type === 'effort_change') {
      bumpEntry(context, entry.type);
      if (typeof entry.effort === 'string') effort = entry.effort;
      continue;
    }
    bumpEntry(context, entry.type);
  }

  for (const id of context.toolUseIds) if (!context.toolResultIds.has(id)) context.missingResults += 1;
  for (const id of context.toolResultIds) if (!context.toolUseIds.has(id)) context.orphanResults += 1;

  if (parsed.badLines > 0) {
    notices.push({ code: 'command-code.bad-lines', message: '有无法解析的 JSON 行（loader 会按 corrupted 丢弃）', count: parsed.badLines, severity: 'warning' });
  }
  if (invalidEntries > 0) {
    notices.push({ code: 'command-code.invalid-entries', message: '有不符合 v3 entry 形状的行（缺 id/parentId/timestamp 或未知 type）', count: invalidEntries, severity: 'warning' });
  }
  let skippedTotal = 0;
  for (const [key, count] of context.skippedBlocks) {
    skippedTotal += count;
    notices.push({ code: 'command-code.unknown-block', message: '未映射的 content block：' + key, count, severity: 'warning' });
  }
  let ignoredEntries = 0;
  for (const [type, count] of context.entryCounts) {
    ignoredEntries += count;
    const label = type === 'compaction' ? 'compaction 边界已映射为 boundary(compact)，摘要保留在 _native'
      : type === 'branch_summary' ? 'branch_summary 已映射为 boundary(fork)，摘要保留在 _native'
      : type === 'custom_message' ? 'custom_message 已映射为 synthetic user message'
      : type === 'session_info' ? 'session_info 用于覆盖标题'
      : type === 'model_change' || type === 'effort_change' ? '模型/推理档位变更已合并进 meta'
      : '该 entry 类型没有 IR 对应物，已跳过';
    notices.push({ code: 'command-code.entry-' + type, message: label, count, severity: type === 'custom' || type === 'label' ? 'info' : 'info' });
  }
  if (context.sourceCounts.size > 0) {
    for (const [source, count] of context.sourceCounts) {
      if (source === 'user' || source === 'model' || source === 'tool') continue;
      notices.push({ code: 'command-code.message-source', message: '非标准 message.meta.source：' + source, count, severity: 'info' });
    }
  }
  if (context.subagentCalls > 0) {
    notices.push({ code: 'command-code.subagent-not-exported', message: 'agent 工具调用（子代理）没有独立 transcript，已作为普通 tool_call 保留', count: context.subagentCalls, severity: 'info' });
  }
  if (context.missingResults > 0 || context.orphanResults > 0) {
    notices.push({ code: 'command-code.tool-pairing', message: '工具调用/结果未能完全配对（缺失 ' + context.missingResults + '，孤立 ' + context.orphanResults + '）', count: context.missingResults + context.orphanResults, severity: 'warning' });
  }
  if (typeof header.parentSession === 'string' && header.parentSession.length > 0) {
    notices.push({ code: 'command-code.forked-session', message: '该会话由 fork/clone 产生，父 transcript：' + header.parentSession, severity: 'info' });
  }
  if (metaFile?.entrypoint === 'print') {
    notices.push({ code: 'command-code.print-entrypoint', message: '该会话由 -p/print 模式产生（entrypoint=print）', severity: 'info' });
  }
  if (firstUserText !== undefined && /^<system-reminder>/.test(firstUserText)) {
    notices.push({ code: 'command-code.system-reminder', message: '首条用户消息以 <system-reminder> 开头', severity: 'info' });
  }

  const createdAt = normalizeIso(header.timestamp);
  const updatedAt = lastAt === undefined ? undefined : normalizeIso(lastAt);
  const source: SourceFingerprint = {
    agent: 'command-code',
    formatVersion: String(header.version),
    nativeSessionId: header.id,
    nativePath: resolved.filePath,
  };
  if (options.cliVersion) source.cliVersion = options.cliVersion;

  const meta: IrSession['meta'] = {
    cwd: header.cwd,
    createdAt,
    updatedAt,
  };
  const title = metaFile?.title ?? sessionInfoName;
  if (title) meta.title = title;
  if (model ?? metaFile?.model) meta.model = model ?? metaFile?.model;
  if (typeof metaFile?.entrypoint === 'string') meta.profile = metaFile.entrypoint;
  if (effort !== undefined) {
    notices.push({ code: 'command-code.effort', message: '源端推理档位 effort=' + effort + '（IR 无对应字段，未导出）', severity: 'info' });
  }

  const session: IrSession = {
    id: 'command-code:' + header.id,
    source,
    meta,
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };
  const bundle: IrBundle = {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: session,
    children: [],
  };
  return { bundle, filePath: resolved.filePath, metaPath: resolved.metaPath, sessionId: header.id, metaFile, header, notices };
}

/**
 * 读取 Command Code 会话 -> IrBundle。
 *
 * input 支持：
 * - transcript 路径（*.jsonl）
 * - 会话 uuid（或唯一前缀；在 <home>/projects/<slug>/ 下搜索）
 * - 项目目录 / 数据根目录（多会话时取最新，或由 opts.sessionId 指定）
 */
export async function readCommandCodeSession(input: string, options: ReadCommandCodeOptions = {}): Promise<IrBundle> {
  const detailed = await readCommandCodeSessionDetailed(input, options);
  return detailed.bundle;
}

/** 粗略统计，供 CLI 打印 */
export function summarizeCommandCodeBundle(bundle: IrBundle): string {
  const lines = [
    'root ' + bundle.root.id + '  events=' + bundle.root.events.length + '  cwd=' + (bundle.root.meta.cwd ?? '?'),
    '  title=' + (bundle.root.meta.title ?? '(none)') + '  model=' + (bundle.root.meta.model ?? '?'),
  ];
  for (const notice of bundle.root.notices) {
    lines.push('  notice [' + notice.severity + '] ' + notice.code + ' x' + (notice.count ?? 1) + ' — ' + notice.message);
  }
  lines.push('total events=' + bundleEventCount(bundle));
  return lines.join('\n');
}

