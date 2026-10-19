/**
 * DSH 原生会话 -> sessionport IR。
 *
 * 输入形态（readDshSession）：
 * - 会话目录（含 session.v4.jsonl.zstd）
 * - 日志文件路径
 * - session id（session-<uuid> 或裸 uuid）
 *
 * 事件映射（基于本机 ~/.dsh 全部 11 个真实会话 + 反编译 app.asar 校验）：
 * - user/message      -> IR message(role=user)；source.kind !== 'user' 的运行时注入标记 synthetic
 * - assistant/message -> content 里 reasoning 块 -> IR reasoning；text 块 -> IR message(role=assistant)；
 *                        tool-call 块 -> IR tool_call
 * - tool/call         -> 与 assistant content 内 tool-call 重复的"回显"事件，计数跳过；
 *                        找不到对应块时兜底还原为 IR tool_call
 * - tool/result       -> IR tool_result（toolCallId 配对；content 文本/图片）
 * - session/title     -> meta.title；model/selection -> meta.model
 * - 其余（turn/step/request/system/developer/inbox/attempt/job/...）按类型计数进 notices，不静默丢弃
 * - 子代理：DSH 把子代理存成独立会话（header.parentSession + delegationDepth=1），
 *           读父会话时按 header.parentSession 反向发现并填入 IrBundle.children
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { IR_VERSION, bundleEventCount } from '@sessionport/core';
import type {
  AgentId,
  IrBundle,
  IrChildSession,
  IrContent,
  IrEvent,
  IrMessageEvent,
  IrNotice,
  IrPart,
  IrSession,
  IrToolCallEvent,
  SourceFingerprint,
} from '@sessionport/core';

import { dshHome, readdirSafe } from './paths.ts';
import { readZstdHeaderLine, readZstdJsonl } from './zstd.ts';
import { resolveDshSessionPath, sessionsRoot } from './paths.ts';

/** 本 adapter 的 agent 标识（core 的 AgentId 已包含 'dsh'） */
export const DSH_AGENT: AgentId = 'dsh';

export interface DshHeader {
  type: 'session';
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: 'subagent';
  isSeeded: boolean;
  delegationDepth: number;
  agentPreset?: string;
}

export interface DshEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
  ignorable?: true;
}

export interface ReadDshOptions {
  /** DSH_HOME；默认 $DSH_HOME 或 ~/.dsh */
  home?: string;
  /** 是否把 header.parentSession 指向本会话的子代理会话读进 children（默认 true） */
  includeChildren?: boolean;
}

/** 当前版本认识的 DSH 事件类型（app.asar dsh-session KNOWN_SESSION_EVENT_TYPES） */
const KNOWN_EVENT_TYPES = new Set<string>([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/attempt', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
  'compaction/start', 'compaction/summary', 'deliverables/presented', 'developer/message',
  'feedback/message-delete', 'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
  'image/offload', 'job/registered', 'job/settled', 'llm/retry', 'llm/retry-started', 'model/selection',
  'permission/preset', 'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title', 'session/title-llm-request',
  'step/end', 'step/start', 'subagent/catalog', 'subagent/descriptor', 'subagent/model-selection-policy',
  'system/message', 'team/member', 'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start',
  'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/result', 'turn/end', 'turn/start',
  'user/message', 'web/deepseek-search-llm-request', 'working-directory/change', 'workspace/changes',
]);

const SESSION_MESSAGE_SOURCES = new Set(['user']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonl(lines: string[]): { values: unknown[]; badLines: number } {
  const values: unknown[] = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      badLines += 1;
    }
  }
  return { values, badLines };
}

function asEvent(value: unknown): DshEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.type !== 'string' || typeof value.seq !== 'number' || typeof value.time !== 'number' || !isRecord(value.data)) {
    return undefined;
  }
  return value as unknown as DshEvent;
}

function asHeader(value: unknown): DshHeader {
  if (!isRecord(value) || value.type !== 'session' || typeof value.version !== 'number' || typeof value.id !== 'string') {
    throw new Error('not a DSH session header (type/version/id)');
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw new Error('DSH session header has no finite createdAt');
  }
  return {
    type: 'session',
    version: value.version,
    id: value.id,
    createdAt: value.createdAt,
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    parentSession: typeof value.parentSession === 'string' ? value.parentSession : undefined,
    origin: value.origin === 'subagent' ? 'subagent' : undefined,
    isSeeded: value.isSeeded === true,
    delegationDepth: typeof value.delegationDepth === 'number' ? value.delegationDepth : 0,
    agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : undefined,
  };
}

function msToIso(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

interface SessionMapResult {
  session: IrSession;
  header: DshHeader;
  eventsParsed: number;
  counters: Map<string, number>;
}

/** 把一份已解析的 DSH 日志映射成 IR session。 */
function mapSession(header: DshHeader, filePath: string, events: DshEvent[], badLines: number, tornStart: number | undefined, cliVersion: string | undefined, home: string): SessionMapResult {
  const counters = new Map<string, number>();
  const bump = (key: string): void => {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  };
  const notices: IrNotice[] = [];
  const eventsOut: IrEvent[] = [];
  let title: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let firstUserText: string | undefined;
  let lastUserText: string | undefined;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  const emittedCalls = new Set<string>();
  const resultIds = new Set<string>();
  const resultOrphans: string[] = [];

  const touch = (time: number): void => {
    if (!Number.isFinite(time)) return;
    if (firstAt === undefined || time < firstAt) firstAt = time;
    if (lastAt === undefined || time > lastAt) lastAt = time;
  };

  for (const event of events) {
    touch(event.time);
    const data = event.data;
    switch (event.type) {
      case 'user/message': {
        const content = Array.isArray(data.content) ? (data.content as unknown[]) : [];
        const parts: IrPart[] = [];
        for (const block of content) {
          if (!isRecord(block)) {
            bump('user:non-object-block');
            continue;
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            bump('user:image-block');
          } else {
            bump('user:block:' + String(block.type));
          }
        }
        const sourceKind = isRecord(data.source) && typeof data.source.kind === 'string' ? data.source.kind : 'user';
        const isSynthetic = !SESSION_MESSAGE_SOURCES.has(sourceKind);
        if (!isSynthetic) {
          const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();
          if (firstUserText === undefined && text.length > 0) firstUserText = text;
          if (text.length > 0) lastUserText = text;
        }
        bump(isSynthetic ? 'user:synthetic' : 'user:real');
        const irEvent: IrMessageEvent = {
          kind: 'message',
          id: '',
          parentId: null,
          at: msToIso(event.time) ?? new Date(0).toISOString(),
          role: 'user',
          parts,
          _native: event,
        };
        if (isSynthetic) {
          irEvent.synthetic = true;
          bump('user:synthetic-source:' + sourceKind);
        }
        eventsOut.push(irEvent);
        break;
      }
      case 'assistant/message': {
        const message = isRecord(data.message) ? data.message : {};
        const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        const parts: IrPart[] = [];
        const reasoningTexts: string[] = [];
        const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
        for (const block of content) {
          if (!isRecord(block)) {
            bump('assistant:non-object-block');
            continue;
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'reasoning' && typeof block.text === 'string') {
            reasoningTexts.push(block.text);
          } else if (block.type === 'tool-call') {
            const id = typeof block.id === 'string' ? block.id : '';
            if (id.length === 0) {
              bump('assistant:tool-call-without-id');
              continue;
            }
            toolCalls.push({
              id,
              name: typeof block.name === 'string' ? block.name : 'unknown',
              input: parseToolArguments(block.arguments),
            });
            emittedCalls.add(id);
          } else {
            bump('assistant:block:' + String(block.type));
          }
        }
        const at = msToIso(event.time) ?? new Date(0).toISOString();
        for (const text of reasoningTexts) {
          eventsOut.push({
            kind: 'reasoning',
            id: '',
            parentId: null,
            at,
            reasoning: { kind: 'plain', text },
            _native: event,
          });
        }
        if (parts.length > 0) {
          eventsOut.push({
            kind: 'message',
            id: '',
            parentId: null,
            at,
            role: 'assistant',
            parts,
            _native: event,
          });
        } else {
          bump('assistant:no-text-parts');
        }
        for (const call of toolCalls) {
          const toolEvent: IrToolCallEvent = {
            kind: 'tool_call',
            id: '',
            parentId: null,
            at,
            callId: call.id,
            name: call.name,
            input: call.input,
            _native: event,
          };
          eventsOut.push(toolEvent);
        }
        break;
      }
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (callId.length === 0) {
          bump('tool/call:without-id');
          break;
        }
        if (emittedCalls.has(callId)) {
          bump('tool/call:echo');
          break;
        }
        emittedCalls.add(callId);
        bump('tool/call:recovered');
        eventsOut.push({
          kind: 'tool_call',
          id: '',
          parentId: null,
          at: msToIso(event.time) ?? new Date(0).toISOString(),
          callId,
          name: typeof data.name === 'string' ? data.name : 'unknown',
          input: parseToolArguments(data.arguments),
          _native: event,
        });
        break;
      }
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : {};
        const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
        const content: IrContent[] = [];
        const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
        for (const block of blocks) {
          if (!isRecord(block)) {
            content.push({ type: 'json', value: block ?? null });
            continue;
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            const attachment = isRecord(block.attachment) ? block.attachment : {};
            const ref = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : 'dsh-image';
            content.push({ type: 'image', ref });
            bump('tool/result:image');
          } else {
            content.push({ type: 'json', value: block });
            bump('tool/result:block:' + String(block.type));
          }
        }
        const isError = message.isError === true || data.error !== undefined;
        if (callId.length > 0) {
          if (resultIds.has(callId)) bump('tool/result:duplicate');
          resultIds.add(callId);
          if (!emittedCalls.has(callId)) resultOrphans.push(callId);
        }
        eventsOut.push({
          kind: 'tool_result',
          id: '',
          parentId: null,
          at: msToIso(event.time) ?? new Date(0).toISOString(),
          callId,
          content,
          isError,
          _native: event,
        });
        break;
      }
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.length > 0) title = data.title;
        break;
      }
      case 'model/selection': {
        if (typeof data.model === 'string') model = data.model;
        if (typeof data.provider === 'string') provider = data.provider;
        break;
      }
      case 'compaction/start': {
        eventsOut.push({
          kind: 'boundary',
          id: '',
          parentId: null,
          at: msToIso(event.time) ?? new Date(0).toISOString(),
          boundary: 'compact',
          detail: 'compaction/start',
          _native: event,
        });
        break;
      }
      case 'feedback/message-delete': {
        eventsOut.push({
          kind: 'boundary',
          id: '',
          parentId: null,
          at: msToIso(event.time) ?? new Date(0).toISOString(),
          boundary: 'undo',
          detail: 'feedback/message-delete',
          _native: event,
        });
        break;
      }
      default: {
        if (KNOWN_EVENT_TYPES.has(event.type)) bump(event.type);
        else bump('unknown:' + event.type);
        break;
      }
    }
  }

  // 链式 id
  let index = 0;
  let parent: string | null = null;
  for (const event of eventsOut) {
    index += 1;
    event.id = 'dsh:e' + String(index).padStart(6, '0');
    event.parentId = parent;
    parent = event.id;
  }

  for (const [key, count] of [...counters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (key.startsWith('unknown:')) {
      notices.push({ code: 'dsh.unknown-event', message: '未识别的 DSH 事件类型 ' + key.slice('unknown:'.length) + ' 已跳过', count, severity: 'warning' });
    } else if (key.startsWith('assistant:block:') || key.startsWith('user:block:') || key.startsWith('tool/result:block:')) {
      notices.push({ code: 'dsh.unknown-content-block', message: '未映射的 message content block ' + key.split(':').slice(1).join(':'), count, severity: 'warning' });
    } else if (key.startsWith('user:synthetic-source:')) {
      notices.push({ code: 'dsh.synthetic-user-message', message: '运行时注入的 user/message（source.kind=' + key.slice('user:synthetic-source:'.length) + '）已标记 synthetic', count, severity: 'info' });
    } else if (key === 'user:image-block') {
      notices.push({ code: 'dsh.image-block-unread', message: 'user/message 中的 image 块没有可解析附件引用，已跳过', count, severity: 'warning' });
    } else if (key === 'tool/call:echo') {
      notices.push({ code: 'dsh.tool-call-echo-dropped', message: 'tool/call 与 assistant content 的 tool-call 块重复，已跳过', count, severity: 'info' });
    } else if (key === 'tool/call:recovered') {
      notices.push({ code: 'dsh.tool-call-recovered', message: 'assistant content 里没有对应 tool-call 块，已从 tool/call 事件兜底还原', count, severity: 'warning' });
    } else if (key === 'tool/call:without-id') {
      notices.push({ code: 'dsh.tool-call-without-id', message: 'tool/call 事件缺 callId，已跳过', count, severity: 'warning' });
    } else if (key === 'tool/result:duplicate') {
      notices.push({ code: 'dsh.duplicate-tool-result', message: '同一 callId 出现多条 tool/result，后者按顺序覆盖（IR 保留全部）', count, severity: 'info' });
    } else if (key === 'user:real' || key === 'user:synthetic' || key === 'assistant:no-text-parts') {
      // 正常统计，不进 notices
      continue;
    } else {
      notices.push({ code: 'dsh.non-conversation-event', message: '非对话事件 ' + key + ' 已跳过', count, severity: 'info' });
    }
  }

  const missingResults = [...emittedCalls].filter((id) => !resultIds.has(id));
  if (missingResults.length > 0) {
    notices.push({
      code: 'dsh.missing-tool-result',
      message: '源会话里有 tool_call 没有对应 tool/result（会话可能被中断）；导出时会补占位结果',
      count: missingResults.length,
      severity: 'warning',
    });
  }
  if (resultOrphans.length > 0) {
    notices.push({
      code: 'dsh.orphan-tool-result',
      message: 'tool/result 找不到对应 tool_call，IR 保留但目标端可能拒绝',
      count: resultOrphans.length,
      severity: 'warning',
    });
  }
  if (badLines > 0) {
    notices.push({ code: 'dsh.bad-jsonl-lines', message: '会话日志里有无法解析的 JSONL 行', count: badLines, severity: 'warning' });
  }
  if (tornStart !== undefined) {
    notices.push({ code: 'dsh.torn-tail-recovered', message: '会话尾部有一帧未写完（崩溃/写入中），已尽量恢复完整行', severity: 'warning' });
  }
  if (eventsOut.length === 0) {
    notices.push({ code: 'dsh.no-conversation-events', message: '这个会话里没有可映射的对话事件', severity: 'warning' });
  }

  const createdAt = msToIso(header.createdAt);
  const updatedAt = msToIso(lastAt) ?? createdAt;
  const firstEventAt = msToIso(firstAt);
  const source: SourceFingerprint = {
    agent: DSH_AGENT,
    nativeSessionId: header.id,
    nativePath: filePath,
    formatVersion: String(header.version),
  };
  if (cliVersion !== undefined) source.cliVersion = cliVersion;

  const meta: IrSession['meta'] = {
    cwd: header.cwd,
    title: title ?? firstUserText?.slice(0, 80),
    createdAt: createdAt ?? firstEventAt,
    updatedAt,
    model,
    profile: header.agentPreset,
    archived: false,
    lastPrompt: lastUserText,
  };

  const session: IrSession = {
    id: 'dsh:' + header.id,
    source,
    meta,
    events: eventsOut,
    head: eventsOut.length > 0 ? eventsOut[eventsOut.length - 1]!.id : null,
    notices,
  };
  return { session, header, eventsParsed: events.length, counters };
}

async function readCliVersion(home: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(home, '.workbuddy-app-version.json'), 'utf8')) as unknown;
    if (isRecord(raw) && typeof raw.version === 'string') return raw.version;
  } catch {
    // 忽略：版本探测不到就留空
  }
  return undefined;
}

interface ParsedSessionFile {
  header: DshHeader;
  events: DshEvent[];
  badLines: number;
  tornStart?: number;
  frames: number;
}

async function parseSessionFile(filePath: string): Promise<ParsedSessionFile> {
  const jsonl = await readZstdJsonl(filePath);
  const { values, badLines } = parseJsonl(jsonl.lines);
  const first = values[0];
  if (first === undefined) throw new Error('empty DSH session log: ' + filePath);
  const header = asHeader(first);
  const events: DshEvent[] = [];
  let eventBad = 0;
  for (let i = 1; i < values.length; i += 1) {
    const event = asEvent(values[i]);
    if (event === undefined) {
      eventBad += 1;
      continue;
    }
    events.push(event);
  }
  return { header, events, badLines: badLines + eventBad, tornStart: jsonl.tornStart, frames: jsonl.frames.length };
}

interface CatalogEntry {
  label?: string;
}

/** 父会话 subagent/catalog 事件：childId -> label */
function collectSubagentCatalog(events: DshEvent[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const event of events) {
    if (event.type !== 'subagent/catalog') continue;
    const childId = event.data.childId;
    if (typeof childId !== 'string') continue;
    map.set(childId, { label: typeof event.data.label === 'string' ? event.data.label : undefined });
  }
  return map;
}

/** 在 $DSH_HOME/sessions 下按 header.parentSession 反查子代理会话。 */
async function discoverChildren(home: string, parentId: string): Promise<Array<{ header: DshHeader; filePath: string }>> {
  const root = sessionsRoot(home);
  const projects = await readdirSafe(root);
  const found: Array<{ header: DshHeader; filePath: string }> = [];
  for (const project of projects) {
    const sessions = await readdirSafe(join(root, project));
    for (const sessionDirName of sessions) {
      const dir = join(root, project, sessionDirName);
      const names = await readdirSafe(dir);
      const logName = names
        .filter((name) => /^session\.v\d+\.jsonl\.zstd$/u.test(name))
        .sort((a, b) => Number(/v(\d+)/u.exec(b)![1]) - Number(/v(\d+)/u.exec(a)![1]))[0];
      if (logName === undefined) continue;
      const filePath = join(dir, logName);
      try {
        const headerLine = await readZstdHeaderLine(filePath);
        const header = asHeader(JSON.parse(headerLine) as unknown);
        if (header.parentSession === parentId) found.push({ header, filePath });
      } catch {
        // 损坏会话不阻断父会话读取
      }
    }
  }
  return found;
}

/** 读取并映射一个文件（root 或子会话）。 */
async function readOne(input: string, opts: ReadDshOptions, home: string, cliVersion: string | undefined, includeChildren: boolean): Promise<{ bundle: IrBundle; header: DshHeader; filePath: string }> {
  const resolved = await resolveDshSessionPath(input, home);
  const parsed = await parseSessionFile(resolved.filePath);
  const mapped = mapSession(parsed.header, resolved.filePath, parsed.events, parsed.badLines, parsed.tornStart, cliVersion, home);

  const children: IrChildSession[] = [];
  if (includeChildren) {
    const catalog = collectSubagentCatalog(parsed.events);
    const discovered = await discoverChildren(home, parsed.header.id);
    for (const child of discovered) {
      if (child.header.id === parsed.header.id) continue;
      try {
        const childResolved = await resolveDshSessionPath(child.filePath, home);
        const childParsed = await parseSessionFile(childResolved.filePath);
        const childMeta = collectSubagentCatalog(childParsed.events);
        const childMapped = mapSession(childParsed.header, childResolved.filePath, childParsed.events, childParsed.badLines, childParsed.tornStart, cliVersion, home);
        const label = catalog.get(child.header.id)?.label ?? collectDescriptorLabel(childParsed.events) ?? childMapped.session.meta.profile;
        children.push({
          session: childMapped.session,
          parentSessionId: mapped.session.id,
          label,
        });
      } catch {
        mapped.session.notices.push({ code: 'dsh.child-session-unreadable', message: '子代理会话读取失败: ' + child.header.id, severity: 'warning' });
      }
    }
  } else if (parsed.header.parentSession !== undefined) {
    mapped.session.notices.push({
      code: 'dsh.child-parent-link',
      message: '这是子代理会话（parentSession=' + parsed.header.parentSession + '），按独立会话返回',
      severity: 'info',
    });
  }

  const bundle: IrBundle = {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: mapped.session,
    children,
  };
  return { bundle, header: parsed.header, filePath: resolved.filePath };
}

function collectDescriptorLabel(events: DshEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'subagent/descriptor') continue;
    if (typeof event.data.label === 'string') return event.data.label;
  }
  return undefined;
}

/**
 * 读取一个 DSH 会话（目录 / 日志文件 / session id）为 IrBundle。
 * 父会话的子代理会话默认作为 children 一并读取。
 */
export async function readDshSession(input: string, opts: ReadDshOptions = {}): Promise<IrBundle> {
  const includeChildren = opts.includeChildren ?? true;
  const preliminaryHome = dshHome(opts.home);
  const cliVersion = await readCliVersion(preliminaryHome);
  const result = await readOne(input, opts, preliminaryHome, cliVersion, includeChildren);
  return result.bundle;
}

/** 粗略统计，供 CLI 打印。 */
export function summarizeDshBundle(bundle: IrBundle): string {
  const root = bundle.root;
  const lines = [
    'root ' + root.id + '  events=' + root.events.length + '  cwd=' + (root.meta.cwd ?? '?'),
    '  title=' + (root.meta.title ?? '(none)') + '  model=' + (root.meta.model ?? '?') + '  preset=' + (root.meta.profile ?? '?'),
  ];
  for (const child of bundle.children) {
    lines.push('child ' + child.session.id + '  events=' + child.session.events.length + '  label=' + (child.label ?? '?'));
  }
  lines.push('total events=' + bundleEventCount(bundle));
  const notices = bundle.root.notices.reduce((n, notice) => n + (notice.count ?? 1), 0);
  lines.push('notices=' + root.notices.length + ' (counted ' + notices + ')');
  return lines.join('\n');
}
