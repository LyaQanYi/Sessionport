import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LossCollector, normalizeToolCall } from '@sessionport/core';
import type { ExportCaps, IrBundle, IrContent, IrEvent, IrSession, LossEntry, WriteReport } from '@sessionport/core';

import { codexHome, codexRolloutPath, threadIndexPath } from './wire.ts';
import type { CodexLine, CodexSessionMeta } from './wire.ts';

export const CODEX_CAPS: ExportCaps = {
  agent: 'codex',
  reasoning: 'plain',
  toolResults: 'separate',
  branching: false,
  subagents: false,
  modelPinned: false,
};

export interface WriteCodexOptions {
  /** Codex 数据根目录，默认 $CODEX_HOME 或 ~/.codex */
  home?: string;
  /** 目标工作目录，默认取 IR 的 meta.cwd */
  cwd?: string;
  /** 目标会话 uuid，默认随机 */
  id?: string;
  title?: string;
  model?: string;
  provider?: string;
  cliVersion?: string;
  /** 同时写 UI 层 event_msg 镜像（默认 false，仅 response_item） */
  emitUiEvents?: boolean;
  /** 顺带注册 session_index.jsonl 与 state_5.sqlite threads（默认 false） */
  register?: boolean;
  /** 保留源端注入的 synthetic 消息（默认丢弃） */
  keepInjected?: boolean;
  /** 强制输出到指定 rollout 路径（sync 复用登记路径，避免文件名时间戳漂移） */
  filePath?: string;
  /** rollout 形态：legacy（默认，无 ordinal）或 paginated（每行带递增 ordinal） */
  historyMode?: 'legacy' | 'paginated';
  /** 是否把跨源工具调用改写为 Codex 原生工具（默认 true；--raw-tools 可关闭） */
  normalizeTools?: boolean;
  dryRun?: boolean;
}

export interface WriteCodexResult extends WriteReport {
  /** 除 session_meta 之外的 rollout 行 */
  rows: CodexLine[];
  header: CodexSessionMeta;
  filePath: string;
  cwd: string;
  title: string;
  registered: { sessionIndex: boolean; threadsRow: boolean };
}

interface Chunk {
  role: 'user' | 'assistant';
  at: string;
  blocks: string[];
}

function textOf(content: IrContent[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
        case 'diff':
        case 'terminal':
          return block.text;
        case 'image':
          return '[image: ' + block.ref + ']';
        case 'json':
          return JSON.stringify(block.value);
        default:
          return '';
      }
    })
    .join('\n');
}

function isoOf(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

export async function writeCodexSession(bundle: IrBundle, options: WriteCodexOptions = {}): Promise<WriteCodexResult> {
  const session = bundle.root;
  const home = codexHome(options.home);
  const rawCwd = options.cwd ?? session.meta.cwd ?? process.cwd();
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd);
  const sessionId = options.id ?? randomUUID();
  // Codex 对非 UUID 的 resume id 会静默新建线程（exit 0），必须在写入前拦住
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Codex 会话 id 必须是 UUID（否则 resume 会静默新建会话）: ' + sessionId);
  }
  const title = options.title ?? session.meta.title ?? 'Sessionport import';
  const model = options.model ?? session.meta.model;
  const provider = options.provider ?? 'custom';
  const cliVersion = options.cliVersion ?? '0.163.0';
  const createdAt = session.meta.createdAt && Number.isFinite(Date.parse(session.meta.createdAt)) ? isoOf(session.meta.createdAt) : new Date().toISOString();
  const losses = new LossCollector();
  const counts = { messages: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };
  const rows: CodexLine[] = [];

  const header: CodexSessionMeta = {
    session_id: sessionId,
    id: sessionId,
    timestamp: createdAt,
    cwd,
    runtime_workspace_roots: [cwd],
    originator: 'sessionport',
    cli_version: cliVersion,
    source: 'cli',
    thread_source: 'user',
    model_provider: provider,
    base_instructions: null,
    history_mode: options.historyMode ?? 'legacy',
    git: { branch: '', sha: '', origin_url: '' },
  };

  const push = (line: Omit<CodexLine, 'timestamp'> & { timestamp?: string }, at: string): void => {
    rows.push({ timestamp: isoOf(at), type: line.type, payload: line.payload });
  };

  let pendingCallIds: string[] = [];
  const customCallIds = new Set<string>();
  const toolOutputPayload = (callId: string, output: string): Record<string, unknown> =>
    customCallIds.has(callId)
      ? { type: 'custom_tool_call_output', id: 'ctco_' + randomUUID(), call_id: callId, output }
      : { type: 'function_call_output', id: 'fco_' + randomUUID(), call_id: callId, output };

  for (const event of session.events) {
    const at = event.at;
    if (event.kind === 'message') {
      if (event.role === 'user' && event.synthetic && !options.keepInjected) {
        losses.add('codex.injected-message-dropped', '目标端注入的消息（运行时上下文、技能目录等）已丢弃；Codex 会注入自己的', { severity: 'info' });
        continue;
      }
      const text = event.parts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
      if (text.length === 0) continue;
      push(
        {
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_' + randomUUID(),
            role: event.role,
            content: [{ type: event.role === 'user' ? 'input_text' : 'output_text', text }],
          },
        },
        at,
      );
      counts.messages += 1;
      continue;
    }
    if (event.kind === 'reasoning') {
      counts.reasoning += 1;
      if (event.reasoning.kind !== 'plain') {
        losses.add('codex.opaque-reasoning-dropped', '源端 reasoning 是密文（无可用明文），已丢弃', { severity: 'warning' });
        continue;
      }
      if (event.reasoning.text.length === 0) continue;
      push(
        {
          type: 'response_item',
          payload: {
            type: 'reasoning',
            id: 'rs_' + randomUUID(),
            summary: [{ type: 'summary_text', text: event.reasoning.text }],
            content: [],
            encrypted_content: null,
          },
        },
        at,
      );
      continue;
    }
    if (event.kind === 'tool_call') {
      const normalized = normalizeToolCall({
        target: 'codex',
        sourceAgent: session.source.agent,
        name: event.name,
        input: event.input,
        enabled: options.normalizeTools,
      });
      if (normalized.status === 'normalized') {
        losses.add('codex.tool-normalized', '工具调用已改写为目标端原生工具（--raw-tools 可关闭）', { severity: 'info' });
      } else if (normalized.status === 'unmapped') {
        losses.add('codex.tool-unmapped', '工具调用无法映射到目标端原生工具，保留源端工具名', { severity: 'info' });
      }
      pendingCallIds.push(event.callId);
      const useCustom = normalized.custom === true || typeof normalized.input === 'string';
      if (useCustom) {
        customCallIds.add(event.callId);
        push(
          {
            type: 'response_item',
            payload: {
              type: 'custom_tool_call',
              id: 'ctc_' + randomUUID(),
              status: 'completed',
              call_id: event.callId,
              name: normalized.name,
              input: typeof normalized.input === 'string' ? normalized.input : JSON.stringify(normalized.input ?? ''),
            },
          },
          at,
        );
      } else {
        push(
          {
            type: 'response_item',
            payload: {
              type: 'function_call',
              id: 'fc_' + randomUUID(),
              name: normalized.name,
              arguments: JSON.stringify(normalized.input ?? {}),
              call_id: event.callId,
            },
          },
          at,
        );
      }
      counts.toolCalls += 1;
      continue;
    }
    if (event.kind === 'tool_result') {
      pendingCallIds = pendingCallIds.filter((id) => id !== event.callId);
      push(
        {
          type: 'response_item',
          payload: toolOutputPayload(event.callId, textOf(event.content)),
        },
        at,
      );
      counts.toolResults += 1;
      continue;
    }
    if (event.kind === 'boundary') {
      losses.add('codex.boundary-dropped', '会话边界事件（' + event.boundary + '）在 Codex rollout 中没有对应结构', { severity: 'info' });
    }
  }

  // 有调用无结果：补一条占位输出，保证 rollout 自洽
  for (const callId of pendingCallIds) {
    const lastAt = session.events.length > 0 ? session.events[session.events.length - 1]!.at : createdAt;
    push(
      {
        type: 'response_item',
        payload: toolOutputPayload(callId, '[sessionport] 源会话没有这条工具调用的结果'),
      },
      lastAt,
    );
    losses.add('codex.tool-result-synthesized', '源会话里工具调用没有对应结果，已合成占位输出', { count: 1, severity: 'warning' });
  }

  if (session.source.agent !== 'codex') {
    losses.add('codex.cross-agent-import', '会话来自 ' + session.source.agent + '，消息/工具语义按 Codex rollout 近似还原', { severity: 'info' });
  }
  if (bundle.children.length > 0) {
    const childEvents = bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
    losses.add('codex.subagent-dropped', 'Codex 没有独立的子代理会话 transcript，子代理会话未导出', { count: bundle.children.length });
    losses.add('codex.subagent-events-dropped', '子代理会话的事件未导出', { count: childEvents });
  }
  if (model !== undefined) {
    losses.add('codex.model-not-mapped', '源模型 ' + model + ' 未写入会话元数据；Codex 使用自身配置的模型', { severity: 'info' });
  }

  const at = new Date(createdAt);
  const filePath = options.filePath ?? codexRolloutPath(home, sessionId, at);
  const allLines: CodexLine[] = [{ timestamp: createdAt, type: 'session_meta', payload: header as unknown as Record<string, unknown> }, ...rows];
  // paginated 模式：每行都要有递增 ordinal（缺失会被 codex 判 fatal）
  const lines: CodexLine[] =
    header.history_mode === 'paginated'
      ? allLines.map((line, index) => ({ ...line, ordinal: index }) as CodexLine & { ordinal: number })
      : allLines;
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

  let sessionIndexWritten = false;
  let threadsRowWritten = false;

  if (!options.dryRun) {
    await mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true });
    await writeFile(filePath, body, 'utf8');
    if (options.register === true) {
      try {
        await appendFile(threadIndexPath(home), JSON.stringify({ id: sessionId, thread_name: title, updated_at: new Date().toISOString() }) + '\n', 'utf8');
        sessionIndexWritten = true;
      } catch (error) {
        losses.add('codex.session-index-failed', 'session_index.jsonl 写入失败: ' + String(error), { severity: 'warning' });
      }
      try {
        const dbPath = home + '/state_5.sqlite';
        if (existsSync(dbPath)) {
          const db = new DatabaseSync(dbPath);
          try {
            db.prepare(
              'INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, first_user_message, has_user_event, history_mode) ' +
                'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
                'rollout_path=excluded.rollout_path, updated_at=excluded.updated_at, title=excluded.title, cwd=excluded.cwd, first_user_message=excluded.first_user_message',
            ).run(
              sessionId,
              filePath,
              Math.floor(at.getTime() / 1000),
              Math.floor(Date.now() / 1000),
              'cli',
              provider,
              cwd,
              title,
              'danger-full-access',
              'never',
              cliVersion,
              firstUserMessage(session) ?? '',
              1,
              'legacy',
            );
            threadsRowWritten = true;
          } finally {
            db.close();
          }
        }
      } catch (error) {
        losses.add('codex.threads-row-failed', 'state_5.sqlite threads 行写入失败（不影响 rollout）: ' + String(error), { severity: 'warning' });
      }
    }
  }

  const lossList: LossEntry[] = losses.sorted();
  return {
    target: 'codex',
    sessionId,
    paths: [filePath],
    rows,
    header,
    filePath,
    cwd,
    title,
    registered: { sessionIndex: sessionIndexWritten, threadsRow: threadsRowWritten },
    written: {
      events: session.events.length,
      messages: counts.messages,
      toolCalls: counts.toolCalls,
      toolResults: counts.toolResults,
      reasoning: counts.reasoning,
    },
    losses: lossList,
    caps: CODEX_CAPS,
  };
}

export interface AppendCodexDeltaResult extends WriteCodexResult {
  totalLines: number;
}

/** 仅向已有 Codex rollout 尾部追加增量行，保留 session_meta / encrypted_content 前缀不变并接续 paginated ordinal */
export async function appendCodexDelta(
  filePath: string,
  deltaBundle: IrBundle,
  options: WriteCodexOptions = {},
): Promise<AppendCodexDeltaResult> {
  const existingBuf = await readFile(filePath);
  const existingText = existingBuf.toString('utf8');
  const existingLines = existingText.split('\n').filter((line) => line.trim().length > 0);
  if (existingLines.length === 0) {
    throw new Error('Codex rollout 为空，无法尾部追加: ' + filePath);
  }

  let sessionId = options.id;
  let cwd = options.cwd;
  let historyMode: 'legacy' | 'paginated' = options.historyMode ?? 'legacy';
  let maxOrdinal = -1;

  for (const rawLine of existingLines) {
    try {
      const parsed = JSON.parse(rawLine) as {
        type?: unknown;
        ordinal?: unknown;
        payload?: {
          id?: unknown;
          session_id?: unknown;
          cwd?: unknown;
          history_mode?: unknown;
        };
      };
      if (typeof parsed.ordinal === 'number' && Number.isFinite(parsed.ordinal)) {
        maxOrdinal = Math.max(maxOrdinal, parsed.ordinal);
      }
      if (parsed.type === 'session_meta' && parsed.payload) {
        const metaId = parsed.payload.session_id ?? parsed.payload.id;
        if (sessionId === undefined && typeof metaId === 'string' && metaId.length > 0) sessionId = metaId;
        if (cwd === undefined && typeof parsed.payload.cwd === 'string' && parsed.payload.cwd.length > 0) {
          cwd = parsed.payload.cwd;
        }
        if (parsed.payload.history_mode === 'paginated') historyMode = 'paginated';
      }
    } catch {
      // 跳过坏行
    }
  }

  const dryReport = await writeCodexSession(deltaBundle, {
    ...options,
    id: sessionId,
    cwd,
    historyMode,
    filePath,
    register: false,
    dryRun: true,
  });

  const nextOrdinalStart = maxOrdinal >= 0 ? maxOrdinal + 1 : existingLines.length;
  const rowsToAppend: CodexLine[] =
    historyMode === 'paginated'
      ? dryReport.rows.map((row, idx) => ({ ...row, ordinal: nextOrdinalStart + idx }) as CodexLine & { ordinal: number })
      : dryReport.rows;

  if (rowsToAppend.length > 0 && options.dryRun !== true) {
    const needsNewline = existingBuf.length > 0 && existingBuf[existingBuf.length - 1] !== 0x0a;
    const body = (needsNewline ? '\n' : '') + rowsToAppend.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const tmpPath = filePath + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
    await writeFile(tmpPath, Buffer.concat([existingBuf, Buffer.from(body, 'utf8')]));
    await rename(tmpPath, filePath);
  }

  return {
    ...dryReport,
    rows: rowsToAppend,
    filePath,
    paths: [filePath],
    totalLines: existingLines.length + rowsToAppend.length,
  };
}

function firstUserMessage(session: IrSession): string | undefined {
  for (const event of session.events) {
    if (event.kind !== 'message' || event.role !== 'user' || event.synthetic) continue;
    const text = event.parts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join(' ').trim();
    if (text.length > 0) return text.slice(0, 200);
  }
  return undefined;
}

export function printWriteReport(report: WriteCodexResult): string {
  return [
    'target      ' + report.target,
    'session     ' + report.sessionId,
    'file        ' + report.filePath,
    'cwd         ' + report.cwd,
    'lines       ' + (report.rows.length + 1) + '（含 session_meta）',
    'registered  session_index=' + report.registered.sessionIndex + ' threads=' + report.registered.threadsRow,
  ].join('\n');
}

export type { IrEvent };