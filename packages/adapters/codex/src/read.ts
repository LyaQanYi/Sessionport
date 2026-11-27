import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrChildSession, IrEvent, IrEventInput, IrNotice, IrSession } from '@sessionport/core';

import type { CodexContentBlock, CodexIndexEntry, CodexLine, CodexSessionMeta, CodexStateThreadRow } from './wire.ts';
import {
  classifyCodexThread,
  codexHome,
  isCodexInjectedUserText,
  listRolloutFiles,
  parseRollout,
  readRollout,
  readRolloutHead,
  readSessionIndex,
  readStateThreads,
  rolloutTimestampFromPath,
  sessionIdFromRolloutPath,
} from './wire.ts';

export interface ReadCodexOptions {
  /** Codex 数据根目录，默认 $CODEX_HOME 或 ~/.codex */
  home?: string;
  /** 不传时按会话索引/首个用户消息推断 */
  title?: string;
  /** 是否把 spawned subagents 作为 children 读取（默认 true） */
  includeChildren?: boolean;
}

interface Counters {
  eventMsg: number;
  systemLines: number;
  developerMessages: number;
  interAgentMessages: number;
  ambientToolOutputs: number;
  unknownLines: Map<string, number>;
  opaqueReasoning: number;
  badToolArgs: number;
  orphanToolResults: number;
}

function emptyCounters(): Counters {
  return {
    eventMsg: 0,
    systemLines: 0,
    developerMessages: 0,
    interAgentMessages: 0,
    ambientToolOutputs: 0,
    unknownLines: new Map(),
    opaqueReasoning: 0,
    badToolArgs: 0,
    orphanToolResults: 0,
  };
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

function customOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        texts.push((item as { text: string }).text);
      }
    }
    return texts.join('\n');
  }
  return JSON.stringify(output ?? '');
}

function inferCodexHomeFromPath(filePath: string): string | undefined {
  const parts = filePath.split('/');
  for (const marker of ['sessions', 'archived_sessions'] as const) {
    const idx = parts.lastIndexOf(marker);
    if (idx > 0) return parts.slice(0, idx).join('/');
  }
  return undefined;
}

function isRolloutFilePath(input: string): boolean {
  return (input.endsWith('.jsonl') || input.endsWith('.jsonl.zst')) && existsSync(input);
}

/** 解析 rollout 路径：支持直接路径（.jsonl / .jsonl.zst）、会话 uuid、或 'last' */
export function resolveCodexSessionPath(input: string, options: ReadCodexOptions = {}): { path: string; home: string } {
  const home = options.home !== undefined ? codexHome(options.home) : (inferCodexHomeFromPath(input) ?? codexHome());
  if (input === 'last') {
    const files = listRolloutFiles(home);
    if (files.length === 0) throw new Error('找不到任何 Codex rollout 文件: ' + home);
    const stateThreads = readStateThreads(home);
    const primary = files.find((file) => {
      const tid = sessionIdFromRolloutPath(file);
      const cls = classifyCodexThread(undefined, tid !== undefined ? stateThreads.get(tid) : undefined);
      return !cls.isSubagent && !cls.isGuardian;
    });
    return { path: primary ?? files[0]!, home };
  }
  if (isRolloutFilePath(input)) return { path: input, home };
  const files = listRolloutFiles(home);
  const byId = files.find((file) => sessionIdFromRolloutPath(file) === input);
  if (byId) return { path: byId, home };
  // 允许 id 前缀
  const byPrefix = files.find((file) => (sessionIdFromRolloutPath(file) ?? '').startsWith(input));
  if (byPrefix) return { path: byPrefix, home };
  throw new Error('找不到 Codex 会话: ' + input + '（数据目录 ' + home + '）');
}

function sortSegmentsChronological(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const aTime = rolloutTimestampFromPath(a);
    const bTime = rolloutTimestampFromPath(b);
    if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return aTime - bTime;
    try {
      return statSync(a).mtimeMs - statSync(b).mtimeMs;
    } catch {
      return a.localeCompare(b);
    }
  });
}

function collectThreadSegments(filePath: string, home: string): string[] {
  const threadId = sessionIdFromRolloutPath(filePath);
  if (threadId === undefined) return [filePath];
  const sameThread = listRolloutFiles(home).filter((candidate) => sessionIdFromRolloutPath(candidate) === threadId);
  if (sameThread.length === 0) return [filePath];
  const mergedSet = new Set(sameThread);
  // 若传入的路径本身属于同一个 home（已在 sameThread 里）或目录外单独指定，只在它在 sameThread 中时才合并分段
  if (!mergedSet.has(filePath) && dirname(filePath) === home) return [filePath];
  if (!mergedSet.has(filePath)) return [filePath];
  return sortSegmentsChronological([...mergedSet]);
}

function readMergedRollout(files: string[]): { lines: CodexLine[]; badLines: number } {
  if (files.length <= 1) return readRollout(files[0]!);
  const seenOrdinals = new Set<number>();
  const collected: Array<{ line: CodexLine; seq: number }> = [];
  let badLines = 0;
  let seq = 0;
  for (const file of files) {
    const parsed = readRollout(file);
    badLines += parsed.badLines;
    for (const line of parsed.lines) {
      if (typeof line.ordinal === 'number' && Number.isFinite(line.ordinal)) {
        if (seenOrdinals.has(line.ordinal)) continue;
        seenOrdinals.add(line.ordinal);
      }
      collected.push({ line, seq: seq++ });
    }
  }
  collected.sort((a, b) => {
    const ao = a.line.ordinal;
    const bo = b.line.ordinal;
    if (typeof ao === 'number' && Number.isFinite(ao) && typeof bo === 'number' && Number.isFinite(bo) && ao !== bo) {
      return ao - bo;
    }
    return a.seq - b.seq;
  });
  return { lines: collected.map((item) => item.line), badLines };
}

export async function readCodexSession(input: string, options: ReadCodexOptions = {}): Promise<IrBundle> {
  const { path, home } = resolveCodexSessionPath(input, options);
  const segmentFiles = collectThreadSegments(path, home);
  const { lines, badLines } = readMergedRollout(segmentFiles);
  const counters = emptyCounters();
  const notices: IrNotice[] = [];
  const stateThreads = readStateThreads(home);

  const firstMeta = lines.find((line) => line.type === 'session_meta')?.payload as CodexSessionMeta | undefined;
  const pathId = sessionIdFromRolloutPath(path);
  const selfClassification = classifyCodexThread(firstMeta, pathId !== undefined ? stateThreads.get(pathId) : undefined);
  // Codex 会在 spawned subagent 的 session_meta.session_id 写入父会话 id；子代理自身 id 以文件名/state_5 为准
  const sessionId =
    selfClassification.isSubagent && pathId !== undefined
      ? pathId
      : (firstMeta?.session_id ?? firstMeta?.id ?? pathId ?? 'unknown');
  const stateRow = stateThreads.get(sessionId);

  let title = options.title ?? stateRow?.name;
  if (title === undefined) {
    try {
      const index: CodexIndexEntry[] = readSessionIndex(home);
      title = index.find((entry) => entry.id === sessionId)?.thread_name;
    } catch {
      // 索引缺失不影响读取
    }
  }
  if (title === undefined) title = stateRow?.title ?? firstUserText(lines);

  const events: IrEvent[] = [];
  const pendingCalls = new Map<string, number>();
  let index = 0;
  let model: string | undefined;
  let provider: string | undefined;
  let gitBranch: string | undefined;
  let createdAt: string | undefined;
  let historyMode: string | undefined;

  const push = (event: IrEventInput): void => {
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

    if (line.type === 'token_usage_record' || line.type === 'world_state' || line.type === 'inter_agent_communication_metadata') {
      counters.systemLines += 1;
      continue;
    }

    if (line.type === 'response_item') {
      const itemType = typeof payload.type === 'string' ? payload.type : '';
      if (itemType === 'additional_tools' || itemType === 'configuration_update') {
        counters.systemLines += 1;
        continue;
      }
      if (itemType === 'agent_message') {
        counters.interAgentMessages += 1;
        continue;
      }
      if (itemType === 'message') {
        const role = payload.role;
        if (role === 'user') {
          const text = textFromBlocks(payload.content, new Set(['input_text', 'text']));
          if (text.length > 0) {
            const synthetic = isCodexInjectedUserText(text);
            const event: IrEventInput = { kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] };
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
      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        const callId = String(payload.call_id ?? payload.id ?? '');
        let input: unknown;
        if (itemType === 'function_call') {
          if (typeof payload.arguments === 'string') {
            try {
              JSON.parse(payload.arguments);
            } catch {
              counters.badToolArgs += 1;
            }
          }
          input = parseArguments(payload.arguments);
        } else {
          input = typeof payload.input === 'string' ? payload.input : (payload.input ?? '');
        }
        pendingCalls.set(callId, (pendingCalls.get(callId) ?? 0) + 1);
        push({
          kind: 'tool_call',
          at,
          callId,
          name: String(payload.name ?? 'unknown'),
          input,
        });
        continue;
      }
      if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        if (
          line.metadata?.additional_context_tool_output === true &&
          (payload.call_id === undefined || payload.call_id === null || payload.call_id === '')
        ) {
          counters.ambientToolOutputs += 1;
          continue;
        }
        const callId = String(payload.call_id ?? '');
        const pending = pendingCalls.get(callId) ?? 0;
        if (pending > 1) pendingCalls.set(callId, pending - 1);
        else if (pending === 1) pendingCalls.delete(callId);
        else counters.orphanToolResults += 1;
        const output = payload.output;
        const text =
          itemType === 'custom_tool_call_output'
            ? customOutputText(output)
            : typeof output === 'string'
              ? output
              : JSON.stringify(output ?? '');
        push({
          kind: 'tool_result',
          at,
          callId,
          content: [{ type: 'text', text }],
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
  if (counters.interAgentMessages > 0) {
    notices.push({
      code: 'codex.agent-message-skipped',
      message: 'agent_message 是 Codex 内部多代理通信消息（含加密负载），已跳过',
      count: counters.interAgentMessages,
      severity: 'info',
    });
  }
  if (counters.ambientToolOutputs > 0) {
    notices.push({
      code: 'codex.ambient-context-skipped',
      message: '附加环境状态输出（additional_context_tool_output，如浏览器标签/应用页面快照）不属于对话工具调用，已跳过',
      count: counters.ambientToolOutputs,
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
  let unmatchedToolCalls = 0;
  for (const count of pendingCalls.values()) unmatchedToolCalls += count;
  if (unmatchedToolCalls > 0) {
    notices.push({
      code: 'codex.tool-without-output',
      message: '部分 function_call 没有对应的 function_call_output（可能因中断或子代理分叉产生），仅保留了调用',
      count: unmatchedToolCalls,
      severity: 'warning',
    });
  }
  if (counters.orphanToolResults > 0) {
    notices.push({
      code: 'codex.orphan-tool-result',
      message: '部分 function_call_output 找不到对应的 function_call，已按原样保留',
      count: counters.orphanToolResults,
      severity: 'warning',
    });
  }
  for (const [key, count] of counters.unknownLines) {
    notices.push({ code: 'codex.unknown-line', message: '未识别的 rollout 结构 ' + key, count, severity: 'warning' });
  }
  if (badLines > 0) {
    notices.push({ code: 'codex.bad-lines', message: 'rollout 中有无法解析的行', count: badLines, severity: 'warning' });
  }

  const latestPath = segmentFiles[segmentFiles.length - 1] ?? path;
  const source = {
    agent: 'codex' as const,
    cliVersion: firstMeta?.cli_version,
    formatVersion: historyMode,
    nativeSessionId: sessionId,
    nativePath: latestPath,
  };

  const session: IrSession = {
    id: 'codex:' + sessionId,
    source,
    meta: {
      cwd: firstMeta?.cwd ?? stateRow?.cwd,
      title,
      createdAt,
      model,
      profile: firstMeta?.originator ?? stateRow?.originator,
      ...(stateRow?.archived === true ? { archived: true } : {}),
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  const children: IrChildSession[] = [];
  if (options.includeChildren !== false && !selfClassification.isSubagent && !selfClassification.isGuardian) {
    const childEntries = await loadSpawnedChildSessions(home, sessionId, stateThreads);
    children.push(...childEntries);
    if (children.length > 0) {
      notices.push({
        code: 'codex.subagents',
        message: '已将 Codex 派生的子代理线程作为子会话读取',
        count: children.length,
        severity: 'info',
      });
    }
  }

  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children };
}

async function loadSpawnedChildSessions(
  home: string,
  parentSessionId: string,
  stateThreads: Map<string, CodexStateThreadRow>,
): Promise<IrChildSession[]> {
  const allFiles = listRolloutFiles(home);
  if (allFiles.length === 0) return [];
  const grouped = new Map<string, string[]>();
  for (const file of allFiles) {
    const tid = sessionIdFromRolloutPath(file);
    if (tid === undefined || tid === parentSessionId) continue;
    const arr = grouped.get(tid) ?? [];
    arr.push(file);
    grouped.set(tid, arr);
  }

  const out: Array<{ createdAt: string; child: IrChildSession }> = [];
  for (const [childId, files] of grouped) {
    const stateRow = stateThreads.get(childId);
    const stateCls = classifyCodexThread(undefined, stateRow);
    // 快速剪枝：state_5.sqlite 已明确标注属于其它父线程或属于普通用户/guardian 线程时跳过解压
    if (stateRow !== undefined && stateCls.parentThreadId !== undefined && stateCls.parentThreadId !== parentSessionId) continue;
    if (stateRow !== undefined && stateCls.parentThreadId === undefined && (stateRow.threadSource === 'user' || stateCls.isGuardian)) continue;

    const sorted = sortSegmentsChronological(files);
    const firstFile = sorted[0]!;
    const headText = await readRolloutHead(firstFile, 32 * 1024).catch(() => '');
    const firstLine = parseRollout(headText).lines.find((line) => line.type === 'session_meta');
    const meta = firstLine?.payload as CodexSessionMeta | undefined;
    const cls = classifyCodexThread(meta, stateRow);
    if (cls.parentThreadId !== parentSessionId) continue;

    const childBundle = await readCodexSession(sorted[sorted.length - 1]!, { home, includeChildren: false });
    const label = cls.agentLabel ?? childId.slice(0, 8);
    out.push({
      createdAt: childBundle.root.meta.createdAt ?? '',
      child: {
        session: childBundle.root,
        parentSessionId,
        label,
      },
    });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out.map((item) => item.child);
}

function firstUserText(lines: CodexLine[]): string | undefined {
  for (const line of lines) {
    if (line.type !== 'response_item') continue;
    const payload = (line.payload ?? {}) as Record<string, unknown>;
    if (payload.type !== 'message' || payload.role !== 'user') continue;
    const text = textFromBlocks(payload.content, new Set(['input_text', 'text'])).trim();
    if (text.length > 0 && !isCodexInjectedUserText(text)) return text.slice(0, 60);
  }
  return undefined;
}

