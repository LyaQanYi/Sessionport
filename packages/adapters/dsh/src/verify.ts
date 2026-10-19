/**
 * DSH 会话结构自检 + 无头 resume 冒烟。
 *
 * 结构检查不依赖 DSH 应用，直接按官方 app.asar 源码里的校验规则检查：
 * 头行字段、首帧单行、seq 连续、surfaceOp 标记、known event types、
 * message 形状、assistant stream 可组装回 content、tool_use/tool_result 配对、
 * turn/step 平衡、会话目录名/projectKey 规则；无关事件只要带 ignorable 就放行。
 *
 * resume 冒烟使用安装包自带的 headless profile：
 *   ELECTRON_RUN_AS_NODE=1 DSH_HOME=<隔离目录> \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --expose-internals "<app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
 *     headless --json --session-id <id> "continue"
 * 没有 API key 时模型调用会报 MISSING_CREDENTIAL，但 stdout 已经证明会话被加载并开始 turn。
 */
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { existsSync } from 'node:fs';

import { dshHome, encodeSegment, projectKey, resolveDshSessionPath } from './paths.ts';
import { readZstdJsonl, scanZstdFrames } from './zstd.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyDshOptions {
  home?: string;
  sessionId: string;
}

export interface VerifyDshReport {
  ok: boolean;
  sessionId: string;
  filePath?: string;
  sessionDir?: string;
  frames?: number;
  events?: number;
  checks: VerifyCheck[];
}

const ALLOWED_ENVELOPE_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable']);
const HEADER_REQUIRED = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'];
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'];
const HEADER_ALLOWED = new Set([...HEADER_REQUIRED, ...HEADER_OPTIONAL]);
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const MESSAGE_ROLE: Record<string, string> = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
};
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown, nonNegative = false): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && (!nonNegative || value >= 0) && !Object.is(value, -0);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

interface TimedChunk {
  time: number;
  chunk: Record<string, unknown>;
}

/** 展开官方 durable assistant stream（compact records + 原始 chunk record）。 */
function expandAssistantStream(stream: unknown[]): TimedChunk[] {
  const out: TimedChunk[] = [];
  for (const candidate of stream) {
    if (!isRecord(candidate)) throw new Error('stream member is not an object');
    if (candidate.type === 'chunk') {
      if (!isRecord(candidate.chunk)) throw new Error('stream chunk member lacks chunk');
      if (!isSafeInt(candidate.time)) throw new Error('stream chunk member has invalid time');
      out.push({ time: candidate.time as number, chunk: candidate.chunk });
      continue;
    }
    const type = candidate.type;
    const index = candidate.index;
    if (!isSafeInt(index, true)) throw new Error('compact stream record has invalid index');
    if (!isSafeInt(candidate.time0)) throw new Error('compact stream record has invalid time0');
    if (!Array.isArray(candidate.dt)) throw new Error('compact stream record has invalid dt');
    let time = candidate.time0 as number;
    if (type === 'text-chunks' || type === 'reasoning-chunks') {
      const texts = candidate.texts;
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) throw new Error('compact text record has invalid texts');
      texts.forEach((text, position) => {
        if (position > 0) time += candidate.dt[position - 1] as number;
        out.push({ time, chunk: { type: type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index, text } });
      });
      continue;
    }
    if (type === 'tool-call-chunks') {
      const args = candidate.args;
      if (typeof candidate.id !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new Error('compact tool-call record is invalid');
      }
      args.forEach((argumentsDelta, position) => {
        if (position > 0) time += candidate.dt[position - 1] as number;
        const chunk: Record<string, unknown> = { type: 'tool-call-delta', index, id: candidate.id, argumentsDelta };
        if (typeof candidate.name === 'string') chunk.name = candidate.name;
        out.push({ time, chunk });
      });
      continue;
    }
    throw new Error('unknown compact stream record type ' + String(type));
  }
  return out;
}

interface AssembledStream {
  blocks: unknown[];
  usage?: unknown;
  replayState?: unknown;
}

/** 官方 BlockAssembler 的最小镜像，仅用于校验 durable stream 与 content 一致。 */
function assembleAssistantStream(stream: unknown[]): AssembledStream {
  const chunks = expandAssistantStream(stream);
  const partials = new Map<number, { blockType: string; text: string; args: string; id?: string; name?: string; block?: unknown }>();
  const order: number[] = [];
  let usage: unknown;
  let finish: { reason?: unknown; replayState?: unknown } | undefined;
  const ensure = (index: number, blockType: string): { blockType: string; text: string; args: string; id?: string; name?: string; block?: unknown } => {
    let partial = partials.get(index);
    if (partial === undefined) {
      partial = { blockType, text: '', args: '' };
      partials.set(index, partial);
      order.push(index);
    }
    return partial;
  };
  for (const { chunk } of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        const index = chunk.index;
        if (!isSafeInt(index, true)) throw new Error('block-start has invalid index');
        if (!partials.has(index as number)) {
          order.push(index as number);
          partials.set(index as number, { blockType: String(chunk.blockType), text: '', args: '' });
        }
        break;
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const index = chunk.index;
        if (!isSafeInt(index, true)) throw new Error('delta has invalid index');
        const partial = ensure(index as number, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block === undefined) partial.text += String(chunk.text);
        break;
      }
      case 'tool-call-delta': {
        const index = chunk.index;
        if (!isSafeInt(index, true)) throw new Error('tool-call-delta has invalid index');
        const partial = ensure(index as number, 'tool-call');
        if (partial.block === undefined) {
          partial.id = String(chunk.id);
          if (typeof chunk.name === 'string') partial.name = chunk.name;
          partial.args += String(chunk.argumentsDelta);
        }
        break;
      }
      case 'block-end': {
        const index = chunk.index;
        if (!isSafeInt(index, true)) throw new Error('block-end has invalid index');
        const block = chunk.block;
        if (!isRecord(block)) throw new Error('block-end lacks block');
        const partial = ensure(index as number, String(block.type));
        if (partial.block === undefined) partial.block = block;
        break;
      }
      case 'usage':
        usage = chunk.usage;
        break;
      case 'finish':
        finish = { reason: chunk.reason, replayState: chunk.replayState };
        break;
      default:
        throw new Error('unknown stream chunk type ' + String(chunk.type));
    }
  }
  const blocks = order.map((index) => {
    const partial = partials.get(index)!;
    if (partial.block !== undefined) return partial.block;
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text };
      case 'reasoning': return { type: 'reasoning', text: partial.text };
      case 'tool-call': return { type: 'tool-call', id: partial.id ?? 'call-' + index, name: partial.name ?? '', arguments: partial.args };
      default: throw new Error('cannot assemble open block type ' + partial.blockType);
    }
  });
  void finish;
  return { blocks, usage, replayState: finish?.replayState };
}

interface ParsedRow {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
  sourceEventSeqs?: unknown;
  ignorable?: unknown;
}

function asRow(value: unknown): ParsedRow | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !isSafeInt(value.seq, true) || !isSafeInt(value.time) || !isRecord(value.data)) return undefined;
  return {
    type: value.type,
    seq: value.seq as number,
    time: value.time as number,
    data: value.data,
    surfaceOp: value.surfaceOp,
    sourceEventSeqs: value.sourceEventSeqs,
    ignorable: value.ignorable,
  };
}

function checkHeader(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['头行不是对象'];
  for (const key of HEADER_REQUIRED) if (!Object.hasOwn(value, key)) errors.push('缺少必需字段 ' + key);
  for (const key of Object.keys(value)) if (!HEADER_ALLOWED.has(key)) errors.push('多出非白名单字段 ' + key);
  if (Object.hasOwn(value, 'sandboxMode') || Object.hasOwn(value, 'approvalPolicy')) errors.push('包含已废弃字段 sandboxMode/approvalPolicy');
  if (value.type !== 'session') errors.push('type 不是 session');
  if (value.version !== 4) errors.push('version 不是 4');
  if (typeof value.id !== 'string' || value.id.length === 0) errors.push('id 非法');
  if (!isSafeInt(value.createdAt, true)) errors.push('createdAt 不是非负安全整数');
  if (typeof value.isSeeded !== 'boolean') errors.push('isSeeded 不是布尔');
  if (!isSafeInt(value.delegationDepth, true)) errors.push('delegationDepth 不是非负安全整数');
  if (Object.hasOwn(value, 'cwd') && !(typeof value.cwd === 'string' && isAbsolute(value.cwd))) errors.push('cwd 不是绝对路径');
  if (Object.hasOwn(value, 'origin') && value.origin !== 'subagent') errors.push('origin 只能是 subagent');
  return errors;
}

function checkMessageShape(row: ParsedRow): string[] {
  const errors: string[] = [];
  const expectedRole = MESSAGE_ROLE[row.type];
  if (expectedRole === undefined) return errors;
  const message = row.type === 'user/message' ? row.data : isRecord(row.data.message) ? row.data.message : undefined;
  if (!isRecord(message)) return ['缺少 message 对象'];
  if (typeof message.id !== 'string' || message.id.length === 0) errors.push('message 缺 id');
  if (message.role !== expectedRole) errors.push('message.role 应为 ' + expectedRole);
  if (!Array.isArray(message.content)) errors.push('message.content 不是数组');
  if (!isRecord(message.source) || typeof message.source.kind !== 'string' || message.source.kind.length === 0) {
    errors.push('message.source.kind 非法');
  } else if (row.type === 'system/message' && message.source.kind !== 'system-prompt') {
    errors.push('system/message source.kind 应为 system-prompt');
  } else if (row.type === 'assistant/message') {
    if (message.source.kind !== 'model') errors.push('assistant/message source.kind 应为 model');
    if (typeof message.source.provider !== 'string' || typeof message.source.model !== 'string') errors.push('assistant source 缺 provider/model');
  } else if (row.type === 'tool/result') {
    if (message.source.kind !== 'tool' || typeof message.source.callId !== 'string') errors.push('tool/result source 非法');
    if (message.toolCallId !== message.source.callId) errors.push('toolCallId 与 source.callId 不一致');
  }
  return errors;
}

/** 结构自检。 */
export async function verifyDshSession(options: VerifyDshOptions): Promise<VerifyDshReport> {
  const home = dshHome(options.home);
  const checks: VerifyCheck[] = [];
  let resolved: Awaited<ReturnType<typeof resolveDshSessionPath>>;
  try {
    resolved = await resolveDshSessionPath(options.sessionId, home);
  } catch (error) {
    return {
      ok: false,
      sessionId: options.sessionId,
      checks: [{ name: 'session-file-exists', ok: false, detail: String(error) }],
    };
  }

  const report: VerifyDshReport = { ok: false, sessionId: options.sessionId, filePath: resolved.filePath, sessionDir: resolved.sessionDir, checks };
  checks.push({ name: 'session-file-exists', ok: true, detail: resolved.filePath });

  let jsonl: Awaited<ReturnType<typeof readZstdJsonl>>;
  try {
    jsonl = await readZstdJsonl(resolved.filePath);
  } catch (error) {
    checks.push({ name: 'zstd-frames-decodable', ok: false, detail: String(error) });
    return report;
  }
  report.frames = jsonl.frames.length;
  checks.push({ name: 'zstd-frames-decodable', ok: true, detail: jsonl.frames.length + ' frames' });
  checks.push({ name: 'no-torn-tail', ok: jsonl.tornStart === undefined, detail: jsonl.tornStart === undefined ? 'ok' : 'torn frame at byte ' + jsonl.tornStart });

  // 首帧必须恰好是一行头
  try {
    const first = jsonl.frames[0]!;
    const buffer = await readFile(resolved.filePath);
    const text = zstdDecompressSync(buffer.subarray(first.start, first.end)).toString('utf8');
    const newline = text.indexOf('\n');
    checks.push({ name: 'header-first-frame-single-line', ok: newline === text.length - 1, detail: 'first frame ' + first.end - first.start + ' bytes' });
  } catch (error) {
    checks.push({ name: 'header-first-frame-single-line', ok: false, detail: String(error) });
  }

  const rows: ParsedRow[] = [];
  let badLines = 0;
  for (const line of jsonl.lines) {
    try {
      const value = JSON.parse(line) as unknown;
      rows.push(value as ParsedRow);
    } catch {
      badLines += 1;
    }
  }
  checks.push({ name: 'jsonl-parses', ok: badLines === 0, detail: badLines + ' bad lines' });

  const headerErrors = checkHeader(rows[0]);
  checks.push({ name: 'header-shape', ok: headerErrors.length === 0, detail: headerErrors.length === 0 ? 'ok' : headerErrors.join('; ') });
  const header = rows[0];
  const headerId = isRecord(header) && typeof header.id === 'string' ? header.id : '';

  checks.push({
    name: 'session-id-matches-directory',
    ok: encodeSegment(headerId) === basename(resolved.sessionDir),
    detail: 'header.id=' + headerId + ' dir=' + basename(resolved.sessionDir),
  });
  const headerCwd = isRecord(header) && typeof header.cwd === 'string' ? header.cwd : undefined;
  const expectedProject = headerCwd === undefined ? '_no-cwd' : projectKey(headerCwd);
  checks.push({
    name: 'project-directory-key',
    ok: expectedProject === basename(dirname(resolved.sessionDir)),
    detail: 'expected ' + expectedProject + ' actual ' + basename(dirname(resolved.sessionDir)),
  });

  const events: ParsedRow[] = [];
  let envelopeErrors = 0;
  let surfaceErrors = 0;
  let unknownTypes = 0;
  let seq = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isRecord(row) || typeof row.type !== 'string' || !isSafeInt(row.seq, true) || !isSafeInt(row.time) || !isRecord(row.data)) {
      envelopeErrors += 1;
      continue;
    }
    for (const key of Object.keys(row)) if (!ALLOWED_ENVELOPE_KEYS.has(key)) envelopeErrors += 1;
    if ((row.seq as number) !== seq) envelopeErrors += 1;
    seq += 1;
    const event: ParsedRow = {
      type: row.type,
      seq: row.seq as number,
      time: row.time as number,
      data: row.data,
      surfaceOp: row.surfaceOp,
      sourceEventSeqs: row.sourceEventSeqs,
      ignorable: row.ignorable,
    };
    events.push(event);
    const surface = SURFACE_TYPES.has(event.type);
    if (surface) {
      if (event.surfaceOp === undefined) surfaceErrors += 1;
      else if (event.surfaceOp !== 'append') {
        if (!isRecord(event.surfaceOp)) surfaceErrors += 1;
        else if (!isSafeInt(event.surfaceOp.startSeq, true) || !isSafeInt(event.surfaceOp.endSeq, true)) surfaceErrors += 1;
        else if ((event.surfaceOp.startSeq as number) >= event.seq || (event.surfaceOp.endSeq as number) >= event.seq) surfaceErrors += 1;
      }
    } else if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
      surfaceErrors += 1;
    }
    if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) unknownTypes += 1;
  }
  report.events = events.length;
  checks.push({ name: 'event-envelope', ok: envelopeErrors === 0, detail: envelopeErrors + ' issues / ' + events.length + ' events' });
  checks.push({ name: 'surface-markers', ok: surfaceErrors === 0, detail: surfaceErrors + ' issues' });
  checks.push({ name: 'known-event-types', ok: unknownTypes === 0, detail: unknownTypes + ' unknown without ignorable' });

  // message 形状
  const messageErrors: string[] = [];
  for (const event of events) {
    if (!SURFACE_TYPES.has(event.type)) continue;
    messageErrors.push(...checkMessageShape(event));
  }
  checks.push({ name: 'message-shapes', ok: messageErrors.length === 0, detail: messageErrors.slice(0, 5).join('; ') || 'ok' });

  // assistant stream 与 content 一致性
  const streamErrors: string[] = [];
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    if (!isSafeInt(event.data.turn, true) || !isSafeInt(event.data.step, true)) {
      streamErrors.push('seq ' + event.seq + ' turn/step 非法');
      continue;
    }
    if (!Array.isArray(event.data.stream)) {
      streamErrors.push('seq ' + event.seq + ' stream 不是数组');
      continue;
    }
    if (event.type === 'assistant/attempt') continue;
    try {
      const assembled = assembleAssistantStream(event.data.stream);
      const message = isRecord(event.data.message) ? event.data.message : {};
      if (!deepEqual(assembled.blocks, message.content)) streamErrors.push('seq ' + event.seq + ' stream 组装结果 != content');
      if (!deepEqual(assembled.usage, event.data.usage)) streamErrors.push('seq ' + event.seq + ' stream usage != data.usage');
      const source = isRecord(message.source) ? message.source : {};
      if (!deepEqual(assembled.replayState, source.replayState)) streamErrors.push('seq ' + event.seq + ' stream replayState != source.replayState');
    } catch (error) {
      streamErrors.push('seq ' + event.seq + ' ' + String(error));
    }
  }
  checks.push({ name: 'assistant-streams', ok: streamErrors.length === 0, detail: streamErrors.slice(0, 5).join('; ') || 'ok' });

  // tool_use / tool_result 配对（assistant content 的 tool-call 块 <-> tool/result message）
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const message = isRecord(event.data.message) ? event.data.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) if (isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string') callIds.add(block.id);
    } else if (event.type === 'tool/result') {
      const message = isRecord(event.data.message) ? event.data.message : {};
      if (typeof message.toolCallId === 'string') resultIds.add(message.toolCallId);
    }
  }
  const missingResults = [...callIds].filter((id) => !resultIds.has(id));
  const orphanResults = [...resultIds].filter((id) => !callIds.has(id));
  checks.push({
    name: 'tool-pairing',
    ok: missingResults.length === 0 && orphanResults.length === 0,
    detail: 'missing=' + missingResults.length + ' orphan=' + orphanResults.length,
  });

  // turn/step 平衡
  let openTurns = 0;
  let openSteps = 0;
  let turnStart = 0;
  let turnErrors = 0;
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurns += 1;
      if (turnStart === 0 && event.data.turn !== 1) turnErrors += 1;
      turnStart += 1;
      if (event.data.turn !== turnStart) turnErrors += 1;
    } else if (event.type === 'turn/end') {
      openTurns -= 1;
      if (event.data.turn !== turnStart) turnErrors += 1;
    } else if (event.type === 'step/start') openSteps += 1;
    else if (event.type === 'step/end') openSteps -= 1;
    if (openTurns < 0 || openSteps < 0 || openSteps > 1) turnErrors += 1;
  }
  checks.push({
    name: 'turn-step-balance',
    ok: openTurns === 0 && openSteps === 0 && turnErrors === 0,
    detail: 'openTurns=' + openTurns + ' openSteps=' + openSteps + ' errors=' + turnErrors,
  });

  // 信息性检查：projcache / workspace 注册（不参与 ok）
  const projcachePath = join(home, 'storages', 'session_projcache', 'sessions', headerId + '.json');
  const projcache = await access(projcachePath).then(() => true).catch(() => false);
  checks.push({ name: 'projcache-present', ok: true, detail: projcache ? 'present (cache only)' : 'absent (DSH rebuilds from events)' });
  try {
    const raw = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8')) as unknown;
    const workspaces = isRecord(raw) && isRecord(raw.tables) && isRecord(raw.tables.workspaces) ? raw.tables.workspaces : {};
    const registered = Object.values(workspaces).some((record) => isRecord(record) && Array.isArray(record.sessionIds) && record.sessionIds.includes(headerId));
    checks.push({ name: 'workspace-registered', ok: true, detail: registered ? 'present in workspace.json' : 'not registered (DSH bootstraps at startup)' });
  } catch {
    checks.push({ name: 'workspace-registered', ok: true, detail: 'no workspace.json (headless home)' });
  }

  report.ok = checks.every((check) => check.ok);
  return report;
}

// ---------------------------------------------------------------------------
// 无头 resume 冒烟（需要安装包存在；不需要 API key 也能证明会话被加载）
// ---------------------------------------------------------------------------

export interface DshResumeSmokeOptions {
  home: string;
  sessionId: string;
  prompt?: string;
  cwd?: string;
  /** 默认 /Applications/DeepSeek Harness.app */
  appPath?: string;
  /** 额外环境变量（例如 DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY 指向 mock 服务） */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface DshResumeSmokeResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout 里出现 session 事件：会话被真实加载 */
  loaded: boolean;
  /** stdout 里出现 turn_start：已开始新一轮 */
  turnStarted: boolean;
  /** 没有模型凭据（不影响 loaded 结论） */
  missingCredential: boolean;
}

export function dshAppPaths(appPath?: string): { binary: string; cliJs: string } | undefined {
  const root = appPath ?? process.env.DSH_APP_PATH ?? '/Applications/DeepSeek Harness.app';
  const binary = join(root, 'Contents', 'MacOS', 'DeepSeek Harness');
  const cliJs = join(root, 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  return { binary, cliJs };
}

/**
 * 用安装包自带 headless profile 真实加载会话。
 * 隔离 DSH_HOME 必须传入；绝不触碰 ~/.dsh。
 */
export function resumeSmokeDsh(options: DshResumeSmokeOptions): Promise<DshResumeSmokeResult> {
  const paths = dshAppPaths(options.appPath);
  if (paths === undefined) return Promise.resolve({ ok: false, command: '', exitCode: null, stdout: '', stderr: 'cannot locate DSH app', timedOut: false, loaded: false, turnStarted: false, missingCredential: false });
  const prompt = options.prompt ?? 'Reply with exactly: RESUME_OK';
  const args = ['--expose-internals', paths.cliJs, 'headless', '--json', '--session-id', options.sessionId, prompt];
  const command = 'ELECTRON_RUN_AS_NODE=1 DSH_HOME=' + options.home + ' "' + paths.binary + '" ' + args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ');
  return new Promise((resolveResult) => {
    const child = spawn(paths.binary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: options.home, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120000);
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, command, exitCode: null, stdout, stderr: stderr + String(error), timedOut, loaded: false, turnStarted: false, missingCredential: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = stdout + '\n' + stderr;
      const loaded = stdout.includes('"type":"session"') && stdout.includes(options.sessionId);
      const turnStarted = stdout.includes('"phase":"turn_start"');
      const missingCredential = combined.includes('MISSING_CREDENTIAL');
      resolveResult({
        ok: loaded && turnStarted,
        command,
        exitCode: code,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000),
        timedOut,
        loaded,
        turnStarted,
        missingCredential,
      });
    });
  });
}
/** 同步用：统计 DSH 会话事件数（不含首行 header）。 */
export async function countDshTarget(options: { home?: string; sessionId: string }): Promise<{ exists: boolean; units: number; path?: string }> {
  try {
    const home = dshHome(typeof options.home === 'string' ? options.home : undefined);
    const resolved = await resolveDshSessionPath(options.sessionId, home);
    if (!resolved || !existsSync(resolved.filePath)) return { exists: false, units: 0 };
    const parsed = await readZstdJsonl(resolved.filePath);
    return { exists: true, units: Math.max(0, parsed.lines.length - 1), path: resolved.filePath };
  } catch {
    return { exists: false, units: 0 };
  }
}