import { basename } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type {
  IrBoundaryEvent,
  IrBundle,
  IrChildSession,
  IrEvent,
  IrEventInput,
  IrMessageEvent,
  IrNotice,
  IrReasoningEvent,
  IrSession,
  IrToolCallEvent,
  IrToolResultEvent,
} from '@sessionport/core';

import type {
  AntigravityAnnotation,
  AntigravityStepLine,
  AntigravitySummaryRow,
  AntigravityToolCall,
} from './wire.ts';
import {
  ANTIGRAVITY_AGENT,
  antigravityDefaultHomes,
  cleanGenericOutput,
  clip,
  extractUserRequestText,
  findAntigravityTranscriptFile,
  parseAntigravityLines,
  readAntigravityAnnotation,
  readAntigravitySummaries,
  readFileText,
  resolveAntigravitySessionPath,
  textOf,
} from './wire.ts';

export interface ReadAntigravityOptions {
  /** Antigravity 数据目录（默认合并 ~/.gemini/antigravity 与 ~/.gemini/antigravity-cli） */
  home?: string;
  /** 是否把子代理与 swarm 子会话作为 children 读入（默认 true） */
  includeSubagents?: boolean;
  /** 覆盖标题（默认 annotation / DB / 首条真实用户消息） */
  title?: string;
}

export interface ConvertAntigravityOptions {
  /** 原生 conversation id */
  sessionId?: string;
  /** 原生文件路径，写进 source.nativePath */
  filePath?: string;
  /** DB 摘要记录（可选） */
  summary?: AntigravitySummaryRow;
  /** pbtxt 注释（可选） */
  annotation?: AntigravityAnnotation;
  /** 数据文件是否为截断版 transcript.jsonl */
  isCompact?: boolean;
  /** 是否解析出截断字段 */
  hasTruncatedFields?: boolean;
  /** 覆盖标题 */
  title?: string;
  /** IR 事件 id 前缀，默认 ag */
  idPrefix?: string;
}

export interface AntigravityConvertStats {
  events: number;
  userMessages: number;
  assistantMessages: number;
  reasoning: number;
  toolCalls: number;
  toolResults: number;
  boundaries: number;
}

interface PendingToolCall {
  callId: string;
  name: string;
  args: unknown;
}

interface DiscoveredChildRef {
  conversationId: string;
  viaToolCallId?: string;
  label?: string;
}

interface Counters {
  syntheticUser: number;
  emptyUser: number;
  emptyReasoning: number;
  badToolArguments: number;
  orphanToolResult: number;
  toolWithoutResult: number;
  failedToolResult: number;
  systemMessages: number;
  errorMessages: number;
  compactBoundaries: number;
  unknownTypes: Map<string, number>;
}

function emptyCounters(): Counters {
  return {
    syntheticUser: 0,
    emptyUser: 0,
    emptyReasoning: 0,
    badToolArguments: 0,
    orphanToolResult: 0,
    toolWithoutResult: 0,
    failedToolResult: 0,
    systemMessages: 0,
    errorMessages: 0,
    compactBoundaries: 0,
    unknownTypes: new Map(),
  };
}

function parseIsoTime(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function parseToolCallEntry(
  raw: AntigravityToolCall | string,
): { name: string; input: unknown; malformed: boolean } {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as AntigravityToolCall;
      if (parsed && typeof parsed === 'object') {
        const name = textOf(parsed.name) ?? 'unknown';
        const args = parsed.args !== undefined ? parsed.args : {};
        return { name, input: args, malformed: false };
      }
    } catch {
      // fall through
    }
    return { name: 'unknown', input: { raw }, malformed: true };
  }
  const name = textOf(raw?.name) ?? 'unknown';
  let input: unknown = raw?.args !== undefined ? raw.args : {};
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        input = JSON.parse(trimmed) as unknown;
      } catch {
        // 保持原始字符串
      }
    }
  }
  return { name, input, malformed: false };
}

function extractSubagentConversationId(rawOutput: string): string | undefined {
  const jsonMatch = rawOutput.match(/"conversationId"\s*:\s*"([0-9a-f-]{8,})"/iu);
  if (jsonMatch?.[1] !== undefined) return jsonMatch[1];
  const uriMatch = rawOutput.match(/\/brain\/([0-9a-f-]{8,})\//iu);
  return uriMatch?.[1];
}

function subagentLabelFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  return textOf(record.Role) ?? textOf(record.TypeName);
}

/** 单份 Antigravity step JSONL -> IrSession（不读磁盘） */
export function antigravityLinesToSession(
  lines: AntigravityStepLine[],
  options: ConvertAntigravityOptions = {},
): { session: IrSession; stats: AntigravityConvertStats; discoveredChildren: DiscoveredChildRef[] } {
  const counters = emptyCounters();
  const notices: IrNotice[] = [];
  const events: IrEvent[] = [];
  const discoveredChildren: DiscoveredChildRef[] = [];
  const idPrefix = options.idPrefix ?? 'ag';

  let eventIndex = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let model: string | undefined;
  let firstUserText: string | undefined;
  let lastUserText: string | undefined;

  for (const line of lines) {
    const at = parseIsoTime(line.created_at);
    if (at !== undefined) {
      if (firstTimestamp === undefined) firstTimestamp = at;
      lastTimestamp = at;
    }
    const lineModel = textOf(line.model);
    if (lineModel !== undefined) model = lineModel;
  }

  const fallbackAt = firstTimestamp ?? options.summary?.updatedAt ?? new Date(0).toISOString();
  const push = (event: IrEventInput, at: string): void => {
    eventIndex += 1;
    events.push({
      ...(event as IrEvent),
      id: idPrefix + ':e' + String(eventIndex).padStart(6, '0'),
      parentId: events.length > 0 ? events[events.length - 1]!.id : null,
      at,
    } as IrEvent);
  };

  let pendingCalls: PendingToolCall[] = [];
  const flushPendingCalls = (): void => {
    if (pendingCalls.length > 0) {
      counters.toolWithoutResult += pendingCalls.length;
      pendingCalls = [];
    }
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]!;
    const at = parseIsoTime(line.created_at) ?? fallbackAt;
    const type = typeof line.type === 'string' ? line.type : '';
    const stepNo = typeof line.step_index === 'number' && Number.isFinite(line.step_index) ? line.step_index : lineIdx;

    if (type === 'USER_INPUT') {
      flushPendingCalls();
      const raw = typeof line.content === 'string' ? line.content : '';
      if (raw.trim().length === 0) {
        counters.emptyUser += 1;
        continue;
      }
      const extracted = extractUserRequestText(raw);
      if (extracted.text.length === 0) {
        counters.emptyUser += 1;
        continue;
      }
      if (extracted.synthetic) {
        counters.syntheticUser += 1;
      } else {
        if (firstUserText === undefined) firstUserText = extracted.text;
        lastUserText = extracted.text;
      }
      const event: Omit<IrMessageEvent, 'id' | 'parentId'> = {
        kind: 'message',
        at,
        role: 'user',
        parts: [{ type: 'text', text: extracted.text }],
        ...(extracted.synthetic ? { synthetic: true } : {}),
      };
      push(event, at);
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      flushPendingCalls();

      if (typeof line.thinking === 'string') {
        const thinkingText = line.thinking.trim();
        if (thinkingText.length > 0) {
          const rEvent: Omit<IrReasoningEvent, 'id' | 'parentId'> = {
            kind: 'reasoning',
            at,
            reasoning: { kind: 'plain', text: thinkingText },
          };
          push(rEvent, at);
        } else if (line.thinking.length > 0) {
          counters.emptyReasoning += 1;
        }
      }

      if (typeof line.content === 'string' && line.content.trim().length > 0) {
        const mEvent: Omit<IrMessageEvent, 'id' | 'parentId'> = {
          kind: 'message',
          at,
          role: 'assistant',
          parts: [{ type: 'text', text: line.content.trim() }],
        };
        push(mEvent, at);
      }

      if (Array.isArray(line.tool_calls)) {
        for (let tcIdx = 0; tcIdx < line.tool_calls.length; tcIdx += 1) {
          const parsed = parseToolCallEntry(line.tool_calls[tcIdx]!);
          if (parsed.malformed) counters.badToolArguments += 1;
          const callId = 'ag_call_' + String(stepNo) + '_' + String(tcIdx + 1);
          const tcEvent: Omit<IrToolCallEvent, 'id' | 'parentId'> = {
            kind: 'tool_call',
            at,
            callId,
            name: parsed.name,
            input: parsed.input,
          };
          pendingCalls.push({ callId, name: parsed.name, args: parsed.input });
          push(tcEvent, at);
        }
      }
      continue;
    }

    if (type === 'GENERIC') {
      const matched = pendingCalls.shift();
      if (matched === undefined) counters.orphanToolResult += 1;
      const callId = matched?.callId ?? 'orphan_' + String(stepNo);
      const rawContent = typeof line.content === 'string' ? line.content : '';
      const cleaned = cleanGenericOutput(rawContent);
      const errText = textOf(line.error);
      const isError = line.status === 'ERROR' || errText !== undefined;
      if (isError) counters.failedToolResult += 1;

      const textBody = cleaned.length > 0 ? cleaned : (errText ?? '');
      const trEvent: Omit<IrToolResultEvent, 'id' | 'parentId'> = {
        kind: 'tool_result',
        at,
        callId,
        content: textBody.length > 0 ? [{ type: 'text', text: textBody }] : [],
        ...(isError ? { isError: true } : {}),
      };
      push(trEvent, at);

      if (matched?.name === 'invoke_subagent') {
        const childId = extractSubagentConversationId(rawContent);
        if (childId !== undefined) {
          discoveredChildren.push({
            conversationId: childId,
            viaToolCallId: matched.callId,
            label: subagentLabelFromArgs(matched.args),
          });
        }
      }
      continue;
    }

    if (type === 'CHECKPOINT') {
      flushPendingCalls();
      counters.compactBoundaries += 1;
      const bEvent: Omit<IrBoundaryEvent, 'id' | 'parentId'> = {
        kind: 'boundary',
        at,
        boundary: 'compact',
        detail: 'Antigravity context compaction checkpoint',
      };
      push(bEvent, at);
      continue;
    }

    if (type === 'SYSTEM_MESSAGE') {
      counters.systemMessages += 1;
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      flushPendingCalls();
      counters.errorMessages += 1;
      continue;
    }

    counters.unknownTypes.set(type.length > 0 ? type : '<missing>', (counters.unknownTypes.get(type.length > 0 ? type : '<missing>') ?? 0) + 1);
  }

  flushPendingCalls();

  if (options.isCompact === true || options.hasTruncatedFields === true) {
    notices.push({
      code: 'antigravity.compact-transcript-truncated',
      message: '读取了截断版 transcript.jsonl（缺少完整 transcript_full.jsonl），部分长工具输出/思考内容可能不完整',
      count: 1,
      severity: 'warning',
    });
  }
  if (counters.syntheticUser > 0) {
    notices.push({
      code: 'antigravity.synthetic-user-message',
      message: '上下文压缩恢复注入的 user 摘要（CONTEXT_SUMMARY）已标记 synthetic',
      count: counters.syntheticUser,
      severity: 'info',
    });
  }
  if (counters.emptyUser > 0) {
    notices.push({
      code: 'antigravity.empty-user-message',
      message: '空的 USER_INPUT 行已跳过',
      count: counters.emptyUser,
      severity: 'info',
    });
  }
  if (counters.emptyReasoning > 0) {
    notices.push({
      code: 'antigravity.empty-reasoning',
      message: '空的 thinking 字段已跳过',
      count: counters.emptyReasoning,
      severity: 'info',
    });
  }
  if (counters.badToolArguments > 0) {
    notices.push({
      code: 'antigravity.bad-tool-arguments',
      message: '部分工具调用条目不是合法 JSON，已保留成 { raw }',
      count: counters.badToolArguments,
      severity: 'warning',
    });
  }
  if (counters.orphanToolResult > 0) {
    notices.push({
      code: 'antigravity.orphan-tool-result',
      message: '存在找不到前置调用的 GENERIC 工具结果（会话截断或异常中断）',
      count: counters.orphanToolResult,
      severity: 'warning',
    });
  }
  if (counters.toolWithoutResult > 0) {
    notices.push({
      code: 'antigravity.tool-without-result',
      message: '工具调用缺少对应的 GENERIC 结果（进行中或被打断）',
      count: counters.toolWithoutResult,
      severity: 'warning',
    });
  }
  if (counters.failedToolResult > 0) {
    notices.push({
      code: 'antigravity.failed-tool-result',
      message: '状态为 ERROR 的工具结果已标记 isError',
      count: counters.failedToolResult,
      severity: 'info',
    });
  }
  if (counters.systemMessages > 0) {
    notices.push({
      code: 'antigravity.system-messages-skipped',
      message: 'SYSTEM_MESSAGE 运行时通知（计划回顾 / 后台任务完成 / 重启提醒）已跳过',
      count: counters.systemMessages,
      severity: 'info',
    });
  }
  if (counters.errorMessages > 0) {
    notices.push({
      code: 'antigravity.error-messages-skipped',
      message: 'ERROR_MESSAGE 流传输错误通知已跳过',
      count: counters.errorMessages,
      severity: 'info',
    });
  }
  if (counters.compactBoundaries > 0) {
    notices.push({
      code: 'antigravity.compact-boundary',
      message: 'CHECKPOINT 上下文压缩点已映射成 boundary(compact)',
      count: counters.compactBoundaries,
      severity: 'info',
    });
  }
  for (const [unknownType, count] of counters.unknownTypes) {
    notices.push({
      code: 'antigravity.unknown-line',
      message: '未识别的 step 类型 ' + unknownType,
      count,
      severity: 'warning',
    });
  }

  const sessionId =
    textOf(options.sessionId) ??
    (options.filePath !== undefined ? basename(options.filePath, '.jsonl') : 'unknown');
  const title =
    textOf(options.title) ??
    textOf(options.annotation?.title) ??
    textOf(options.summary?.title) ??
    textOf(options.summary?.preview) ??
    (firstUserText !== undefined ? clip(firstUserText, 80) : undefined) ??
    'Antigravity conversation';
  const cwd = options.summary?.cwd;
  const createdAt = firstTimestamp;
  const updatedAt = options.summary?.updatedAt ?? lastTimestamp;
  const archived = options.annotation?.archived ?? options.summary?.archived;

  const session: IrSession = {
    id: 'antigravity:' + sessionId,
    source: {
      agent: ANTIGRAVITY_AGENT,
      nativeSessionId: sessionId,
      ...(options.filePath !== undefined ? { nativePath: options.filePath } : {}),
      formatVersion: options.isCompact === true ? 'antigravity-compact-jsonl-v1' : 'antigravity-full-jsonl-v1',
    },
    meta: {
      ...(cwd !== undefined ? { cwd } : {}),
      title,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(textOf(options.summary?.agentName) !== undefined ? { profile: options.summary!.agentName } : {}),
      ...(lastUserText !== undefined ? { lastPrompt: lastUserText } : {}),
      ...(archived === true ? { archived: true } : {}),
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  return {
    session,
    stats: {
      events: events.length,
      userMessages: events.filter((e) => e.kind === 'message' && e.role === 'user').length,
      assistantMessages: events.filter((e) => e.kind === 'message' && e.role === 'assistant').length,
      reasoning: events.filter((e) => e.kind === 'reasoning').length,
      toolCalls: events.filter((e) => e.kind === 'tool_call').length,
      toolResults: events.filter((e) => e.kind === 'tool_result').length,
      boundaries: events.filter((e) => e.kind === 'boundary').length,
    },
    discoveredChildren,
  };
}

/** 直接从 JSONL 文本构造 IrBundle（单元测试与诊断用） */
export function parseAntigravityTranscript(text: string, options: ConvertAntigravityOptions = {}): IrBundle {
  const parsed = parseAntigravityLines(text);
  const { session } = antigravityLinesToSession(parsed.lines, {
    ...options,
    hasTruncatedFields: options.hasTruncatedFields ?? parsed.hasTruncatedFields,
  });
  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}

/** 读取一个 Antigravity 会话（conversationId、目录或 transcript*.jsonl 路径），默认附带子代理与 swarm 子会话 */
export async function readAntigravitySession(
  input: string,
  options: ReadAntigravityOptions = {},
): Promise<IrBundle> {
  const resolved = resolveAntigravitySessionPath(input, options.home);
  const parsed = parseAntigravityLines(readFileText(resolved.path));
  const summaries = readAntigravitySummaries(resolved.home);
  const summary = summaries.get(resolved.conversationId);
  const annotation = readAntigravityAnnotation(resolved.home, resolved.conversationId);

  const { session, discoveredChildren } = antigravityLinesToSession(parsed.lines, {
    sessionId: resolved.conversationId,
    filePath: resolved.path,
    summary,
    annotation,
    isCompact: resolved.isCompact,
    hasTruncatedFields: parsed.hasTruncatedFields,
    title: options.title,
  });

  if (parsed.badLines > 0) {
    session.notices.push({
      code: 'antigravity.bad-json-lines',
      message: '无法解析的 JSONL 行已跳过（可能正在写入半行）',
      count: parsed.badLines,
      severity: 'warning',
    });
  }

  const children: IrChildSession[] = [];
  if (options.includeSubagents !== false) {
    const mergedRefs = new Map<string, DiscoveredChildRef>();
    for (const ref of discoveredChildren) {
      if (ref.conversationId === resolved.conversationId) continue;
      mergedRefs.set(ref.conversationId, ref);
    }
    for (const row of summaries.values()) {
      if (row.parentConversationId !== resolved.conversationId || row.conversationId === resolved.conversationId) continue;
      const existing = mergedRefs.get(row.conversationId);
      if (existing === undefined) {
        mergedRefs.set(row.conversationId, {
          conversationId: row.conversationId,
          label: row.agentName,
        });
      } else if (existing.label === undefined && row.agentName !== undefined) {
        existing.label = row.agentName;
      }
    }

    const searchHomes = [resolved.home, ...antigravityDefaultHomes(options.home).filter((h) => h !== resolved.home)];
    let childIdx = 0;
    for (const ref of mergedRefs.values()) {
      let childFile: { path: string; isCompact: boolean } | undefined;
      let childHome = resolved.home;
      for (const h of searchHomes) {
        childFile = findAntigravityTranscriptFile(h, ref.conversationId);
        if (childFile !== undefined) {
          childHome = h;
          break;
        }
      }
      if (childFile === undefined) continue;
      childIdx += 1;
      const childParsed = parseAntigravityLines(readFileText(childFile.path));
      const childSummary = summaries.get(ref.conversationId) ?? readAntigravitySummaries(childHome).get(ref.conversationId);
      const childAnnotation = readAntigravityAnnotation(childHome, ref.conversationId);
      const { session: childSession } = antigravityLinesToSession(childParsed.lines, {
        sessionId: ref.conversationId,
        filePath: childFile.path,
        summary: childSummary,
        annotation: childAnnotation,
        isCompact: childFile.isCompact,
        hasTruncatedFields: childParsed.hasTruncatedFields,
        idPrefix: 'ag-child-' + String(childIdx),
      });
      if (childParsed.badLines > 0) {
        childSession.notices.push({
          code: 'antigravity.bad-json-lines',
          message: '无法解析的 JSONL 行已跳过（可能正在写入半行）',
          count: childParsed.badLines,
          severity: 'warning',
        });
      }
      const label = ref.label ?? childSummary?.agentName ?? childSession.meta.title;
      children.push({
        session: childSession,
        parentSessionId: resolved.conversationId,
        ...(ref.viaToolCallId !== undefined ? { viaToolCallId: ref.viaToolCallId } : {}),
        ...(label !== undefined ? { label } : {}),
      });
    }
  }

  if (children.length > 0) {
    session.notices.push({
      code: 'antigravity.subagents',
      message: '子代理 / swarm 子会话已作为 children 读入',
      count: children.length,
      severity: 'info',
    });
  }

  return {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: session,
    children,
  };
}

export function printAntigravitySummary(bundle: IrBundle): string {
  const counts: Record<string, number> = {};
  for (const event of bundle.root.events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return [
    'session  ' + (bundle.root.source.nativeSessionId ?? '?'),
    'cwd      ' + (bundle.root.meta.cwd ?? '?'),
    'title    ' + (bundle.root.meta.title ?? '?'),
    'events   ' + bundle.root.events.length + ' ' + JSON.stringify(counts),
    'children ' + bundle.children.length,
  ].join('\n');
}
