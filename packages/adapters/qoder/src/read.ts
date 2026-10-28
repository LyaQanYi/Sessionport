import { basename, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { IR_VERSION } from '@sessionport/core';
import type {
  IrBundle,
  IrChildSession,
  IrContent,
  IrEvent,
  IrEventInput,
  IrMessageEvent,
  IrNotice,
  IrPart,
  IrReasoningEvent,
  IrSession,
  IrToolCallEvent,
  IrToolResultEvent,
} from '@sessionport/core';

import type {
  QoderActiveLeafLine,
  QoderAssistantLine,
  QoderAttachmentLine,
  QoderLastPromptLine,
  QoderLine,
  QoderRuntimeConfigLine,
  QoderTitleLine,
  QoderUserLine,
  QoderWorkspaceDirectoriesLine,
} from './wire.ts';
import {
  QODER_AGENT,
  clip,
  parseQoderLines,
  qoderAssistantText,
  qoderHome,
  qoderThinkingText,
  qoderTimestampToIso,
  qoderToolResult,
  qoderToolUse,
  qoderUserText,
  readQoderLines,
  resolveQoderSessionPath,
  textOf,
} from './wire.ts';

export interface ReadQoderOptions {
  /** Qoder 数据根目录，默认 $QODERCN_CONFIG_DIR 或 ~/.qoder-cn */
  home?: string;
  /** 覆盖标题（默认 custom-title/ai-title/last-prompt/首条 user 文本） */
  title?: string;
  /** 不按 active-leaf 剪枝，按文件顺序读所有行（诊断分叉用） */
  readAllBranches?: boolean;
  /** 是否把 <session>/subagents/agent-*.jsonl 作为 children 读进来（默认 true） */
  includeSubagents?: boolean;
}

export interface ConvertQoderOptions {
  sessionId?: string;
  filePath?: string;
  title?: string;
  /** agent profile（子代理 meta.json 的 agentType） */
  profile?: string;
  idPrefix?: string;
  readAllBranches?: boolean;
}

/** 子代理 meta.json（真实 Qoder 1.1.69 只有这几个字段参与展示/关联） */
interface QoderSubagentSidecar {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
  parentAgentId?: unknown;
}

export interface QoderConvertStats {
  events: number;
  userMessages: number;
  assistantMessages: number;
  reasoning: number;
  toolCalls: number;
  toolResults: number;
  attachments: number;
  droppedLines: number;
}

interface Counters {
  syntheticUser: number;
  emptyUser: number;
  emptyAssistant: number;
  emptyThinking: number;
  attachments: Map<string, number>;
  systemLines: number;
  progressLines: number;
  unknownBlocks: Map<string, number>;
  unknownLines: Map<string, number>;
  compactBoundaries: number;
  calls: Set<string>;
  results: Set<string>;
  orphanResults: number;
  imageParts: number;
  redactedThinking: number;
}

function emptyCounters(): Counters {
  return {
    syntheticUser: 0,
    emptyUser: 0,
    emptyAssistant: 0,
    emptyThinking: 0,
    attachments: new Map(),
    systemLines: 0,
    progressLines: 0,
    unknownBlocks: new Map(),
    unknownLines: new Map(),
    compactBoundaries: 0,
    calls: new Set(),
    results: new Set(),
    orphanResults: 0,
    imageParts: 0,
    redactedThinking: 0,
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const SYNTHETIC_PREFIX = /^(?:<system-reminder|<teammate-message|<task-notification|<local-command|\[Request interrupted)/i;

/**
 * Qoder 的会话是一棵树：active-leaf 指向当前叶子，叶子沿 parentUuid 回溯就是当前分支。
 * tool_result 的 parent 指向包含 tool_use 的那一行（不是上一行），所以要额外把
 * 「parent 在当前分支里的 tool_result」算进来，否则并行工具调用会丢结果。
 */
export interface ActiveSelection {
  lines: QoderLine[];
  dropped: number;
  leafUuid?: string;
  usedActiveLeaf: boolean;
}

export function selectActiveQoderLines(lines: QoderLine[], sessionId: string): ActiveSelection {
  const indexed: Array<{ line: QoderLine; index: number }> = lines.map((line, index) => ({ line, index }));
  const byUuid = new Map<string, { line: QoderLine; index: number }>();
  for (const item of indexed) {
    const uuid = textOf(item.line.uuid);
    if (uuid !== undefined) byUuid.set(uuid, item);
  }

  let leaf: QoderActiveLeafLine | undefined;
  for (const line of lines) {
    if (line.type !== 'active-leaf') continue;
    const active = line as QoderActiveLeafLine;
    if (active.sessionId !== undefined && active.sessionId !== sessionId) continue;
    if (active.leafUuid === null || typeof active.leafUuid === 'string') leaf = active;
  }
  if (leaf === undefined || typeof leaf.leafUuid !== 'string' || leaf.leafUuid.length === 0) {
    return { lines, dropped: 0, usedActiveLeaf: false };
  }
  // active-leaf 指向了不存在的行（文件被截断/手工改坏）：退回全量读，别返回空会话
  if (!byUuid.has(leaf.leafUuid)) {
    return { lines, dropped: 0, usedActiveLeaf: false };
  }

  const chain = new Set<string>();
  let cursor: string | undefined = leaf.leafUuid;
  while (cursor !== undefined && !chain.has(cursor)) {
    chain.add(cursor);
    const item = byUuid.get(cursor);
    if (item === undefined) break;
    const parent = item.line.parentUuid;
    cursor = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
  }
  if (chain.size === 0) return { lines, dropped: 0, usedActiveLeaf: false };

  const keep = new Set<number>();
  for (const item of indexed) {
    const uuid = textOf(item.line.uuid);
    if (uuid === undefined) {
      keep.add(item.index);
      continue;
    }
    if (chain.has(uuid)) {
      keep.add(item.index);
      continue;
    }
    // 工具结果是分支上的旁支：parent 指向当前分支里的 tool_use 行
    const parent = typeof item.line.parentUuid === 'string' ? item.line.parentUuid : undefined;
    if (item.line.type === 'user' && parent !== undefined && chain.has(parent)) {
      const content = (item.line as QoderUserLine).message?.content;
      if (Array.isArray(content) && content.some((block) => block.type === 'tool_result')) keep.add(item.index);
    }
  }

  const selected = indexed.filter((item) => keep.has(item.index)).map((item) => item.line);
  return {
    lines: selected,
    dropped: lines.length - selected.length,
    leafUuid: leaf.leafUuid,
    usedActiveLeaf: true,
  };
}

/** 单份 transcript -> IrSession；不读盘 */
export function qoderLinesToSession(lines: QoderLine[], options: ConvertQoderOptions = {}): { session: IrSession; stats: QoderConvertStats; selection: ActiveSelection } {
  const counters = emptyCounters();
  const notices: IrNotice[] = [];
  const events: IrEvent[] = [];
  const idPrefix = options.idPrefix ?? 'qd';
  let index = 0;

  let nativeSessionId = options.sessionId;
  let cwd: string | undefined;
  let model: string | undefined;
  let version: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let lastPromptLine: string | undefined;
  let summaryTitle: string | undefined;

  for (const line of lines) {
    if (nativeSessionId === undefined && typeof line.sessionId === 'string' && line.sessionId.length > 0) nativeSessionId = line.sessionId;
    if (version === undefined && typeof line.version === 'string') version = line.version;
    if (cwd === undefined) {
      if (line.type === 'workspace-directories') {
        const dirs = (line as QoderWorkspaceDirectoriesLine).directories;
        if (Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === 'string') cwd = dirs[0];
      } else if (typeof line.cwd === 'string') cwd = line.cwd;
    }
    if (line.type === 'runtime-config') model = textOf((line as QoderRuntimeConfigLine).model) ?? model;
    if (line.type === 'custom-title') customTitle = textOf((line as QoderTitleLine).customTitle) ?? customTitle;
    if (line.type === 'ai-title') aiTitle = textOf((line as QoderTitleLine).aiTitle) ?? aiTitle;
    if (line.type === 'last-prompt') lastPromptLine = textOf((line as QoderLastPromptLine).lastPrompt) ?? lastPromptLine;
    if (typeof line.summary === 'string') summaryTitle = textOf(line.summary) ?? summaryTitle;
    const at = qoderTimestampToIso(line.timestamp);
    if (at !== undefined) {
      if (firstTimestamp === undefined) firstTimestamp = at;
      lastTimestamp = at;
    }
  }

  const selection = options.readAllBranches === true
    ? { lines, dropped: 0, usedActiveLeaf: false }
    : selectActiveQoderLines(lines, nativeSessionId ?? '');
  for (const line of selection.lines) {
    if (line.type !== 'user') continue;
    const text = qoderUserText(line as QoderUserLine);
    if (text !== undefined && text.trim().length > 0 && !SYNTHETIC_PREFIX.test(text.trim())) {
      if (firstPrompt === undefined) firstPrompt = text;
      lastPrompt = text;
    }
  }
  const fallbackAt = firstTimestamp ?? new Date(0).toISOString();

  const push = (event: IrEventInput, at: string): void => {
    index += 1;
    events.push({
      ...(event as IrEvent),
      id: idPrefix + ':e' + String(index).padStart(6, '0'),
      parentId: events.length > 0 ? events[events.length - 1]!.id : null,
      at,
    } as IrEvent);
  };

  for (const line of selection.lines) {
    const at = qoderTimestampToIso(line.timestamp) ?? fallbackAt;
    const type = line.type ?? '';

    if (type === 'user') {
      const user = line as QoderUserLine;
      const content = user.message?.content;
      const textParts: IrPart[] = [];
      const toolResults: Array<{ callId: string; text: string; isError: boolean }> = [];
      if (typeof content === 'string') {
        textParts.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const result = qoderToolResult(block);
            if (result !== undefined) toolResults.push(result);
            continue;
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push({ type: 'text', text: block.text });
            continue;
          }
          if (block.type === 'image') {
            counters.imageParts += 1;
            const image = block as { source?: { url?: string; data?: string }; url?: string };
            textParts.push({ type: 'image', ref: String(image.source?.url ?? image.url ?? 'image') });
            continue;
          }
          bump(counters.unknownBlocks, 'user:' + String(block.type));
        }
      } else if (user.humanInput?.text !== undefined) {
        textParts.push({ type: 'text', text: user.humanInput.text });
      }

      for (const result of toolResults) {
        if (!counters.calls.has(result.callId)) counters.orphanResults += 1;
        else counters.results.add(result.callId);
        const event: Omit<IrToolResultEvent, 'id' | 'parentId'> = { kind: 'tool_result', at, callId: result.callId, content: result.text.length > 0 ? [{ type: 'text', text: result.text }] : [] };
        if (result.isError) event.isError = true;
        push(event, at);
      }

      const text = textParts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
      if (textParts.length > 0) {
        const synthetic = user.isMeta === true || user.origin?.kind === 'system' || SYNTHETIC_PREFIX.test(text.trim());
        if (synthetic) counters.syntheticUser += 1;
        if (text.length > 0 || textParts.some((part) => part.type === 'image')) {
          const event: Omit<IrMessageEvent, 'id' | 'parentId'> = { kind: 'message', at, role: 'user', parts: textParts };
          if (synthetic) event.synthetic = true;
          push(event, at);
        } else {
          counters.emptyUser += 1;
        }
      }
      continue;
    }

    if (type === 'assistant') {
      const assistant = line as QoderAssistantLine;
      const assistantContent = assistant.message?.content;
      if (typeof assistantContent === 'string') {
        // 真实子代理 transcript 的 user 用字符串 content；assistant 理论上不会，兼容一下
        const text = assistantContent.trim();
        if (text.length > 0) push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text }] }, at);
        continue;
      }
      for (const block of assistantContent ?? []) {
        if (block.type === 'thinking') {
          const thinking = qoderThinkingText(block);
          if (thinking.length === 0) {
            counters.emptyThinking += 1;
            continue;
          }
          const signature = typeof block.signature === 'string' && block.signature.length > 0 ? block.signature : undefined;
          const event: Omit<IrReasoningEvent, 'id' | 'parentId'> = { kind: 'reasoning', at, reasoning: { kind: 'plain', text: thinking, ...(signature !== undefined ? { signature } : {}) } };
          push(event, at);
          continue;
        }
        if (block.type === 'text') {
          const text = qoderAssistantText(block);
          if (text.length === 0) {
            counters.emptyAssistant += 1;
            continue;
          }
          push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text }] }, at);
          continue;
        }
        if (block.type === 'tool_use') {
          const call = qoderToolUse(block);
          if (call === undefined) {
            bump(counters.unknownBlocks, 'tool_use:no-id');
            continue;
          }
          counters.calls.add(call.callId);
          const event: Omit<IrToolCallEvent, 'id' | 'parentId'> = { kind: 'tool_call', at, callId: call.callId, name: call.name, input: call.input };
          push(event, at);
          continue;
        }
        if (block.type === 'redacted_thinking') {
          counters.redactedThinking += 1;
          push({ kind: 'reasoning', at, reasoning: { kind: 'opaque', payload: block.data ?? block, format: 'qoder.redacted_thinking' } }, at);
          continue;
        }
        bump(counters.unknownBlocks, 'assistant:' + String(block.type));
      }
      continue;
    }

    if (type === 'attachment') {
      const attachment = line as QoderAttachmentLine;
      bump(counters.attachments, attachment.attachment?.type ?? 'unknown');
      continue;
    }

    if (type === 'system') {
      const subtype = (line as QoderLine & { subtype?: string }).subtype;
      if (subtype === 'compact_boundary') {
        counters.compactBoundaries += 1;
        push({ kind: 'boundary', at, boundary: 'compact', detail: 'qoder.compact_boundary' }, at);
      } else {
        counters.systemLines += 1;
      }
      continue;
    }

    if (type === 'progress') {
      counters.progressLines += 1;
      continue;
    }

    if (type === 'workspace-directories' || type === 'runtime-config' || type === 'worktree-state' || type === 'active-leaf' || type === 'last-prompt' || type === 'custom-title' || type === 'ai-title') {
      continue;
    }

    bump(counters.unknownLines, type.length > 0 ? type : '<missing>');
  }

  const pendingCalls = counters.calls.size - counters.results.size;
  if (selection.usedActiveLeaf && selection.dropped > 0) {
    notices.push({ code: 'qoder.branch-pruned', message: '按 active-leaf 回溯当前分支，丢弃了 ' + selection.dropped + ' 行（编辑/重试留下的旧分支）', count: selection.dropped, severity: 'info' });
  }
  if (counters.attachments.size > 0) {
    let total = 0;
    for (const count of counters.attachments.values()) total += count;
    const detail = [...counters.attachments.entries()].map(([name, count]) => name + '=' + count).join(', ');
    notices.push({ code: 'qoder.attachments-skipped', message: 'Qoder attachment 行（skill_listing/system_reminder 等）不进对话：' + detail, count: total, severity: 'info' });
  }
  if (counters.syntheticUser > 0) {
    notices.push({ code: 'qoder.synthetic-user-message', message: '运行时注入/系统提示的 user 消息已标记 synthetic', count: counters.syntheticUser, severity: 'info' });
  }
  if (counters.orphanResults > 0) {
    notices.push({ code: 'qoder.orphan-tool-result', message: '找不到对应 tool_use 的 tool_result', count: counters.orphanResults, severity: 'warning' });
  }
  if (pendingCalls > 0) {
    notices.push({ code: 'qoder.tool-without-result', message: '工具调用没有结果（进行中或被打断）', count: pendingCalls, severity: 'warning' });
  }
  if (counters.emptyAssistant + counters.emptyThinking > 0) {
    notices.push({ code: 'qoder.empty-content-block', message: '空的 text/thinking block 已跳过', count: counters.emptyAssistant + counters.emptyThinking, severity: 'info' });
  }
  if (counters.imageParts > 0) {
    notices.push({ code: 'qoder.image-part', message: '图片 block 只保留了引用，没有内联图片数据', count: counters.imageParts, severity: 'warning' });
  }
  if (counters.redactedThinking > 0) {
    notices.push({ code: 'qoder.redacted-thinking', message: 'redacted_thinking 以 opaque reasoning 保留', count: counters.redactedThinking, severity: 'info' });
  }
  if (counters.compactBoundaries > 0) {
    notices.push({ code: 'qoder.compact-boundary', message: 'compact_boundary 已映射成 boundary(compact)', count: counters.compactBoundaries, severity: 'info' });
  }
  if (counters.systemLines > 0) {
    notices.push({ code: 'qoder.system-lines-skipped', message: 'system 行（非 compact_boundary）已跳过', count: counters.systemLines, severity: 'info' });
  }
  if (counters.progressLines > 0) {
    notices.push({ code: 'qoder.progress-lines-skipped', message: 'progress 行是流式进度，已跳过', count: counters.progressLines, severity: 'info' });
  }
  for (const [type, count] of counters.unknownBlocks) {
    notices.push({ code: 'qoder.unknown-content-block', message: '未识别的 content block ' + type, count, severity: 'warning' });
  }
  for (const [type, count] of counters.unknownLines) {
    notices.push({ code: 'qoder.unknown-line', message: '未识别的行类型 ' + type, count, severity: 'warning' });
  }

  const sessionId = nativeSessionId ?? (options.filePath !== undefined ? basename(options.filePath, '.jsonl') : 'unknown');
  const title = textOf(options.title) ?? customTitle ?? aiTitle ?? lastPromptLine ?? summaryTitle ?? (firstPrompt !== undefined ? clip(firstPrompt, 80) : undefined) ?? 'Qoder session';
  const session: IrSession = {
    id: 'qoder:' + sessionId,
    source: {
      agent: QODER_AGENT,
      nativeSessionId: sessionId,
      ...(options.filePath !== undefined ? { nativePath: options.filePath } : {}),
      ...(version !== undefined ? { formatVersion: version } : {}),
    },
    meta: {
      ...(cwd !== undefined ? { cwd } : {}),
      title,
      ...(firstTimestamp !== undefined ? { createdAt: firstTimestamp } : {}),
      ...(lastTimestamp !== undefined ? { updatedAt: lastTimestamp } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(lastPrompt !== undefined ? { lastPrompt } : {}),
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  return {
    session,
    stats: {
      events: events.length,
      userMessages: events.filter((event) => event.kind === 'message' && event.role === 'user').length,
      assistantMessages: events.filter((event) => event.kind === 'message' && event.role === 'assistant').length,
      reasoning: events.filter((event) => event.kind === 'reasoning').length,
      toolCalls: events.filter((event) => event.kind === 'tool_call').length,
      toolResults: events.filter((event) => event.kind === 'tool_result').length,
      attachments: [...counters.attachments.values()].reduce((sum, count) => sum + count, 0),
      droppedLines: selection.dropped,
    },
    selection,
  };
}

export function qoderLinesToBundle(lines: QoderLine[], options: ConvertQoderOptions = {}): IrBundle {
  const { session } = qoderLinesToSession(lines, options);
  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}

/** 直接从 JSONL 文本构造 bundle（测试/诊断用） */
export function parseQoderTranscript(text: string, options: ConvertQoderOptions = {}): IrBundle {
  const parsed = parseQoderLines(text);
  const bundle = qoderLinesToBundle(parsed.lines, options);
  if (parsed.badLines > 0) {
    bundle.root.notices.push({ code: 'qoder.bad-json-lines', message: '无法解析的 JSONL 行已跳过', count: parsed.badLines, severity: 'warning' });
  }
  return bundle;
}

/** 读一个 Qoder 会话：session id 或 .jsonl 路径 */
export async function readQoderSession(input: string, options: ReadQoderOptions = {}): Promise<IrBundle> {
  const home = qoderHome(options.home);
  const path = resolveQoderSessionPath(input, home);
  const parsed = readQoderLines(path);
  const sessionId = basename(path, '.jsonl');
  const bundle = qoderLinesToBundle(parsed.lines, {
    sessionId,
    filePath: path,
    title: options.title,
    readAllBranches: options.readAllBranches,
  });
  if (parsed.badLines > 0) {
    bundle.root.notices.push({ code: 'qoder.bad-json-lines', message: '无法解析的 JSONL 行已跳过（可能写到一半）', count: parsed.badLines, severity: 'warning' });
  }
  const children: IrChildSession[] = [];
  const subagentsDir = join(path.slice(0, -'.jsonl'.length), 'subagents');
  if (options.includeSubagents !== false && existsSync(subagentsDir)) {
    for (const name of readdirSync(subagentsDir).sort()) {
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      const childPath = join(subagentsDir, name);
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      let sidecar: QoderSubagentSidecar | undefined;
      try {
        sidecar = JSON.parse(readFileSync(childPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as QoderSubagentSidecar;
      } catch {
        // 没有 meta 文件也能读 transcript
      }
      const viaToolCallId = textOf(sidecar?.toolUseId);
      const profile = textOf(sidecar?.agentType);
      // Qoder 把子代理的描述放在 meta.json（transcript 里没有 custom-title），
      // 读回时用它当标题；缺失才回落到首条 user 文本。
      const metaTitle = textOf(sidecar?.description);
      const childParsed = readQoderLines(childPath);
      const { session: childSession } = qoderLinesToSession(childParsed.lines, {
        sessionId: agentId,
        filePath: childPath,
        idPrefix: 'qd-child',
        readAllBranches: true,
        ...(metaTitle !== undefined ? { title: metaTitle } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
      children.push({
        session: childSession,
        parentSessionId: sessionId,
        ...(viaToolCallId !== undefined ? { viaToolCallId } : {}),
        label: agentId,
      });
    }
  }
  if (children.length > 0) {
    bundle.root.notices.push({ code: 'qoder.subagents', message: 'Qoder 子代理 transcript 已作为 children 读入', count: children.length, severity: 'info' });
  }
  return { irVersion: IR_VERSION, createdAt: bundle.createdAt, root: bundle.root, children };
}

export function printQoderSummary(bundle: IrBundle): string {
  const counts: Record<string, number> = {};
  for (const event of bundle.root.events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return [
    'session  ' + (bundle.root.source.nativeSessionId ?? '?'),
    'cwd      ' + (bundle.root.meta.cwd ?? '?'),
    'title    ' + (bundle.root.meta.title ?? '?'),
    'model    ' + (bundle.root.meta.model ?? '?'),
    'events   ' + bundle.root.events.length + ' ' + JSON.stringify(counts),
  ].join('\n');
}
