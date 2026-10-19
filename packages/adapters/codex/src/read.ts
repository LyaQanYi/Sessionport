import { existsSync } from 'node:fs';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrMessageEvent, IrNotice, IrPart, IrSession } from '@sessionport/core';

import type { CodexContentBlock, CodexIndexEntry, CodexLine, CodexSessionMeta } from './wire.ts';
import { codexHome, listRolloutFiles, readRollout, readSessionIndex, sessionIdFromRolloutPath } from './wire.ts';

export interface ReadCodexOptions {
  /** Codex 数据根目录，默认 $CODEX_HOME 或 ~/.codex */
  home?: string;
  /** 不传时按会话索引/首个用户消息推断 */
  title?: string;
}

/** Codex 会把 AGENTS.md / 环境上下文伪装成 user 消息注入，导出时按 synthetic 处理 */
const INJECTED_USER_PREFIXES = ['# AGENTS.md instructions for ', '<environment_context>', '<skills_instructions>', '<user_instructions>'];

interface Counters {
  eventMsg: number;
  systemLines: number;
  developerMessages: number;
  unknownLines: Map<string, number>;
  opaqueReasoning: number;
  badToolArgs: number;
}

function emptyCounters(): Counters {
  return { eventMsg: 0, systemLines: 0, developerMessages: 0, unknownLines: new Map(), opaqueReasoning: 0, badToolArgs: 0 };
}

function textFromBlocks(blocks: unknown, allowed: Set<string>): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const value = block as CodexContentBlock;
    if (typeof value.type === 'string' && allowed.has(value.type) && typeof value.text === 'string') parts.push(value.text);
  }
  return parts.join('');
}

function reasoningText(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  for (const key of ['summary', 'content'] as const) {
    const value = payload[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          chunks.push((item as { text: string }).text);
        }
      }
    }
  }
  return chunks.join('\n').trim();
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 解析 rollout 路径：支持直接路径、会话 uuid、或 'last' */
export function resolveCodexSessionPath(input: string, options: ReadCodexOptions = {}): { path: string; home: string } {
  const home = codexHome(options.home);
  if (input === 'last') {
    const files = listRolloutFiles(home);
    if (files.length === 0) throw new Error('找不到任何 Codex rollout 文件: ' + home);
    return { path: files[0]!, home };
  }
  if (input.endsWith('.jsonl') && existsSync(input)) return { path: input, home };
  const files = listRolloutFiles(home);
  const byId = files.find((file) => sessionIdFromRolloutPath(file) === input);
  if (byId) return { path: byId, home };
  // 允许 id 前缀
  const byPrefix = files.find((file) => (sessionIdFromRolloutPath(file) ?? '').startsWith(input));
  if (byPrefix) return { path: byPrefix, home };
  throw new Error('找不到 Codex 会话: ' + input + '（数据目录 ' + home + '）');
}

export async function readCodexSession(input: string, options: ReadCodexOptions = {}): Promise<IrBundle> {
  const { path, home } = resolveCodexSessionPath(input, options);
  const { lines, badLines } = readRollout(path);
  const counters = emptyCounters();
  const notices: IrNotice[] = [];

  const firstMeta = lines.find((line) => line.type === 'session_meta')?.payload as CodexSessionMeta | undefined;
  const sessionId = firstMeta?.session_id ?? firstMeta?.id ?? sessionIdFromRolloutPath(path) ?? 'unknown';

  let title = options.title;
  if (title === undefined) {
    try {
      const index: CodexIndexEntry[] = readSessionIndex(home);
      title = index.find((entry) => entry.id === sessionId)?.thread_name;
    } catch {
      // 索引缺失不影响读取
    }
  }
  if (title === undefined) title = firstUserText(lines);

  const events: IrEvent[] = [];
  let index = 0;
  let model: string | undefined;
  let provider: string | undefined;
  let gitBranch: string | undefined;
  let createdAt: string | undefined;
  let historyMode: string | undefined;

  const push = (event: Omit<IrEvent, 'id' | 'parentId'>): void => {
    index += 1;
    const id = 'codex:e' + String(index).padStart(6, '0');
    events.push({ ...(event as IrEvent), id, parentId: events.length > 0 ? events[events.length - 1]!.id : null });
  };

  for (const line of lines) {
    const payload = (line.payload ?? {}) as Record<string, unknown>;
    const at = typeof line.timestamp === 'string' ? line.timestamp : createdAt ?? new Date(0).toISOString();

    if (line.type === 'session_meta') {
      const meta = payload as CodexSessionMeta;
      if (createdAt === undefined) createdAt = meta.timestamp;
      if (meta.cwd !== undefined) gitBranch = meta.git?.branch ?? gitBranch;
      if (meta.model_provider !== undefined) provider = meta.model_provider;
      if (meta.history_mode !== undefined) historyMode = meta.history_mode;
      continue;
    }

    if (line.type === 'event_msg') {
      counters.eventMsg += 1;
      continue;
    }

    if (line.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      continue;
    }

    if (line.type === 'token_usage_record' || line.type === 'world_state') {
      counters.systemLines += 1;
      continue;
    }

    if (line.type === 'response_item') {
      const itemType = typeof payload.type === 'string' ? payload.type : '';
      if (itemType === 'message') {
        const role = payload.role;
        if (role === 'user') {
          const text = textFromBlocks(payload.content, new Set(['input_text', 'text']));
          if (text.length > 0) {
            const synthetic = INJECTED_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
            const event: IrMessageEvent = { kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] };
            if (synthetic) event.synthetic = true;
            push(event);
          }
          continue;
        }
        if (role === 'assistant') {
          const text = textFromBlocks(payload.content, new Set(['output_text', 'text']));
          if (text.length > 0) push({ kind: 'message', at, role: 'assistant', parts: [{ type: 'text', text }] });
          continue;
        }
        if (role === 'developer' || role === 'system') {
          counters.developerMessages += 1;
          continue;
        }
        counters.unknownLines.set('message:' + String(role), (counters.unknownLines.get('message:' + String(role)) ?? 0) + 1);
        continue;
      }
      if (itemType === 'reasoning') {
        const text = reasoningText(payload);
        if (text.length > 0) {
          push({ kind: 'reasoning', at, reasoning: { kind: 'plain', text } });
        } else if (payload.encrypted_content !== undefined && payload.encrypted_content !== null) {
          counters.opaqueReasoning += 1;
          push({ kind: 'reasoning', at, reasoning: { kind: 'opaque', payload: payload.encrypted_content, format: 'codex-encrypted' } });
        }
        continue;
      }
      if (itemType === 'function_call') {
        const callId = String(payload.call_id ?? payload.id ?? '');
        if (typeof payload.arguments === 'string') {
          try {
            JSON.parse(payload.arguments);
          } catch {
            counters.badToolArgs += 1;
          }
        }
        push({
          kind: 'tool_call',
          at,
          callId,
          name: String(payload.name ?? 'unknown'),
          input: parseArguments(payload.arguments),
        });
        continue;
      }
      if (itemType === 'function_call_output') {
        const callId = String(payload.call_id ?? '');
        const output = payload.output;
        push({
          kind: 'tool_result',
          at,
          callId,
          content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? '') }],
        });
        continue;
      }
      counters.unknownLines.set('response_item:' + itemType, (counters.unknownLines.get('response_item:' + itemType) ?? 0) + 1);
      continue;
    }

    counters.unknownLines.set('line:' + String(line.type), (counters.unknownLines.get('line:' + String(line.type)) ?? 0) + 1);
  }

  if (counters.eventMsg > 0) {
    notices.push({
      code: 'codex.event-msg-skipped',
      message: 'event_msg 是 UI 层镜像，内容与 response_item 重复，已跳过',
      count: counters.eventMsg,
      severity: 'info',
    });
  }
  if (counters.systemLines > 0) {
    notices.push({
      code: 'codex.system-lines-skipped',
      message: 'token_usage_record / world_state 等运行时快照不属于对话内容，已跳过',
      count: counters.systemLines,
      severity: 'info',
    });
  }
  if (counters.developerMessages > 0) {
    notices.push({
      code: 'codex.developer-messages-skipped',
      message: 'developer/system 消息是运行时注入的指令（skills、环境说明等），目标端会生成自己的，已跳过',
      count: counters.developerMessages,
      severity: 'info',
    });
  }
  if (counters.opaqueReasoning > 0) {
    notices.push({
      code: 'codex.opaque-reasoning',
      message: 'reasoning 只有加密内容（encrypted_content），以 opaque 形式保留',
      count: counters.opaqueReasoning,
      severity: 'info',
    });
  }
  if (counters.badToolArgs > 0) {
    notices.push({
      code: 'codex.tool-arguments-not-json',
      message: '部分 function_call 的 arguments 不是合法 JSON，已按原始字符串保留',
      count: counters.badToolArgs,
      severity: 'warning',
    });
  }
  for (const [key, count] of counters.unknownLines) {
    notices.push({ code: 'codex.unknown-line', message: '未识别的 rollout 结构 ' + key, count, severity: 'warning' });
  }
  if (badLines > 0) {
    notices.push({ code: 'codex.bad-lines', message: 'rollout 中有无法解析的行', count: badLines, severity: 'warning' });
  }

  const source = {
    agent: 'codex' as const,
    cliVersion: firstMeta?.cli_version,
    formatVersion: historyMode,
    nativeSessionId: sessionId,
    nativePath: path,
  };

  const session: IrSession = {
    id: 'codex:' + sessionId,
    source,
    meta: {
      cwd: firstMeta?.cwd,
      title,
      createdAt,
      model,
      profile: firstMeta?.originator,
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}

function firstUserText(lines: CodexLine[]): string | undefined {
  for (const line of lines) {
    if (line.type !== 'response_item') continue;
    const payload = (line.payload ?? {}) as Record<string, unknown>;
    if (payload.type !== 'message' || payload.role !== 'user') continue;
    const text = textFromBlocks(payload.content, new Set(['input_text', 'text'])).trim();
    if (text.length > 0) return text.slice(0, 60);
  }
  return undefined;
}

/** 列出本机 Codex 会话（扫描 rollout + 索引标题），供 list 用 */
export async function listCodexSessions(home?: string): Promise<Array<{ id: string; path: string; title?: string; updatedAt?: string }>> {
  const root = codexHome(home);
  const index = readSessionIndex(root);
  const titles = new Map(index.map((entry) => [entry.id, entry.thread_name]));
  return listRolloutFiles(root).map((path) => {
    const id = sessionIdFromRolloutPath(path) ?? path;
    return { id, path, title: titles.get(id) };
  });
}