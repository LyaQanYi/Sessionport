import { createHash } from 'node:crypto';

import { IR_VERSION, validateIrBundle } from './ir.ts';
import type { AgentId, IrBoundaryEvent, IrBundle, IrEvent, IrSession } from './ir.ts';
import { LossCollector } from './loss.ts';
import type { LossEntry } from './loss.ts';
import type { ExternalRef } from './registry.ts';
import { normalizeToolCall } from './tools.ts';
import type { ToolRenderTarget } from './tools.ts';

export type MergeAnchorMode = 'ref-index' | 'ref-head-scan' | 'fingerprint-fallback';

export type MergeBackDecision =
  | { kind: 'no-ref'; reason: string }
  | { kind: 'source-read-only'; agent: AgentId; ref: ExternalRef }
  | { kind: 'unanchored'; reason: string; ref: ExternalRef }
  | { kind: 'up-to-date'; ref: ExternalRef; anchorMode: MergeAnchorMode }
  | {
      kind: 'fast-forward';
      ref: ExternalRef;
      deltaEvents: IrEvent[];
      anchorMode: MergeAnchorMode;
      sourceDelta: 0;
    }
  | {
      kind: 'both-changed';
      ref: ExternalRef;
      deltaEvents: IrEvent[];
      anchorMode: MergeAnchorMode;
      sourceDelta: number;
    };

export type DeltaExtractionResult =
  | { ok: true; anchorMode: MergeAnchorMode; deltaEvents: IrEvent[] }
  | { ok: false; reason: string };

const TOOL_TARGETS = new Set<ToolRenderTarget>([
  'claude-code',
  'codex',
  'opencode',
  'command-code',
  'qoder',
]);

function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalSort(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalSort(child);
    }
    return out;
  }
  return value;
}

/** 计算事件语义内容指纹（剔除 id / parentId / _native / 毫秒抖动），用于跨读写锚点识别 */
export function eventFingerprint(event: IrEvent | undefined): string | null {
  if (event === undefined) return null;
  let canonical: unknown;
  switch (event.kind) {
    case 'message':
      canonical = {
        kind: 'message',
        role: event.role,
        synthetic: Boolean(event.synthetic),
        parts: event.parts,
      };
      break;
    case 'reasoning':
      canonical = {
        kind: 'reasoning',
        reasoning:
          event.reasoning.kind === 'plain'
            ? { kind: 'plain', text: event.reasoning.text }
            : { kind: 'opaque', format: event.reasoning.format ?? null, payload: event.reasoning.payload },
      };
      break;
    case 'tool_call':
      canonical = {
        kind: 'tool_call',
        callId: event.callId,
        name: event.name,
        input: event.input,
      };
      break;
    case 'tool_result':
      canonical = {
        kind: 'tool_result',
        callId: event.callId,
        isError: Boolean(event.isError),
        content: event.content,
      };
      break;
    case 'boundary':
      canonical = {
        kind: 'boundary',
        boundary: event.boundary,
        detail: event.detail ?? null,
      };
      break;
  }
  const encoded = JSON.stringify(canonicalSort(canonical));
  return createHash('sha256').update(encoded).digest('hex').slice(0, 16);
}

function anchorMatches(
  candidate: IrEvent | undefined,
  headId: string | null | undefined,
  headHash: string | null | undefined,
): boolean {
  if (candidate === undefined) return false;
  if (headId !== undefined && headId !== null && candidate.id === headId) return true;
  if (headHash !== undefined && headHash !== null && eventFingerprint(candidate) === headHash) return true;
  return false;
}

function isFingerprintCandidate(event: IrEvent): boolean {
  if (event.kind === 'message') return event.synthetic !== true;
  return event.kind === 'tool_call' || event.kind === 'tool_result';
}

export function extractTargetDelta(input: {
  source: IrSession;
  target: IrSession;
  ref: ExternalRef;
}): DeltaExtractionResult {
  const { source, target, ref } = input;

  // 1. 首选快速路径：按同步时记录的目标端 IR 事件总数 + 链尾 id/哈希锚定
  if (ref.targetIrEvents !== undefined) {
    if (ref.targetIrEvents === 0) {
      return { ok: true, anchorMode: 'ref-index', deltaEvents: [...target.events] };
    }
    if (target.events.length >= ref.targetIrEvents) {
      const candidate = target.events[ref.targetIrEvents - 1];
      if (anchorMatches(candidate, ref.targetIrHead, ref.targetIrHeadHash)) {
        return {
          ok: true,
          anchorMode: 'ref-index',
          deltaEvents: target.events.slice(ref.targetIrEvents),
        };
      }
    }
  }

  // 2. 次选扫描：target 前端行数可能被清洗/折叠，从尾部反扫 targetIrHead 或 targetIrHeadHash
  if ((ref.targetIrHead !== undefined && ref.targetIrHead !== null) || (ref.targetIrHeadHash !== undefined && ref.targetIrHeadHash !== null)) {
    for (let k = target.events.length - 1; k >= 0; k -= 1) {
      if (anchorMatches(target.events[k], ref.targetIrHead, ref.targetIrHeadHash)) {
        return {
          ok: true,
          anchorMode: 'ref-head-scan',
          deltaEvents: target.events.slice(k + 1),
        };
      }
    }
  }

  // 3. 兼容兜底：针对 Route A 之前旧 registry（无 targetIrEvents），在源前 ref.sourceEvents 内找最后一条实义事件并按内容指纹在 target 中定位
  if (ref.targetIrEvents === undefined) {
    const prefixEnd = Math.min(Math.max(0, ref.sourceEvents), source.events.length);
    for (let s = prefixEnd - 1; s >= 0; s -= 1) {
      const srcEvent = source.events[s]!;
      if (!isFingerprintCandidate(srcEvent)) continue;
      const fp = eventFingerprint(srcEvent);
      if (fp === null) continue;
      for (let k = target.events.length - 1; k >= 0; k -= 1) {
        if (eventFingerprint(target.events[k]) === fp) {
          return {
            ok: true,
            anchorMode: 'fingerprint-fallback',
            deltaEvents: target.events.slice(k + 1),
          };
        }
      }
    }
  }

  return {
    ok: false,
    reason: '无法在目标会话里定位上次同步后的共同祖先锚点（目标历史可能已被重写或截断）',
  };
}

export function planMergeBack(input: {
  ref: ExternalRef | undefined;
  source: IrSession;
  target: IrSession;
  sourceWritable: boolean;
}): MergeBackDecision {
  const { ref, source, target, sourceWritable } = input;
  if (ref === undefined) {
    return { kind: 'no-ref', reason: 'registry 里没有该源会话与目标端的同步记录，请先 sync 或 push' };
  }
  if (!sourceWritable) {
    return { kind: 'source-read-only', agent: source.source.agent, ref };
  }
  const extracted = extractTargetDelta({ source, target, ref });
  if (!extracted.ok) {
    return { kind: 'unanchored', reason: extracted.reason, ref };
  }
  if (extracted.deltaEvents.length === 0) {
    return { kind: 'up-to-date', ref, anchorMode: extracted.anchorMode };
  }
  const sourceDelta = source.events.length - ref.sourceEvents;
  if (source.head === ref.sourceHead && sourceDelta === 0) {
    return {
      kind: 'fast-forward',
      ref,
      deltaEvents: extracted.deltaEvents,
      anchorMode: extracted.anchorMode,
      sourceDelta: 0,
    };
  }
  return {
    kind: 'both-changed',
    ref,
    deltaEvents: extracted.deltaEvents,
    anchorMode: extracted.anchorMode,
    sourceDelta,
  };
}

export function describeMergeBackDecision(decision: MergeBackDecision): string {
  switch (decision.kind) {
    case 'no-ref':
      return decision.reason;
    case 'source-read-only':
      return '源 harness ' + decision.agent + ' 目前是只读，不支持合并回写';
    case 'unanchored':
      return decision.reason;
    case 'up-to-date':
      return '目标端没有新对话，无需 merge-back（anchor=' + decision.anchorMode + '）';
    case 'fast-forward':
      return (
        '可快进回写：目标端新增 ' +
        decision.deltaEvents.length +
        ' 个事件，源端同步后无分叉（anchor=' +
        decision.anchorMode +
        '）'
      );
    case 'both-changed':
      return (
        '双方均已前进：目标端新增 ' +
        decision.deltaEvents.length +
        ' 个事件，源端也变化了 ' +
        (decision.sourceDelta >= 0 ? '+' + decision.sourceDelta : String(decision.sourceDelta)) +
        ' 个事件（需 --append-diverged 明确追加）'
      );
  }
}

function lossPrefixFor(agent: AgentId): string {
  return agent === 'claude-code' ? 'claude' : agent;
}

function nextUniqueId(usedIds: Set<string>, counter: { next: number }): string {
  while (true) {
    const candidate = 'mb_' + String(counter.next);
    counter.next += 1;
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
  }
}

export interface BuildMergeBundlesResult {
  deltaBundle: IrBundle;
  mergedBundle: IrBundle;
  losses: LossEntry[];
}

export function buildDeltaAndMergedBundles(input: {
  sourceBundle: IrBundle;
  targetAgent: AgentId;
  targetId: string;
  deltaEvents: IrEvent[];
  normalizeTools?: boolean;
  includeDivergedBoundary?: boolean;
}): BuildMergeBundlesResult {
  const {
    sourceBundle,
    targetAgent,
    targetId,
    deltaEvents,
    normalizeTools = true,
    includeDivergedBoundary = false,
  } = input;

  const clonedSource = structuredClone(sourceBundle);
  const usedIds = new Set<string>(clonedSource.root.events.map((event) => event.id));
  const idCounter = { next: 1 };
  const losses = new LossCollector();
  const sourceAgent = clonedSource.root.source.agent;
  const renderTarget = TOOL_TARGETS.has(sourceAgent as ToolRenderTarget)
    ? (sourceAgent as ToolRenderTarget)
    : undefined;
  const prefix = lossPrefixFor(sourceAgent);

  const rawDelta: IrEvent[] = [];
  if (includeDivergedBoundary) {
    const boundaryEvent: IrBoundaryEvent = {
      kind: 'boundary',
      id: '',
      parentId: null,
      at: deltaEvents[0]?.at ?? new Date().toISOString(),
      boundary: 'fork',
      detail: 'merged-back from ' + targetAgent + ':' + targetId,
    };
    rawDelta.push(boundaryEvent);
  }

  for (const original of deltaEvents) {
    const cloned = structuredClone(original);
    // 剔除源目标原生负载，避免跨 harness 时被按旧格式直写
    delete cloned._native;
    if (
      cloned.kind === 'tool_call' &&
      normalizeTools !== false &&
      renderTarget !== undefined &&
      sourceAgent !== targetAgent
    ) {
      const normalized = normalizeToolCall({
        target: renderTarget,
        sourceAgent: targetAgent,
        name: cloned.name,
        input: cloned.input,
        enabled: normalizeTools,
      });
      if (normalized.status === 'normalized') {
        losses.add(prefix + '.tool-normalized', '已将回写增量中的跨源工具调用归一化为目标端原生工具', {
          severity: 'info',
        });
        cloned.name = normalized.name;
        cloned.input = normalized.input;
      } else if (normalized.status === 'unmapped') {
        losses.add(prefix + '.tool-unmapped', '回写增量中有工具无法映射到目标原生工具，已保留源端名称', {
          severity: 'info',
        });
      }
    }
    rawDelta.push(cloned);
  }

  const deltaChain: IrEvent[] = [];
  const mergedDeltaChain: IrEvent[] = [];
  let deltaParent: string | null = null;
  let mergedParent: string | null = clonedSource.root.head;

  for (const event of rawDelta) {
    const id = nextUniqueId(usedIds, idCounter);
    const deltaItem: IrEvent = { ...event, id, parentId: deltaParent };
    const mergedItem: IrEvent = { ...structuredClone(event), id, parentId: mergedParent };
    deltaChain.push(deltaItem);
    mergedDeltaChain.push(mergedItem);
    deltaParent = id;
    mergedParent = id;
  }

  const lastAt = rawDelta[rawDelta.length - 1]?.at ?? clonedSource.root.meta.updatedAt ?? new Date().toISOString();
  const deltaBundle: IrBundle = {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: clonedSource.root.id + '_merge_delta',
      source: {
        agent: sourceAgent,
        ...(clonedSource.root.source.nativeSessionId !== undefined
          ? { nativeSessionId: clonedSource.root.source.nativeSessionId }
          : {}),
        ...(clonedSource.root.source.nativePath !== undefined
          ? { nativePath: clonedSource.root.source.nativePath }
          : {}),
      },
      meta: {
        ...structuredClone(clonedSource.root.meta),
        updatedAt: lastAt,
      },
      events: deltaChain,
      head: deltaParent,
      notices: [],
    },
    children: [],
  };

  clonedSource.root.events = [...clonedSource.root.events, ...mergedDeltaChain];
  clonedSource.root.head = mergedParent;
  clonedSource.root.meta.updatedAt = lastAt;

  const errors = validateIrBundle(clonedSource);
  if (errors.length > 0) {
    throw new Error('合并后的 IR 校验失败: ' + errors.join('; '));
  }

  return {
    deltaBundle,
    mergedBundle: clonedSource,
    losses: losses.sorted(),
  };
}
