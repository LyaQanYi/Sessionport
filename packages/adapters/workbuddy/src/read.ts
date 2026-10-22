import { basename } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type {
  IrBundle,
  IrChildSession,
  IrContent,
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
  WbAiTitleLine,
  WbDbSession,
  WbFunctionCallLine,
  WbFunctionCallResultLine,
  WbLine,
  WbMessageLine,
  WbReasoningLine,
} from './wire.ts';
import {
  WORKBUDDY_AGENT,
  clip,
  extractWorkBuddyUserText,
  listWorkBuddySubagentFiles,
  parseWorkBuddyLines,
  readWorkBuddyDbSessions,
  readWorkBuddyTranscript,
  resolveWorkBuddySessionPath,
  textOf,
  workBuddyHome,
} from './wire.ts';

export interface ReadWorkBuddyOptions {
  /** WorkBuddy 数据根目录，默认 $WORKBUDDY_HOME 或 ~/.workbuddy */
  home?: string;
  /** 是否把 <session>/subagents/*.jsonl 作为 children 读进来（默认 true） */
  includeSubagents?: boolean;
  /** 覆盖标题（默认 ai-title / DB title / 首条真实用户消息） */
  title?: string;
}

export interface ConvertWorkBuddyOptions {
  /** 原生 session id；默认取行里的 sessionId 或文件名 */
  sessionId?: string;
  /** 原生文件路径，写进 source.nativePath */
  filePath?: string;
  /** DB 元数据（可选；没有也能读） */
  db?: WbDbSession;
  title?: string;
  /** IR 事件 id 前缀，默认 wb */
  idPrefix?: string;
}

export interface WorkBuddyConvertStats {
  events: number;
  userMessages: number;
  assistantMessages: number;
  reasoning: number;
  toolCalls: number;
  toolResults: number;
}

interface Counters {
  syntheticUser: number;
  emptyUser: number;
  interruptedAssistant: number;
  emptyReasoning: number;
  badToolArguments: number;
  orphanToolResult: number;
  failedToolResult: number;
  snapshots: number;
  creditUsage: number;
  forkNotices: number;
  unknownTypes: Map<string, number>;
  toolCallsSeen: Set<string>;
  toolResultsSeen: Set<string>;
  toolCalls: number;
}

function emptyCounters(): Counters {
  return {
    syntheticUser: 0,
    emptyUser: 0,
    interruptedAssistant: 0,
    emptyReasoning: 0,
    badToolArguments: 0,
    orphanToolResult: 0,
    failedToolResult: 0,
    snapshots: 0,
    creditUsage: 0,
    forkNotices: 0,
    unknownTypes: new Map(),
    toolCallsSeen: new Set(),
    toolResultsSeen: new Set(),
    toolCalls: 0,
  };
}

function lineText(block: { type?: string; text?: string }): string {
  return typeof block.text === 'string' ? block.text : '';
}

function contentText(blocks: Array<{ type?: string; text?: string }> | undefined, allowed: Set<string>): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (typeof block.type === 'string' && allowed.has(block.type)) parts.push(lineText(block));
  }
  return parts.join('\n');
}

function outputToContent(output: unknown): IrContent[] {
  if (typeof output === 'string') return output.length > 0 ? [{ type: 'text', text: output }] : [];
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (typeof item === 'string') {
        texts.push(item);
        continue;
      }
      if (item !== null && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (typeof record['text'] === 'string') texts.push(record['text']);
        else texts.push(JSON.stringify(item));
        continue;
      }
      texts.push(String(item));
    }
    return texts.length > 0 ? [{ type: 'text', text: texts.join('\n') }] : [];
  }
  if (output !== null && output !== undefined && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (typeof record['text'] === 'string') return [{ type: 'text', text: record['text'] }];
    if ('value' in record && record['type'] === 'json') return [{ type: 'json', value: record['value'] }];
    if (record['type'] === 'error' && typeof record['error'] === 'string') return [{ type: 'text', text: record['error'] }];
    return [{ type: 'json', value: output }];
  }
  return [];
}

function toolCallIdOf(line: WbFunctionCallLine, fallbackIndex: number): string {
  const callId = textOf(line.callId);
  return callId ?? textOf(line.id) ?? 'call_' + String(fallbackIndex);
}

/** 单份 transcript（根或子代理）-> IrSession；不读磁盘 */
export function workBuddyLinesToSession(lines: WbLine[], options: ConvertWorkBuddyOptions = {}): { session: IrSession; stats: WorkBuddyConvertStats } {
  const counters = emptyCounters();
  const notices: IrNotice[] = [];
  const events: IrEvent[] = [];
  const idPrefix = options.idPrefix ?? 'wb';
  let index = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let cwd: string | undefined = options.db?.cwd;
  let model: string | undefined = options.db?.model;
  let aiTitle: string | undefined;
  let nativeSessionId = options.sessionId;
  let firstUserText: string | undefined;
  let lastUserText: string | undefined;

  for (const line of lines) {
    if (nativeSessionId === undefined && typeof line.sessionId === 'string' && line.sessionId.length > 0) nativeSessionId = line.sessionId;
    if (cwd === undefined && typeof line.cwd === 'string' && line.cwd.length > 0) cwd = line.cwd;
    if (model === undefined && typeof line.providerData?.model === 'string') model = line.providerData.model;
    const at = typeof line.timestamp === 'number' && Number.isFinite(line.timestamp) ? new Date(line.timestamp).toISOString() : undefined;
    if (at !== undefined) {
      if (firstTimestamp === undefined) firstTimestamp = at;
      lastTimestamp = at;
    }
  }
  const fallbackAt = firstTimestamp ?? options.db?.createdAt ?? new Date(0).toISOString();

  const push = (event: IrEventInput, at: string): void => {
    index += 1;
    events.push({
      ...(event as IrEvent),
      id: idPrefix + ':e' + String(index).padStart(6, '0'),
      parentId: events.length > 0 ? events[events.length - 1]!.id : null,
      at,
    } as IrEvent);
  };

  for (const line of lines) {
    const at = typeof line.timestamp === 'number' && Number.isFinite(line.timestamp) ? new Date(line.timestamp).toISOString() : fallbackAt;
    const type = line.type ?? '';

    if (type === 'session-meta') continue;

    if (type === 'ai-title') {
      const title = textOf((line as WbAiTitleLine).aiTitle);
      if (title !== undefined) aiTitle = title;
      continue;
    }

    if (type === 'message') {
      const message = line as WbMessageLine;
      if (message.role === 'user') {
        const raw = contentText(message.content, new Set(['input_text', 'text']));
        if (raw.length === 0) {
          counters.emptyUser += 1;
          continue;
        }
        const extracted = extractWorkBuddyUserText(raw);
        const text = extracted.text;
        if (text.length === 0) {
          counters.emptyUser += 1;
          continue;
        }
        if (!extracted.synthetic) {
          if (firstUserText === undefined) firstUserText = text;
          lastUserText = text;
        } else {
          counters.syntheticUser += 1;
        }
        const event: Omit<IrMessageEvent, 'id' | 'parentId'> = { kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] };
        if (extracted.synthetic) event.synthetic = true;
        push(event, at);
        continue;
      }
      if (message.role === 'assistant') {
        const text = contentText(message.content, new Set(['output_text', 'text']));
        if (text.length === 0) continue;
        const interrupted =
          message.providerData?.skipRun === true ||
          message.providerData?.error !== undefined ||
          (message.status === 'incomplete' && /^interrupted by user/i.test(text.trim()));
        const event: Omit<IrMessageEvent, 'id' | 'parentId'> = { kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text }] };
        if (interrupted) {
          event.synthetic = true;
          counters.interruptedAssistant += 1;
        }
        push(event, at);
        continue;
      }
      counters.unknownTypes.set('message:' + String(message.role), (counters.unknownTypes.get('message:' + String(message.role)) ?? 0) + 1);
      continue;
    }

    if (type === 'reasoning') {
      const reasoning = line as WbReasoningLine;
      const text = contentText(reasoning.rawContent, new Set(['reasoning_text', 'text'])) || contentText(reasoning.content, new Set(['reasoning_text', 'text']));
      if (text.length === 0) {
        counters.emptyReasoning += 1;
        continue;
      }
      const event: Omit<IrReasoningEvent, 'id' | 'parentId'> = { kind: 'reasoning', at, reasoning: { kind: 'plain', text } };
      push(event, at);
      continue;
    }

    if (type === 'function_call') {
      const call = line as WbFunctionCallLine;
      const callId = toolCallIdOf(call, index + 1);
      let input: unknown = {};
      const rawArguments = typeof call.arguments === 'string' ? call.arguments : '';
      if (rawArguments.trim().length > 0) {
        try {
          input = JSON.parse(rawArguments) as unknown;
        } catch {
          counters.badToolArguments += 1;
          input = { raw: rawArguments };
        }
      }
      const event: Omit<IrToolCallEvent, 'id' | 'parentId'> = { kind: 'tool_call', at, callId, name: textOf(call.name) ?? 'unknown', input };
      counters.toolCalls += 1;
      counters.toolCallsSeen.add(callId);
      push(event, at);
      continue;
    }

    if (type === 'function_call_result') {
      const result = line as WbFunctionCallResultLine;
      const callId = textOf(result.callId) ?? 'unknown';
      const content = outputToContent(result.output);
      const isError = result.status !== undefined && result.status !== 'completed';
      if (!counters.toolCallsSeen.has(callId)) counters.orphanToolResult += 1;
      else counters.toolResultsSeen.add(callId);
      if (isError) counters.failedToolResult += 1;
      const event: Omit<IrToolResultEvent, 'id' | 'parentId'> = { kind: 'tool_result', at, callId, content };
      if (isError) event.isError = true;
      push(event, at);
      continue;
    }

    if (type === 'file-history-snapshot') {
      counters.snapshots += 1;
      continue;
    }

    if (type === 'credit-usage') {
      counters.creditUsage += 1;
      continue;
    }

    if (type === 'resend-fork-notice') {
      counters.forkNotices += 1;
      push({ kind: 'boundary', at, boundary: 'fork', detail: 'resend-fork-notice' }, at);
      continue;
    }

    counters.unknownTypes.set(type.length > 0 ? type : '<missing>', (counters.unknownTypes.get(type.length > 0 ? type : '<missing>') ?? 0) + 1);
  }

  const toolWithoutResult = counters.toolCalls - counters.toolResultsSeen.size;
  if (counters.syntheticUser > 0) {
    notices.push({ code: 'workbuddy.injected-user-message', message: 'WorkBuddy 注入的上下文 user 消息（system-reminder/teammate-message）已标记 synthetic', count: counters.syntheticUser, severity: 'info' });
  }
  if (counters.emptyUser > 0) {
    notices.push({ code: 'workbuddy.empty-user-message', message: '空的 user 消息（只有附件引用）已跳过', count: counters.emptyUser, severity: 'info' });
  }
  if (counters.interruptedAssistant > 0) {
    notices.push({ code: 'workbuddy.interrupted-assistant', message: '被用户打断的 assistant 消息已标记 synthetic（不是模型回复）', count: counters.interruptedAssistant, severity: 'info' });
  }
  if (counters.emptyReasoning > 0) {
    notices.push({ code: 'workbuddy.empty-reasoning', message: '空的 reasoning 行已跳过', count: counters.emptyReasoning, severity: 'info' });
  }
  if (counters.badToolArguments > 0) {
    notices.push({ code: 'workbuddy.bad-tool-arguments', message: '工具参数不是合法 JSON，已保留成 { raw }', count: counters.badToolArguments, severity: 'warning' });
  }
  if (counters.orphanToolResult > 0) {
    notices.push({ code: 'workbuddy.orphan-tool-result', message: '找不到对应调用的工具结果（会话被截断/分叉）', count: counters.orphanToolResult, severity: 'warning' });
  }
  if (toolWithoutResult > 0) {
    notices.push({ code: 'workbuddy.tool-without-result', message: '工具调用没有结果（进行中或被打断）', count: toolWithoutResult, severity: 'warning' });
  }
  if (counters.failedToolResult > 0) {
    notices.push({ code: 'workbuddy.failed-tool-result', message: '状态非 completed 的工具结果已标记 isError', count: counters.failedToolResult, severity: 'info' });
  }
  if (counters.snapshots > 0) {
    notices.push({ code: 'workbuddy.file-snapshots-skipped', message: 'file-history-snapshot 是文件备份元数据，不属于对话内容', count: counters.snapshots, severity: 'info' });
  }
  if (counters.creditUsage > 0) {
    notices.push({ code: 'workbuddy.credit-usage-skipped', message: 'credit-usage 是计费埋点，已跳过', count: counters.creditUsage, severity: 'info' });
  }
  if (counters.forkNotices > 0) {
    notices.push({ code: 'workbuddy.resend-fork', message: 'resend-fork-notice 已映射成 boundary(fork)', count: counters.forkNotices, severity: 'info' });
  }
  for (const [type, count] of counters.unknownTypes) {
    notices.push({ code: 'workbuddy.unknown-line', message: '未识别的行类型 ' + type, count, severity: 'warning' });
  }

  const sessionId = nativeSessionId ?? (options.filePath !== undefined ? basename(options.filePath, '.jsonl') : 'unknown');
  const title = textOf(options.title) ?? textOf(options.db?.customTitle) ?? textOf(options.db?.title) ?? aiTitle ?? (firstUserText !== undefined ? clip(firstUserText, 80) : undefined) ?? 'WorkBuddy session';
  const session: IrSession = {
    id: 'workbuddy:' + sessionId,
    source: {
      agent: WORKBUDDY_AGENT,
      nativeSessionId: sessionId,
      ...(options.filePath !== undefined ? { nativePath: options.filePath } : {}),
      formatVersion: 'workbuddy-jsonl-v1',
    },
    meta: {
      ...(cwd !== undefined ? { cwd } : {}),
      title,
      ...((options.db?.createdAt ?? firstTimestamp) !== undefined ? { createdAt: options.db?.createdAt ?? firstTimestamp } : {}),
      ...((options.db?.updatedAt ?? lastTimestamp) !== undefined ? { updatedAt: options.db?.updatedAt ?? lastTimestamp } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(options.db?.mode !== undefined ? { profile: options.db.mode } : {}),
      ...(lastUserText !== undefined ? { lastPrompt: lastUserText } : {}),
      ...(options.db?.archived === true ? { archived: true } : {}),
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
    },
  };
}

/** 直接从 JSONL 文本构造 bundle（测试/诊断用；不含子代理） */
export function parseWorkBuddyTranscript(text: string, options: ConvertWorkBuddyOptions = {}): IrBundle {
  const parsed = parseWorkBuddyLines(text);
  const { session } = workBuddyLinesToSession(parsed.lines, options);
  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}

/**
 * 读一个 WorkBuddy 会话（session id 或 .jsonl 路径）。
 * - 根 transcript：projects/<slug>/<id>.jsonl
 * - 子代理：<id>/subagents/agent-*.jsonl -> bundle.children
 * - DB 只用来补 title/model/cwd/时间/archived
 */
export async function readWorkBuddySession(input: string, options: ReadWorkBuddyOptions = {}): Promise<IrBundle> {
  const home = workBuddyHome(options.home);
  const path = resolveWorkBuddySessionPath(input, home);
  const parsed = readWorkBuddyTranscript(path);
  const sessionId = basename(path, '.jsonl');
  const dbRows = await readWorkBuddyDbSessions(home);
  const db = dbRows.get(sessionId);
  const { session } = workBuddyLinesToSession(parsed.lines, { sessionId, filePath: path, db, title: options.title });

  const children: IrChildSession[] = [];
  if (options.includeSubagents !== false) {
    for (const childPath of listWorkBuddySubagentFiles(path)) {
      const childId = basename(childPath, '.jsonl').replace(/^agent-/, '');
      const childParsed = readWorkBuddyTranscript(childPath);
      const { session: childSession } = workBuddyLinesToSession(childParsed.lines, {
        sessionId: childId,
        filePath: childPath,
        idPrefix: 'wb-child',
      });
      children.push({ session: childSession, parentSessionId: sessionId, label: childId });
    }
  }
  if (children.length > 0) {
    session.notices.push({ code: 'workbuddy.subagents', message: '子代理会话已作为 children 读入（通过 Agent 工具触发）', count: children.length, severity: 'info' });
  }
  if (parsed.badLines > 0) {
    session.notices.push({ code: 'workbuddy.bad-json-lines', message: '无法解析的 JSONL 行已跳过（App 写入中的半行）', count: parsed.badLines, severity: 'warning' });
  }
  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children };
}

export function printWorkBuddySummary(bundle: IrBundle): string {
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
