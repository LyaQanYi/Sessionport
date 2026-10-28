import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { LossCollector, assistantMessageId, contentToText, randomUuid } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrChildSession, IrSession, LossEntry, WriteReport } from '@sessionport/core';

import { claudeConfigDir, sessionFilePath, subagentFilePath, subagentMetaPath, subagentsDirPath } from './paths.ts';
import { buildAssistantRow, buildUserRow, textBlock, toolResultBlock, toolUseBlock } from './rows.ts';
import type { ClaudeRow, RowContext } from './rows.ts';

export const CLAUDE_CAPS: ExportCaps = {
  agent: 'claude-code',
  reasoning: 'none',
  toolResults: 'separate',
  branching: false,
  subagents: true,
  modelPinned: false,
};

/** meta.json 里 agentType 的默认值（与真实 Claude 的 general-purpose 一致） */
export const CLAUDE_DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/** 真实 Claude 的 agentId 只含字母数字（样本 17 位十六进制）；文件名规则同样要求 */
const AGENT_ID_RE = /^[A-Za-z0-9]+$/u;
const AGENT_ID_MAX_LENGTH = 64;

export interface WriteClaudeOptions {
  /** 目标配置目录，默认 CLAUDE_CONFIG_DIR 或 ~/.claude */
  configDir?: string;
  /** 目标会话 uuid，默认随机 */
  sessionId?: string;
  /** 目标 cwd，默认取 IR 的 meta.cwd */
  cwd?: string;
  /** 写入每行的 target CLI version 字段 */
  version?: string;
  gitBranch?: string;
  /** assistant message.model 字段 */
  model?: string;
  /** thinking 是否降级为普通 text 块（默认丢弃并计入损失） */
  keepThinking?: boolean;
  /** 只生成不落盘 */
  dryRun?: boolean;
  /** 是否把 bundle.children 写成 Claude 原生 subagents transcript（默认否） */
  includeChildren?: boolean;
}

/** 子代理 meta.json 内容（字段对齐真实 Claude Code 2.1.303） */
export interface ClaudeSubagentMeta {
  agentType: string;
  description?: string;
  requestShape: 'foreground';
  requestNonInteractive: true;
  spawnDepth: 1;
  toolUseId?: string;
}

export interface WriteClaudeChild {
  /** agent-<agentId>.jsonl 里的 agentId */
  agentId: string;
  label?: string;
  /** 同时写入 agent-<agentId>.meta.json 的内容 */
  meta: ClaudeSubagentMeta;
  filePath: string;
  metaPath: string;
}

export interface WriteClaudeResult extends WriteReport {
  rows: ClaudeRow[];
  /** 原生子代理 transcript（includeChildren=true 时） */
  children: WriteClaudeChild[];
  filePath: string;
  sessionId: string;
  cwd: string;
}

interface Chunk {
  role: 'user' | 'assistant';
  at: string;
  isMeta?: boolean;
  blocks: unknown[];
  toolUseIds: string[];
  toolResultIds: string[];
}

interface BuiltChunks {
  chunks: Chunk[];
  counts: { messages: number; toolCalls: number; toolResults: number; reasoning: number };
}

interface ChildPlan {
  agentId: string;
  label?: string;
  meta: ClaudeSubagentMeta;
  rows: ClaudeRow[];
  filePath: string;
  metaPath: string;
}

function chunkHas(chunk: Chunk, kind: 'tool_use' | 'tool_result'): boolean {
  return chunk.blocks.some((b) => (b as { type?: string }).type === kind);
}

function nonEmptyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 子代理 agentId：优先沿用源端 agentId（Claude -> Claude 往返时保持稳定），
 * 其它源端 id（UUID、含非法字符）用 child id 的 sha256 前缀生成稳定值，
 * 重复时加盐，保证同一 bundle 内的文件名不冲突。
 */
function normalizeAgentId(child: IrChildSession, used: Set<string>): string {
  const native = nonEmptyText(child.session.source.nativeSessionId);
  if (native !== undefined && native.length <= AGENT_ID_MAX_LENGTH && AGENT_ID_RE.test(native) && !used.has(native)) {
    used.add(native);
    return native;
  }
  for (let salt = 0; ; salt += 1) {
    const seed = child.session.id + '\u0000' + (native ?? '') + '\u0000' + String(salt);
    const candidate = createHash('sha256').update(seed).digest('hex').slice(0, 17);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function buildSubagentMeta(child: IrChildSession): ClaudeSubagentMeta {
  const meta: ClaudeSubagentMeta = {
    agentType: nonEmptyText(child.session.meta.profile) ?? CLAUDE_DEFAULT_SUBAGENT_TYPE,
    requestShape: 'foreground',
    requestNonInteractive: true,
    spawnDepth: 1,
  };
  const description = nonEmptyText(child.session.meta.title) ?? nonEmptyText(child.label);
  if (description !== undefined) meta.description = description;
  const toolUseId = nonEmptyText(child.viaToolCallId);
  if (toolUseId !== undefined) meta.toolUseId = toolUseId;
  return meta;
}

/** 从 IR parts / tool_result content 里取纯文本（用于 toolUseResult.prompt/content） */
function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/** 子代理的展示统计：真实耗时 + 按文本长度估算的 token 数（IR 不携带 usage） */
function childStats(session: IrSession): { durationMs: number; estimatedTokens: number } {
  const times = session.events.map((event) => Date.parse(event.at)).filter((value) => Number.isFinite(value));
  const durationMs = times.length >= 2 ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0;
  let chars = 0;
  for (const event of session.events) {
    if (event.kind === 'message') chars += textFromParts(event.parts).length;
    else if (event.kind === 'reasoning' && event.reasoning.kind === 'plain') chars += event.reasoning.text.length;
    else if (event.kind === 'tool_call') chars += JSON.stringify(event.input ?? {}).length;
    else if (event.kind === 'tool_result') chars += textFromParts(event.content).length;
  }
  return { durationMs, estimatedTokens: Math.ceil(chars / 4) };
}

/** 子代理会话的第一条真实用户消息（Claude 的 toolUseResult.prompt 用它） */
function firstUserText(session: IrSession): string {
  for (const event of session.events) {
    if (event.kind !== 'message' || event.role !== 'user' || event.synthetic === true) continue;
    const text = textFromParts(event.parts);
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * 给与子代理对应的 tool_result 行补 Claude 的 toolUseResult。
 * 真实样本里 Claude 用 { status:'completed', agentId, agentType, prompt, content, ... }
 * 关联 <sessionId>/subagents/agent-<agentId>.jsonl；缺这个字段时 CLI 只显示一行
 * "explore(...)"，不会展开子代理转录。
 */
/** Claude 渲染子代理 "Done (N tool uses · X tokens · Ys)" 需要完整 usage 形状，缺字段时整行不渲染 */
const SUBAGENT_USAGE_SKELETON = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: 'not_available',
  iterations: [],
  speed: 'standard',
  fallback_credit: null,
} as const;

function attachSubagentToolUseResults(
  rows: ClaudeRow[],
  links: Array<{
    toolUseId: string;
    agentId: string;
    agentType: string;
    description?: string;
    prompt: string;
    toolCalls: number;
    durationMs: number;
    estimatedTokens: number;
  }>,
  model: string,
): void {
  if (links.length === 0) return;
  const byToolUseId = new Map(links.map((link) => [link.toolUseId, link]));
  for (const row of rows) {
    if (row.type !== 'user') continue;
    for (const block of row.message.content) {
      if (block === null || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (record.type !== 'tool_result') continue;
      const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
      if (toolUseId === undefined) continue;
      const link = byToolUseId.get(toolUseId);
      if (link === undefined) continue;
      const text = typeof record.content === 'string' ? record.content : textFromParts(record.content);
      row.toolUseResult = {
        status: 'completed',
        prompt: link.prompt,
        agentId: link.agentId,
        agentType: link.agentType,
        ...(link.description !== undefined ? { description: link.description } : {}),
        ...(text.length > 0 ? { content: [{ type: 'text', text }] } : {}),
        resolvedModel: model,
        totalDurationMs: link.durationMs,
        totalTokens: link.estimatedTokens,
        totalToolUseCount: link.toolCalls,
        usage: { ...SUBAGENT_USAGE_SKELETON, output_tokens: link.estimatedTokens },
        canContinueAgent: true,
      };
    }
  }
}

function serializeRows(rows: ClaudeRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function buildChunks(session: IrSession, opts: WriteClaudeOptions, losses: LossCollector): BuiltChunks {
  const counts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };
  const chunks: Chunk[] = [];
  let assistant: Chunk | null = null;
  let results: Chunk | null = null;

  const flushAssistant = (): void => {
    if (assistant && assistant.blocks.length > 0) chunks.push(assistant);
    assistant = null;
  };
  const flushResults = (): void => {
    if (results && results.blocks.length > 0) chunks.push(results);
    results = null;
  };
  const flushAll = (): void => {
    flushAssistant();
    flushResults();
  };
  const ensureAssistant = (at: string): Chunk => {
    flushResults();
    if (!assistant) assistant = { role: 'assistant', at, blocks: [], toolUseIds: [], toolResultIds: [] };
    return assistant;
  };
  const ensureResults = (at: string): Chunk => {
    flushAssistant();
    if (!results) results = { role: 'user', at, blocks: [], toolUseIds: [], toolResultIds: [] };
    return results;
  };

  for (const ev of session.events) {
    switch (ev.kind) {
      case 'message': {
        if (ev.role === 'user') {
          flushAll();
          const texts = ev.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
          if (texts.length === 0) break;
          const chunk: Chunk = {
            role: 'user',
            at: ev.at,
            blocks: texts.map((t) => textBlock(t)),
            toolUseIds: [],
            toolResultIds: [],
          };
          if (ev.synthetic) chunk.isMeta = true;
          chunks.push(chunk);
          counts.messages += 1;
        } else {
          const chunk = ensureAssistant(ev.at);
          for (const p of ev.parts) {
            if (p.type === 'text') chunk.blocks.push(textBlock(p.text));
          }
          counts.messages += 1;
        }
        break;
      }
      case 'reasoning': {
        if (opts.keepThinking && ev.reasoning.kind === 'plain') {
          const chunk = ensureAssistant(ev.at);
          chunk.blocks.push(textBlock(ev.reasoning.text));
          counts.reasoning += 1;
        } else {
          losses.add('claude.reasoning-dropped', 'thinking / reasoning 块未导出（Claude 要求带 Anthropic 签名的 thinking 块，跨源无法伪造）', {
            count: 1,
          });
          counts.reasoning += 1;
        }
        break;
      }
      case 'tool_call': {
        const chunk = ensureAssistant(ev.at);
        chunk.blocks.push(toolUseBlock(ev.callId, ev.name, ev.input));
        chunk.toolUseIds.push(ev.callId);
        counts.toolCalls += 1;
        break;
      }
      case 'tool_result': {
        const chunk = ensureResults(ev.at);
        chunk.blocks.push(toolResultBlock(ev.callId, contentToText(ev.content), ev.isError));
        chunk.toolResultIds.push(ev.callId);
        counts.toolResults += 1;
        break;
      }
      case 'boundary': {
        losses.add('claude.boundary-dropped', '会话边界事件（' + ev.boundary + '：分支/撤销/压缩/取消）在 Claude 中没有对应结构', {
          severity: 'info',
          count: 1,
        });
        break;
      }
    }
  }
  flushAll();
  return { chunks, counts };
}

/** 修补 tool_use ↔ tool_result 配对，保证 Claude 加载时不报「缺 tool_result」 */
function repairToolPairs(chunks: Chunk[], losses: LossCollector): Chunk[] {
  const out: Chunk[] = [...chunks];
  for (let i = 0; i < out.length; i += 1) {
    const chunk = out[i]!;
    if (chunk.role !== 'assistant' || chunk.toolUseIds.length === 0) continue;
    const next = out[i + 1];
    const nextIds = next && next.role === 'user' ? next.toolResultIds : [];
    const missing = chunk.toolUseIds.filter((id) => !nextIds.includes(id));
    if (missing.length === 0) continue;
    const synthetic: Chunk = {
      role: 'user',
      at: chunk.at,
      blocks: missing.map((id) => toolResultBlock(id, '[sessionport] 源会话里没有这条工具调用的结果', true)),
      toolUseIds: [],
      toolResultIds: missing,
    };
    out.splice(i + 1, 0, synthetic);
    losses.add('claude.tool-result-synthesized', '源会话里工具调用没有对应结果，已合成占位 tool_result 以保持 Claude 可加载', {
      count: missing.length,
    });
    i += 1;
  }

  // 孤立的 tool_result（前面没有对应 tool_use）：降级为文本，避免 Claude 拒绝
  const allToolUse = new Set<string>();
  for (const chunk of out) for (const id of chunk.toolUseIds) allToolUse.add(id);
  for (const chunk of out) {
    if (chunk.role !== 'user' || chunk.toolResultIds.length === 0) continue;
    const kept: unknown[] = [];
    const keptIds: string[] = [];
    for (const block of chunk.blocks) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown };
      if (b.type === 'tool_result' && b.tool_use_id && !allToolUse.has(b.tool_use_id)) {
        kept.push(textBlock('[tool_result ' + b.tool_use_id + '] ' + String(b.content ?? '')));
        losses.add('claude.orphan-tool-result', '孤立 tool_result（源会话里找不到对应 tool_use）已降级为文本', { severity: 'info', count: 1 });
        continue;
      }
      kept.push(block);
      if (b.type === 'tool_result' && b.tool_use_id) keptIds.push(b.tool_use_id);
    }
    chunk.blocks = kept;
    chunk.toolResultIds = keptIds;
  }
  return out;
}

function materialize(chunks: Chunk[], ctx: RowContext, model: string): ClaudeRow[] {
  const rows: ClaudeRow[] = [];
  let parentUuid: string | null = null;
  for (const chunk of chunks) {
    const uuid = randomUuid();
    const common = { uuid } as { uuid: string };
    let row: ClaudeRow;
    if (chunk.role === 'assistant') {
      row = buildAssistantRow(ctx, { uuid: common.uuid, messageId: assistantMessageId(), model }, chunk.blocks);
    } else {
      const opts = chunk.isMeta ? { isMeta: true } : {};
      row = buildUserRow(ctx, common, chunk.blocks, opts);
    }
    row.timestamp = chunk.at;
    row.parentUuid = parentUuid;
    parentUuid = uuid;
    rows.push(row);
  }
  return rows;
}

export async function writeClaudeSession(bundle: IrBundle, options: WriteClaudeOptions = {}): Promise<WriteClaudeResult> {
  const session = bundle.root;
  const cwd = options.cwd ?? session.meta.cwd ?? process.cwd();
  const configDir = claudeConfigDir(options.configDir);
  const sessionId = options.sessionId ?? randomUuid();
  const version = options.version ?? '2.1.303';
  const gitBranch = options.gitBranch ?? '';
  const model = options.model ?? session.meta.model ?? 'claude-sonnet-5';

  const losses = new LossCollector();
  const ctx: RowContext = { cwd, sessionId, version, gitBranch };
  const built = buildChunks(session, options, losses);
  const chunks = repairToolPairs(built.chunks, losses);
  const rows = materialize(chunks, ctx, model);

  if (session.source.agent !== 'claude-code') {
    losses.add('claude.cross-agent-import', '会话来自 ' + session.source.agent + '，模型/工具语义按 Claude 结构近似还原', {
      severity: 'info',
    });
    losses.add('claude.model-not-mapped', '源模型 ' + model + ' 不是 Claude 模型名，目标端会回落到自身默认模型', {
      severity: 'info',
    });
  }
  if (bundle.children.length > 0 && !options.includeChildren) {
    const childEvents = bundle.children.reduce((n, c) => n + c.session.events.length, 0);
    losses.add('claude.subagent-dropped', '子代理会话未导出（includeChildren=false，未写入 Claude 原生 subagents transcript）', {
      count: bundle.children.length,
      severity: 'warning',
    });
    losses.add('claude.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents, severity: 'warning' });
  }
  if (session.notices.some((n) => n.code === 'kimi.undone-turns-dropped')) {
    losses.add('claude.source-undo', '源端 undo 回滚的内容已在 IR 阶段裁掉，目标端看到的是回滚后的上下文', { severity: 'info' });
  }

  // 先把子代理全部转换出来，再落盘：避免转换失败时留下半套文件
  const childPlans: ChildPlan[] = [];
  const childLinks: Array<{
    toolUseId: string;
    agentId: string;
    agentType: string;
    description?: string;
    prompt: string;
    toolCalls: number;
    durationMs: number;
    estimatedTokens: number;
  }> = [];
  if (options.includeChildren === true && bundle.children.length > 0) {
    const usedAgentIds = new Set<string>();
    for (const child of bundle.children) {
      const agentId = normalizeAgentId(child, usedAgentIds);
      const childCwd = nonEmptyText(child.session.meta.cwd) ?? cwd;
      const childCtx: RowContext = { cwd: childCwd, sessionId, version, gitBranch };
      const childModel = options.model ?? nonEmptyText(child.session.meta.model) ?? model;
      const childBuilt = buildChunks(child.session, options, losses);
      const childChunks = repairToolPairs(childBuilt.chunks, losses);
      const childRows = materialize(childChunks, childCtx, childModel);
      if (childRows.length === 0) {
        losses.add('claude.subagent-empty-skipped', '空的子代理会话没有可写入的事件，已跳过（否则会留下 Claude 无法加载的空 transcript）', {
          count: 1,
          severity: 'info',
        });
        continue;
      }
      for (const row of childRows) {
        row.isSidechain = true;
        row.agentId = agentId;
      }
      const label = nonEmptyText(child.label);
      const meta = buildSubagentMeta(child);
      childPlans.push({
        agentId,
        ...(label !== undefined ? { label } : {}),
        meta,
        rows: childRows,
        filePath: subagentFilePath(configDir, cwd, sessionId, agentId),
        metaPath: subagentMetaPath(configDir, cwd, sessionId, agentId),
      });
      const toolUseId = nonEmptyText(child.viaToolCallId);
      if (toolUseId !== undefined) {
        const stats = childStats(child.session);
        childLinks.push({
          toolUseId,
          agentId,
          agentType: meta.agentType,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          prompt: firstUserText(child.session),
          toolCalls: child.session.events.filter((event) => event.kind === 'tool_call').length,
          durationMs: stats.durationMs,
          estimatedTokens: stats.estimatedTokens,
        });
      }
    }
    if (childPlans.length > 0) {
      losses.add(
        'claude.subagent-native-writeback',
        '子代理已写成 Claude 原生 subagents transcript（<sessionId>/subagents/agent-<agentId>.jsonl + .meta.json）；Claude Code 会在 Agent 调用下渲染 "Done (N tool uses · X tokens · Ys)"。IR 只建模一层子代理，子代理自己的子代理不会写回',
        { count: childPlans.length, severity: 'info' },
      );
    }
    if (childLinks.length > 0) {
      losses.add(
        'claude.subagent-usage-estimated',
        '子代理的 token 数按转录文本长度估算（源 IR 不携带 usage）；tool use 数与耗时为真实值',
        { severity: 'info' },
      );
    }
  }

  // Claude 靠 toolUseResult.agentId 把 tool_result 行和 subagents/agent-*.jsonl 关联起来
  attachSubagentToolUseResults(rows, childLinks, model);

  const filePath = sessionFilePath(configDir, cwd, sessionId);
  if (!options.dryRun) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeRows(rows), 'utf8');
    for (const plan of childPlans) {
      await mkdir(subagentsDirPath(configDir, cwd, sessionId), { recursive: true });
      await writeFile(plan.filePath, serializeRows(plan.rows), 'utf8');
      await writeFile(plan.metaPath, JSON.stringify(plan.meta) + '\n', 'utf8');
    }
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: 'claude-code',
    sessionId,
    paths: [filePath, ...childPlans.map((plan) => plan.filePath)],
    rows,
    children: childPlans.map((plan) => ({
      agentId: plan.agentId,
      ...(plan.label !== undefined ? { label: plan.label } : {}),
      meta: plan.meta,
      filePath: plan.filePath,
      metaPath: plan.metaPath,
    })),
    filePath,
    cwd,
    written: {
      events: session.events.length,
      messages: built.counts.messages,
      toolCalls: built.counts.toolCalls,
      toolResults: built.counts.toolResults,
      reasoning: built.counts.reasoning,
    },
    losses: lossList,
    caps: CLAUDE_CAPS,
  };
}

export function printWriteReport(report: WriteClaudeResult): string {
  const lines: string[] = [];
  lines.push('target      ' + report.target);
  lines.push('session     ' + report.sessionId);
  lines.push('file        ' + report.filePath);
  lines.push('cwd         ' + report.cwd);
  lines.push('rows        ' + report.rows.length);
  lines.push(
    'written     events=' + report.written.events +
      ' messages=' + report.written.messages +
      ' tool_calls=' + report.written.toolCalls +
      ' tool_results=' + report.written.toolResults +
      ' reasoning=' + report.written.reasoning,
  );
  for (const child of report.children) {
    lines.push('subagent    ' + child.agentId + '  ' + (child.meta.description ?? '') + '  ' + child.filePath);
  }
  lines.push('losses      ' + (report.losses.length === 0 ? 'none' : ''));
  for (const loss of report.losses) {
    lines.push('  [' + loss.severity + '] ' + loss.code + ' x' + loss.count + ' — ' + loss.message);
  }
  return lines.join('\n');
}
