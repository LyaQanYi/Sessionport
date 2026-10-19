import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { IR_VERSION, bundleEventCount } from '@sessionport/core';
import type {
  IrBundle,
  IrChildSession,
  IrContent,
  IrEvent,
  IrMessageEvent,
  IrNotice,
  IrSession,
  SourceFingerprint,
} from '@sessionport/core';

import { msToIso, parseWireJsonl } from './wire.ts';
import type { KimiAgentState, KimiLoopEvent, KimiManifest, KimiState, KimiWireLine } from './wire.ts';

const SYSTEM_REMINDER_PREFIX = '<system-reminder>';

/** 已知但不承载对话内容的事件类型 */
const RUNTIME_EVENT_TYPES = new Set<string>([
  'metadata',
  'runtime.set_binding',
  'mcp.tools_discovered',
  'permission.set_mode',
  'profile.bind',
  'config.update',
  'plugin.session_start',
  'llm.tools_snapshot',
  'llm.request',
  'usage.record',
  'token_counting.measured',
  'token_counting.turn_recorded',
  'agent.turn.started',
  'agent.turn.ended',
  'turn.ended',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'file_history.tracked',
  'file_history.checkpoint',
  'interaction.request',
  'interaction.resolved',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'turn.step.interrupted',
  'context.undo',
]);

export interface ReadKimiOptions {
  /** undo 回滚掉的轮次是否从 IR 里裁掉（默认 true，符合「续聊」语义） */
  dropUndoneTurns?: boolean;
}

interface AgentContext {
  agentId: string;
  isRoot: boolean;
  promptTurn: Map<string, number>;
  undoneTurns: Set<number>;
  subagentSpawn: Map<string, { parentToolCallId?: string }>;
  counters: Map<string, number>;
  model?: string;
  profile?: string;
  protocolVersion?: string;
  firstAt?: number;
  lastAt?: number;
}

function newContext(agentId: string, isRoot: boolean): AgentContext {
  return {
    agentId,
    isRoot,
    promptTurn: new Map(),
    undoneTurns: new Set(),
    subagentSpawn: new Map(),
    counters: new Map(),
  };
}

function bump(ctx: AgentContext, key: string, n = 1): void {
  ctx.counters.set(key, (ctx.counters.get(key) ?? 0) + n);
}

function touch(ctx: AgentContext, ms: unknown): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
  if (ctx.firstAt === undefined || ms < ctx.firstAt) ctx.firstAt = ms;
  if (ctx.lastAt === undefined || ms > ctx.lastAt) ctx.lastAt = ms;
}

/** 第一遍：收集 promptId→turnId、undo 轮次、子代理 spawn 关系、模型信息 */
function scanPass(lines: KimiWireLine[], ctx: AgentContext): void {
  for (const line of lines) {
    touch(ctx, line.time);
    switch (line.type) {
      case 'turn.prompt': {
        const promptId = line.promptId;
        const turnId = line.turnId;
        if (typeof promptId === 'string' && typeof turnId === 'number') ctx.promptTurn.set(promptId, turnId);
        break;
      }
      case 'context.undone': {
        const from = line.fromTurnId;
        const turns = line.turns;
        if (typeof from === 'number' && typeof turns === 'number') {
          for (let i = 0; i < turns; i += 1) ctx.undoneTurns.add(from + i);
        }
        break;
      }
      case 'subagent.spawned': {
        const id = line.subagentId;
        if (typeof id === 'string') {
          ctx.subagentSpawn.set(id, {
            parentToolCallId: typeof line.parentToolCallId === 'string' ? line.parentToolCallId : undefined,
          });
        }
        break;
      }
      case 'profile.bind': {
        if (typeof line.modelAlias === 'string') ctx.model = line.modelAlias;
        else if (typeof line.model === 'string') ctx.model = line.model;
        if (typeof line.profileName === 'string') ctx.profile = line.profileName;
        break;
      }
      case 'llm.request': {
        if (!ctx.model && typeof line.modelAlias === 'string') ctx.model = line.modelAlias;
        break;
      }
      case 'metadata': {
        if (typeof line.protocol_version === 'string') ctx.protocolVersion = line.protocol_version;
        break;
      }
      default:
        break;
    }
  }
}

function toolResultContent(result: unknown): { content: IrContent[]; isError: boolean } {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const isError = Boolean(r.isError);
    if (typeof r.output === 'string') {
      return { content: [{ type: 'text', text: r.output }], isError };
    }
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(r)) {
      if (key === 'output' || key === 'isError' || key === 'durationMs') continue;
      rest[key] = r[key];
    }
    return { content: [{ type: 'json', value: rest }], isError };
  }
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }], isError: false };
  return { content: [{ type: 'json', value: result ?? null }], isError: false };
}

/** 把一条 wire 行映射成 0..n 个 IR 事件（不含 id/parentId，由调用方串联） */
function mapWireLine(line: KimiWireLine, skipped: Map<string, number>): IrEvent[] {
  const at = msToIso(line.time) ?? new Date(0).toISOString();
  const type = line.type ?? '';

  if (type === 'context.append_message') {
    const msg = (line.message ?? {}) as Record<string, unknown>;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
    const parts: IrMessageEvent['parts'] = [];
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string') parts.push({ type: 'text', text: c.text });
    }
    if (parts.length === 0) return [];
    const synthetic = parts.some((p) => p.type === 'text' && p.text.startsWith(SYSTEM_REMINDER_PREFIX));
    const ev: IrMessageEvent = {
      kind: 'message',
      id: '',
      parentId: null,
      at,
      role,
      parts,
      _native: line,
    };
    if (synthetic) ev.synthetic = true;
    return [ev];
  }

  if (type === 'context.append_loop_event') {
    const ev = (line.event ?? {}) as KimiLoopEvent;
    if (ev.type === 'content.part') {
      const part = ev.part ?? {};
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        return [
          {
            kind: 'message',
            id: '',
            parentId: null,
            at,
            role: 'assistant',
            parts: [{ type: 'text', text: part.text }],
            _native: line,
          } satisfies IrMessageEvent,
        ];
      }
      if (part.type === 'think' && typeof part.think === 'string' && part.think.length > 0) {
        return [{ kind: 'reasoning', id: '', parentId: null, at, reasoning: { kind: 'plain', text: part.think }, _native: line }];
      }
      skipped.set('part:' + String(part.type), (skipped.get('part:' + String(part.type)) ?? 0) + 1);
      return [];
    }
    if (ev.type === 'tool.call') {
      return [
        {
          kind: 'tool_call',
          id: '',
          parentId: null,
          at,
          callId: String(ev.toolCallId ?? ev.uuid ?? ''),
          name: String(ev.name ?? 'unknown'),
          input: ev.args ?? null,
          _native: line,
        },
      ];
    }
    if (ev.type === 'tool.result') {
      const parsed = toolResultContent(ev.result);
      return [
        {
          kind: 'tool_result',
          id: '',
          parentId: null,
          at,
          callId: String(ev.toolCallId ?? ''),
          content: parsed.content,
          isError: parsed.isError,
          _native: line,
        },
      ];
    }
    if (ev.type === 'step.begin' || ev.type === 'step.end') return [];
    skipped.set('loop:' + String(ev.type), (skipped.get('loop:' + String(ev.type)) ?? 0) + 1);
    return [];
  }

  if (type === 'agent.switched') {
    return [
      {
        kind: 'boundary',
        id: '',
        parentId: null,
        at,
        boundary: 'fork',
        detail: 'reason=' + String(line.reason ?? 'unknown') + ' branch=' + String(line.branch ?? '') + ' turns=' + String(line.turns ?? ''),
        _native: line,
      },
    ];
  }

  if (type === 'context.undone') {
    return [
      {
        kind: 'boundary',
        id: '',
        parentId: null,
        at,
        boundary: 'undo',
        detail: 'fromTurnId=' + String(line.fromTurnId ?? '') + ' turns=' + String(line.turns ?? ''),
        _native: line,
      },
    ];
  }

  if (type === 'token_counting.truncated') {
    return [
      {
        kind: 'boundary',
        id: '',
        parentId: null,
        at,
        boundary: 'compact',
        detail: 'truncated to ' + String(line.tokens ?? '') + ' tokens',
        _native: line,
      },
    ];
  }

  if (type === 'turn.cancel') {
    return [
      {
        kind: 'boundary',
        id: '',
        parentId: null,
        at,
        boundary: 'cancel',
        detail: 'turnId=' + String(line.turnId ?? '') + ' reason=' + String(line.reason ?? ''),
        _native: line,
      },
    ];
  }

  skipped.set('unmapped:' + type, (skipped.get('unmapped:' + type) ?? 0) + 1);
  return [];
}

interface ReadAgentResult {
  session: IrSession;
  ctx: AgentContext;
}

/** 读取单个 agent 的 wire.jsonl（main 或某个子代理） */
async function readAgent(
  dir: string,
  state: KimiState,
  manifest: KimiManifest | undefined,
  agents: Record<string, KimiAgentState>,
  agentId: string,
  isRoot: boolean,
  opts: Required<ReadKimiOptions>,
): Promise<ReadAgentResult | null> {
  const wirePath = join(dir, 'agents', agentId, 'wire.jsonl');
  if (!existsSync(wirePath)) return null;

  const parsed = parseWireJsonl(await readFile(wirePath, 'utf8'));
  const ctx = newContext(agentId, isRoot);
  scanPass(parsed.lines, ctx);

  const skipped = new Map<string, number>();
  const notices: IrNotice[] = [];
  const events: IrEvent[] = [];
  const uuidTurn = new Map<string, number>();
  let index = 0;
  let droppedUndone = 0;

  const turnOf = (line: KimiWireLine): number | undefined => {
    if (line.type === 'context.append_message') {
      const msg = (line.message ?? {}) as Record<string, unknown>;
      return typeof msg.id === 'string' ? ctx.promptTurn.get(msg.id) : undefined;
    }
    if (line.type === 'context.append_loop_event') {
      const ev = (line.event ?? {}) as KimiLoopEvent;
      if (typeof ev.turnId === 'number') return ev.turnId;
      if (typeof ev.turnId === 'string') {
        const n = Number(ev.turnId);
        if (Number.isFinite(n)) return n;
      }
      if (typeof ev.parentUuid === 'string') return uuidTurn.get(ev.parentUuid);
      return undefined;
    }
    if (typeof line.turnId === 'number') return line.turnId;
    return undefined;
  };

  for (const line of parsed.lines) {
    const type = line.type ?? '';

    if (type === 'context.append_loop_event') {
      const ev = (line.event ?? {}) as KimiLoopEvent;
      const t = turnOf(line);
      if (typeof ev.uuid === 'string' && t !== undefined) uuidTurn.set(ev.uuid, t);
    }

    if (type === 'agent.message.appended') {
      bump(ctx, 'uiMirror');
      continue;
    }
    if (type === 'turn.prompt') {
      bump(ctx, 'promptEcho');
      continue;
    }

    const turnId = turnOf(line);
    if (opts.dropUndoneTurns && turnId !== undefined && ctx.undoneTurns.has(turnId)) {
      droppedUndone += 1;
      continue;
    }

    if (RUNTIME_EVENT_TYPES.has(type)) {
      bump(ctx, 'runtime');
      continue;
    }

    const mapped = mapWireLine(line, skipped);
    if (mapped.length === 0) {
      if (type && !type.startsWith('context.')) bump(ctx, 'unknown:' + type);
      continue;
    }
    for (const ev of mapped) {
      index += 1;
      ev.id = agentId + ':e' + String(index).padStart(6, '0');
      ev.parentId = events.length > 0 ? events[events.length - 1]!.id : null;
      events.push(ev);
    }
  }

  if (droppedUndone > 0) {
    notices.push({
      code: 'kimi.undone-turns-dropped',
      message: '源端 undo 回滚的轮次已从 IR 裁掉（保留回滚边界事件）',
      count: droppedUndone,
      severity: 'info',
    });
  }
  if (parsed.badLines > 0) {
    notices.push({
      code: 'kimi.bad-wire-lines',
      message: agentId + '/wire.jsonl 有无法解析的行',
      count: parsed.badLines,
      severity: 'warning',
    });
  }

  const uiMirror = ctx.counters.get('uiMirror') ?? 0;
  if (uiMirror > 0) {
    notices.push({
      code: 'kimi.ui-mirror-dropped',
      message: 'agent.message.appended 是 UI 层消息镜像，与 context 事件流重复，已跳过',
      count: uiMirror,
      severity: 'info',
    });
  }
  const promptEcho = ctx.counters.get('promptEcho') ?? 0;
  if (promptEcho > 0) {
    notices.push({
      code: 'kimi.prompt-echo-dropped',
      message: 'turn.prompt 与 context.append_message 重复，已跳过',
      count: promptEcho,
      severity: 'info',
    });
  }
  let runtime = ctx.counters.get('runtime') ?? 0;
  for (const n of skipped.values()) runtime += n;
  if (runtime > 0) {
    notices.push({
      code: 'kimi.runtime-events-dropped',
      message: '运行时/配置/用量/步骤事件不属于对话内容，已跳过',
      count: runtime,
      severity: 'info',
    });
  }
  for (const [key, n] of ctx.counters) {
    if (!key.startsWith('unknown:')) continue;
    notices.push({
      code: 'kimi.unknown-event',
      message: '未识别的 wire 事件类型 ' + key.slice('unknown:'.length),
      count: n,
      severity: 'warning',
    });
  }

  const source: SourceFingerprint = {
    agent: 'kimi-code',
    nativeSessionId: state.id,
    nativePath: dir,
  };
  if (manifest?.kimiCodeVersion) source.cliVersion = manifest.kimiCodeVersion;
  if (typeof state.version === 'number') source.formatVersion = String(state.version);
  const protocol = ctx.protocolVersion ?? manifest?.wireProtocolVersion;
  if (protocol) source.protocolVersion = protocol;

  const label = agents[agentId]?.labels?.profileName;
  const meta: IrSession['meta'] = {
    cwd: state.cwd,
    title: isRoot ? state.title : label,
    createdAt: msToIso(isRoot ? state.createdAt : ctx.firstAt),
    updatedAt: msToIso(isRoot ? state.updatedAt : ctx.lastAt),
    model: ctx.model,
    profile: ctx.profile ?? label,
    archived: state.archived,
    lastPrompt: isRoot ? state.lastPrompt : undefined,
  };

  const session: IrSession = {
    id: isRoot ? 'kimi:' + state.id : 'kimi:' + state.id + '/' + agentId,
    source,
    meta,
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };
  return { session, ctx };
}

/**
 * 读取 Kimi Code 会话 bundle。
 *
 * 支持两种输入（结构一致）：
 * - kimi export 产出的 ZIP 解开的目录（多一个 manifest.json）
 * - ~/.kimi-code/sessions/<wd>/session_<uuid> 原生目录
 */
export async function readKimiBundle(bundleDir: string, options: ReadKimiOptions = {}): Promise<IrBundle> {
  const dir = resolve(bundleDir);
  const statePath = join(dir, 'state.json');
  if (!existsSync(statePath)) throw new Error('不是 Kimi 会话目录（缺 state.json）: ' + dir);

  const opts: Required<ReadKimiOptions> = { dropUndoneTurns: options.dropUndoneTurns ?? true };
  const state = JSON.parse(await readFile(statePath, 'utf8')) as KimiState;
  const manifestPath = join(dir, 'manifest.json');
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(await readFile(manifestPath, 'utf8')) as KimiManifest)
    : undefined;

  const agents = state.agents ?? {};
  const agentIds = Object.keys(agents);
  if (agentIds.length === 0) throw new Error('state.json 里没有 agents');
  const rootId = agentIds.find((id) => agents[id]?.type === 'main') ?? (agentIds.includes('main') ? 'main' : agentIds[0]!);

  const rootResult = await readAgent(dir, state, manifest, agents, rootId, true, opts);
  if (!rootResult) throw new Error('找不到主 agent 的 wire.jsonl: ' + rootId);

  if (manifest?.kimiCodeVersion !== undefined) {
    rootResult.session.notices.unshift({
      code: 'kimi.version-ambiguous',
      message:
        '版本口径不唯一：bundle manifest 记 ' +
        String(manifest.kimiCodeVersion) +
        '，会话格式 version=' +
        String(state.version) +
        '，wire protocol=' +
        String(manifest.wireProtocolVersion ?? '?') +
        '；CLI 版本需另行探测',
      severity: 'info',
    });
  }

  const children: IrChildSession[] = [];
  for (const agentId of agentIds) {
    if (agentId === rootId) continue;
    const result = await readAgent(dir, state, manifest, agents, agentId, false, opts);
    if (!result) {
      rootResult.session.notices.push({
        code: 'kimi.missing-subagent-wire',
        message: '子代理 ' + agentId + ' 没有 wire.jsonl',
        severity: 'warning',
      });
      continue;
    }
    children.push({
      session: result.session,
      parentSessionId: rootResult.session.id,
      viaToolCallId: rootResult.ctx.subagentSpawn.get(agentId)?.parentToolCallId,
      label: agents[agentId]?.labels?.profileName,
    });
  }

  return {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: rootResult.session,
    children,
  };
}

/** 粗略统计，供 CLI 打印 */
export function summarizeBundle(bundle: IrBundle): string {
  const lines = [
    'root ' + bundle.root.id + '  events=' + bundle.root.events.length + '  cwd=' + (bundle.root.meta.cwd ?? '?'),
    '  title=' + (bundle.root.meta.title ?? '(none)') + '  model=' + (bundle.root.meta.model ?? '?'),
  ];
  for (const child of bundle.children) {
    lines.push(
      'child ' + child.session.id + '  events=' + child.session.events.length +
      '  label=' + (child.label ?? '?') + '  via=' + (child.viaToolCallId ?? '?'),
    );
  }
  lines.push('total events=' + bundleEventCount(bundle));
  return lines.join('\n');
}
