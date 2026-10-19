import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute } from 'node:path';

import { LossCollector } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrContent, IrEvent, IrSession, LossEntry, WriteReport } from '@sessionport/core';

import {
  isoToMs,
  ccSessionPaths,
  commandCodeHome,
  commandCodeProjectDir,
  newEntryId,
  normalizeIso,
} from './wire.ts';
import type { CcBlock, CcEntry, CcImageBlock, CcMessageEntry, CcSessionHeader, CcToolResultBlock } from './wire.ts';
import { registerCommandCodeThread } from './register.ts';
import type { RegisterResult } from './register.ts';

/** Command Code 能力声明：thinking 可原样写回（探针 v3/v12 实测），工具结果独立成 user 消息 */
export const COMMAND_CODE_CAPS: ExportCaps = {
  agent: 'command-code',
  reasoning: 'plain',
  toolResults: 'separate',
  branching: false,
  subagents: false,
  modelPinned: false,
};

export interface WriteCommandCodeOptions {
  /** 目标数据根目录，默认 ~/.commandcode（测试请传工作区内临时目录） */
  home?: string;
  /** 目标项目 cwd，默认取 bundle.root.meta.cwd */
  cwd?: string;
  /** 目标会话 uuid，默认随机 */
  id?: string;
  /** assistant 行的 model 字段，默认取 IR meta.model */
  model?: string;
  /** <id>.meta.json 的 title，默认取 IR meta.title */
  title?: string;
  /** 只生成不落盘 */
  dryRun?: boolean;
  /** 写完后注册进 Command Code 桌面端列表（thread-index.db + app-state.json） */
  register?: boolean;
  /** 桌面端数据目录覆盖（默认 ~/Library/Application Support/Command Code） */
  userDataDir?: string;
}

export interface WriteCommandCodeResult extends WriteReport {
  /** 写入的 entry（不含 session 头） */
  rows: CcEntry[];
  /** 桌面端注册结果（未启用 register 时为 undefined） */
  registration?: RegisterResult;
  header: CcSessionHeader;
  filePath: string;
  metaPath: string;
  projectDir: string;
  cwd: string;
  /** 计划中但未写的 sidecar（checkpoints / history） */
  plannedSidecars: string[];
}

interface Chunk {
  role: 'user' | 'assistant';
  at: string;
  isMeta?: boolean;
  source: 'user' | 'model' | 'tool';
  blocks: CcBlock[];
  toolUseIds: string[];
  toolResultIds: string[];
}

type Item = { kind: 'chunk'; chunk: Chunk } | { kind: 'native'; at: string; entry: CcEntry };

interface BuildResult {
  items: Item[];
  losses: LossCollector;
  counts: { messages: number; toolCalls: number; toolResults: number; reasoning: number };
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** IR 的 image ref（data URL 或绝对路径）-> Command Code base64 image block */
async function imageBlockFromRef(ref: string, losses: LossCollector): Promise<CcImageBlock | undefined> {
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  if (ref.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(ref);
    if (match && match[1]) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] ?? '' } };
    losses.add('command-code.image-dropped', 'IR image ref 是 data URL 但无法解析，已丢弃', { severity: 'info' });
    return undefined;
  }
  if (isAbsolute(ref) && existsSync(ref)) {
    try {
      const data = await readFile(ref);
      const media = MIME_BY_EXT[extname(ref).toLowerCase()] ?? 'image/png';
      return { type: 'image', source: { type: 'base64', media_type: media, data: data.toString('base64') } };
    } catch {
      losses.add('command-code.image-dropped', 'IR image ref 指向的文件读取失败，已丢弃', { severity: 'info' });
      return undefined;
    }
  }
  losses.add('command-code.image-dropped', 'IR image ref 既不是 data URL 也不是可读文件路径，已丢弃', { severity: 'info' });
  return undefined;
}

async function contentBlocksFromIr(content: IrContent[], losses: LossCollector): Promise<CcBlock[]> {
  const blocks: CcBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image') {
      const image = await imageBlockFromRef(part.ref, losses);
      if (image) blocks.push(image);
      continue;
    }
    if (part.type === 'json') {
      blocks.push({ type: 'text', text: JSON.stringify(part.value) });
      continue;
    }
    blocks.push({ type: 'text', text: part.text });
  }
  return blocks;
}

async function messagePartsToBlocks(event: Extract<IrEvent, { kind: 'message' }>, losses: LossCollector): Promise<CcBlock[]> {
  const blocks: CcBlock[] = [];
  for (const part of event.parts) {
    if (part.type === 'text') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const image = await imageBlockFromRef(part.ref, losses);
    if (image) blocks.push(image);
  }
  return blocks;
}

function toolResultText(content: CcBlock[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block.type === 'text' ? block.text : '[' + block.type + ']')).join('\n');
}

async function buildItems(session: IrSession): Promise<BuildResult> {
  const losses = new LossCollector();
  const counts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };
  const items: Item[] = [];
  let assistant: Chunk | null = null;
  let results: Chunk | null = null;
  let fallbackAt: string | undefined;

  const pushChunk = (chunk: Chunk): void => {
    items.push({ kind: 'chunk', chunk });
  };
  const flushAssistant = (): void => {
    if (assistant && assistant.blocks.length > 0) pushChunk(assistant);
    assistant = null;
  };
  const flushResults = (): void => {
    if (results && results.blocks.length > 0) pushChunk(results);
    results = null;
  };
  const flushAll = (): void => {
    flushAssistant();
    flushResults();
  };
  const ensureAssistant = (at: string): Chunk => {
    flushResults();
    if (!assistant) assistant = { role: 'assistant', at, source: 'model', blocks: [], toolUseIds: [], toolResultIds: [] };
    return assistant;
  };
  const ensureResults = (at: string): Chunk => {
    flushAssistant();
    if (!results) results = { role: 'user', at, source: 'tool', blocks: [], toolUseIds: [], toolResultIds: [] };
    return results;
  };
  const eventAt = (event: IrEvent): string => {
    const iso = normalizeIso(event.at);
    if (iso) return iso;
    losses.add('command-code.invalid-timestamp', 'IR 事件时间戳不是合法 ISO 8601，已用邻近时间兜底', { severity: 'info' });
    return fallbackAt ?? new Date(0).toISOString();
  };

  for (const event of session.events) {
    const at = eventAt(event);
    fallbackAt = at;
    if (event.kind === 'message') {
      const blocks = await messagePartsToBlocks(event, losses);
      if (event.role === 'user') {
        flushAll();
        if (blocks.length === 0) {
          losses.add('command-code.empty-message-dropped', '空用户消息已丢弃', { severity: 'info' });
          continue;
        }
        const chunk: Chunk = { role: 'user', at, source: 'user', blocks, toolUseIds: [], toolResultIds: [] };
        if (event.synthetic) chunk.isMeta = true;
        pushChunk(chunk);
        counts.messages += 1;
        continue;
      }
      const chunk = ensureAssistant(at);
      chunk.blocks.push(...blocks);
      counts.messages += 1;
      continue;
    }
    if (event.kind === 'reasoning') {
      counts.reasoning += 1;
      if (event.reasoning.kind !== 'plain') {
        losses.add('command-code.reasoning-opaque-dropped', 'opaque reasoning 没有 Command Code 原生结构，已丢弃', { severity: 'warning' });
        continue;
      }
      if (event.reasoning.text.length === 0) continue;
      const chunk = ensureAssistant(at);
      const signature = event.reasoning.signature ?? '';
      chunk.blocks.push({ type: 'thinking', thinking: event.reasoning.text, signature });
      continue;
    }
    if (event.kind === 'tool_call') {
      const chunk = ensureAssistant(at);
      chunk.blocks.push({ type: 'tool_use', id: event.callId, name: event.name, input: event.input ?? {} });
      chunk.toolUseIds.push(event.callId);
      counts.toolCalls += 1;
      continue;
    }
    if (event.kind === 'tool_result') {
      const chunk = ensureResults(at);
      const content = await contentBlocksFromIr(event.content, losses);
      const block: CcToolResultBlock = { type: 'tool_result', tool_use_id: event.callId, content };
      if (event.isError === true) {
        losses.add('command-code.tool-error-flag-dropped', 'Command Code 的 tool_result 没有 is_error 字段，错误标记已丢弃（错误文本仍在 content 里）', { severity: 'info' });
      }
      chunk.blocks.push(block);
      chunk.toolResultIds.push(event.callId);
      counts.toolResults += 1;
      continue;
    }
    // boundary
    flushAll();
    const native = event._native as CcEntry | undefined;
    if (native && (native.type === 'compaction' || native.type === 'branch_summary')) {
      items.push({ kind: 'native', at, entry: native });
      continue;
    }
    losses.add('command-code.boundary-dropped', '会话边界事件（' + event.boundary + '：分支/撤销/压缩/取消）在 Command Code 中没有对应结构', { severity: 'info' });
  }
  flushAll();
  return { items, losses, counts };
}

function repairToolPairs(items: Item[], losses: LossCollector): Item[] {
  const out = items.slice();
  for (let index = 0; index < out.length; index += 1) {
    const item = out[index]!;
    if (item.kind !== 'chunk') continue;
    const chunk = item.chunk;
    if (chunk.role !== 'assistant' || chunk.toolUseIds.length === 0) continue;
    const next = out[index + 1];
    const nextIds = next && next.kind === 'chunk' && next.chunk.role === 'user' ? next.chunk.toolResultIds : [];
    const missing = chunk.toolUseIds.filter((id) => !nextIds.includes(id));
    if (missing.length === 0) continue;
    const synthetic: Chunk = {
      role: 'user',
      at: chunk.at,
      source: 'tool',
      blocks: missing.map((id) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: [{ type: 'text' as const, text: '[sessionport] 源会话里没有这条工具调用的结果' }],
      })),
      toolUseIds: [],
      toolResultIds: missing,
    };
    out.splice(index + 1, 0, { kind: 'chunk', chunk: synthetic });
    losses.add('command-code.tool-result-synthesized', '源会话里工具调用没有对应结果，已合成占位 tool_result 以保持可加载', { count: missing.length });
    index += 1;
  }
  const allUses = new Set<string>();
  for (const item of out) if (item.kind === 'chunk') for (const id of item.chunk.toolUseIds) allUses.add(id);
  for (const item of out) {
    if (item.kind !== 'chunk') continue;
    const chunk = item.chunk;
    if (chunk.role !== 'user' || chunk.toolResultIds.length === 0) continue;
    const keptBlocks: CcBlock[] = [];
    const keptIds: string[] = [];
    for (const block of chunk.blocks) {
      if (block.type === 'tool_result' && !allUses.has(block.tool_use_id)) {
        keptBlocks.push({ type: 'text', text: '[tool_result ' + block.tool_use_id + '] ' + toolResultText(block.content) });
        losses.add('command-code.orphan-tool-result', '孤立 tool_result（找不到对应 tool_use）已降级为文本', { severity: 'info' });
        continue;
      }
      keptBlocks.push(block);
      if (block.type === 'tool_result') keptIds.push(block.tool_use_id);
    }
    chunk.blocks = keptBlocks;
    chunk.toolResultIds = keptIds;
  }
  return out;
}

function materialize(items: Item[], context: { sessionId: string; cwd: string; model?: string; losses: LossCollector }): CcEntry[] {
  const rows: CcEntry[] = [];
  const used = new Set<string>();
  let parentId: string | null = null;
  let fallbackAt = new Date().toISOString();
  for (const item of items) {
    const id = newEntryId(used);
    used.add(id);
    if (item.kind === 'native') {
      const native = item.entry;
      const timestamp = normalizeIso(native.timestamp) ?? normalizeIso(item.at) ?? fallbackAt;
      fallbackAt = timestamp;
      const row = { ...native, id, parentId, timestamp } as CcEntry;
      rows.push(row);
      parentId = id;
      continue;
    }
    const chunk = item.chunk;
    const timestamp = normalizeIso(chunk.at) ?? fallbackAt;
    fallbackAt = timestamp;
    const createdAt = Date.parse(timestamp);
    const meta: Record<string, unknown> = {
      messageId: randomUUID(),
      source: chunk.source,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    };
    if (chunk.isMeta === true) meta.isMeta = true;
    const message: CcMessageEntry['message'] = {
      role: chunk.role,
      content: chunk.blocks,
      meta: meta as CcMessageEntry['message']['meta'],
    };
    const row: CcMessageEntry = { type: 'message', id, parentId, timestamp, message };
    if (chunk.role === 'assistant' && context.model) row.model = context.model;
    rows.push(row);
    parentId = id;
  }
  return rows;
}

/**
 * 把 IR 写成 Command Code v3 transcript + <id>.meta.json。
 *
 * 落盘位置：<home>/projects/<slug(cwd)>/<id>.jsonl（home 默认 ~/.commandcode）。
 * 结构校准依据：真实 23 个会话 + CLI 源码 createSessionStoreV3；resume 验收走
 * `cmd -p --session <file>`（已实测 RESUME_OK，见 .spikes/cc-verify）。
 */
export async function writeCommandCodeSession(bundle: IrBundle, options: WriteCommandCodeOptions = {}): Promise<WriteCommandCodeResult> {
  const session = bundle.root;
  const cwd = options.cwd ?? session.meta.cwd ?? process.cwd();
  const home = commandCodeHome(options.home);
  const sessionId = options.id ?? randomUUID();
  const model = options.model ?? session.meta.model;
  const projectDir = commandCodeProjectDir(home, cwd);
  const paths = ccSessionPaths(projectDir, sessionId);

  const built = await buildItems(session);
  const items = repairToolPairs(built.items, built.losses);
  const rows = materialize(items, { sessionId, cwd, model, losses: built.losses });
  const header: CcSessionHeader = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: session.meta.createdAt && normalizeIso(session.meta.createdAt)
      ? (normalizeIso(session.meta.createdAt) as string)
      : (rows[0]?.timestamp ?? new Date().toISOString()),
    cwd,
  };

  const losses = built.losses;
  const sourceAgent = session.source.agent;
  if (sourceAgent !== 'command-code') {
    losses.add('command-code.cross-agent-import', '会话来自 ' + sourceAgent + '，消息/工具语义按 Command Code 结构近似还原', { severity: 'info' });
  }
  if (model === undefined) {
    losses.add('command-code.model-omitted', 'IR 未提供模型，assistant 行不写 model 字段，目标端会回落到自身配置模型', { severity: 'info' });
  }
  if (bundle.children.length > 0) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('command-code.subagent-dropped', 'Command Code 没有独立的子代理会话 transcript，子代理会话未导出', { count: bundle.children.length });
    losses.add('command-code.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents });
  }
  if (session.notices.some((notice) => notice.code === 'kimi.undone-turns-dropped')) {
    losses.add('command-code.source-undo', '源端 undo 回滚的内容已在 IR 阶段裁掉，目标端看到的是回滚后的上下文', { severity: 'info' });
  }
  losses.add('command-code.sidecars-not-written', 'checkpoints/prompts/history/thread-index 等 UI 索引未写；resume 不需要它们，只是 /rewind 与历史列表里没有额外元数据', { severity: 'info' });

  const title = options.title ?? session.meta.title ?? 'Sessionport import';
  const metaFile = {
    entrypoint: 'interactive',
    title,
    ...(model ? { model } : {}),
    importedFrom: sourceAgent,
    importedAt: new Date().toISOString(),
  };

  let registration: RegisterResult | undefined;
  if (!options.dryRun) {
    await mkdir(projectDir, { recursive: true });
    const body = [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(paths.jsonl, body, 'utf8');
    await writeFile(paths.meta, JSON.stringify(metaFile, null, 2), 'utf8');
    if (options.register) {
      registration = registerCommandCodeThread(
        {
          id: sessionId,
          title,
          projectPath: cwd,
          model,
          createdAt: isoToMs(header.timestamp),
        },
        { userDataDir: options.userDataDir },
      );
      if (!registration.installed) {
        losses.add('command-code.register-skipped', '桌面端注册未完成：' + (registration.reason ?? '未知原因'), { severity: 'warning' });
      }
    }
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: 'command-code',
    sessionId,
    paths: [paths.jsonl, paths.meta],
    rows,
    header,
    filePath: paths.jsonl,
    metaPath: paths.meta,
    registration,
    projectDir,
    cwd,
    plannedSidecars: [paths.checkpoints, home + '/history.jsonl'],
    written: {
      events: session.events.length,
      messages: built.counts.messages,
      toolCalls: built.counts.toolCalls,
      toolResults: built.counts.toolResults,
      reasoning: built.counts.reasoning,
    },
    losses: lossList,
    caps: COMMAND_CODE_CAPS,
  };
}

export function printWriteReport(report: WriteCommandCodeResult): string {
  const lines: string[] = [];
  lines.push('target      ' + report.target);
  lines.push('session     ' + report.sessionId);
  lines.push('file        ' + report.filePath);
  lines.push('meta        ' + report.metaPath);
  lines.push('cwd         ' + report.cwd);
  lines.push('rows        ' + report.rows.length);
  lines.push(
    'written     events=' + report.written.events +
      ' messages=' + report.written.messages +
      ' tool_calls=' + report.written.toolCalls +
      ' tool_results=' + report.written.toolResults +
      ' reasoning=' + report.written.reasoning,
  );
  lines.push('resume      cmd -p --session ' + report.filePath);
  lines.push('losses      ' + (report.losses.length === 0 ? 'none' : ''));
  for (const loss of report.losses) {
    lines.push('  [' + loss.severity + '] ' + loss.code + ' x' + loss.count + ' — ' + loss.message);
  }
  return lines.join('\n');
}
