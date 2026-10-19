import type { ExternalRef } from './registry.ts';

export interface SourceState {
  head: string | null;
  events: number;
}

export interface TargetState {
  exists: boolean;
  /** 与 ExternalRef.unit 对应的计数 */
  units: number;
}

export type SyncDecision =
  | { kind: 'fresh'; reason: string }
  | { kind: 'up-to-date'; ref: ExternalRef }
  | { kind: 'refresh'; ref: ExternalRef; sourceDelta: number; targetDelta: number }
  | { kind: 'diverged'; ref: ExternalRef; sourceDelta: number; targetExtra: number };

/**
 * 纯函数：根据「上次同步状态 + 当前源/目标状态」决定这次该怎么写。
 *
 * 规则（保守优先）：
 * - 没登记过 / 目标文件没了 → fresh（全新写入）
 * - 源 head 与目标行数都没变 → up-to-date（不写）
 * - 目标端比上次多（用户在目标 app 里继续聊过）→ diverged（默认拒绝，需 --force 或 --fork）
 * - 其余（源增长、源/目标被截断等）→ refresh（安全重写并更新登记）
 */
export function planSync(input: {
  ref: ExternalRef | undefined;
  source: SourceState;
  target: TargetState | undefined;
}): SyncDecision {
  const { ref, source, target } = input;
  if (ref === undefined || target === undefined || !target.exists) {
    return { kind: 'fresh', reason: ref === undefined ? '没有同步记录' : '目标端文件不存在' };
  }
  const sourceDelta = source.events - ref.sourceEvents;
  const targetDelta = target.units - ref.targetUnits;
  if (source.head === ref.sourceHead && targetDelta === 0) {
    return { kind: 'up-to-date', ref };
  }
  if (targetDelta > 0) {
    return { kind: 'diverged', ref, sourceDelta, targetExtra: targetDelta };
  }
  return { kind: 'refresh', ref, sourceDelta, targetDelta };
}

export function describeDecision(decision: SyncDecision): string {
  switch (decision.kind) {
    case 'fresh':
      return '全新写入（' + decision.reason + '）';
    case 'up-to-date':
      return '已是最新，源端与目标端都没有变化';
    case 'refresh':
      return '安全重写：源端变化 ' + sign(decision.sourceDelta) + ' 事件，目标端变化 ' + sign(decision.targetDelta) + ' 单位';
    case 'diverged':
      return '目标端已新增 ' + decision.targetExtra + ' 单位（可能是你在目标 app 里继续聊过），源端变化 ' + sign(decision.sourceDelta) + ' 事件';
  }
}

function sign(n: number): string {
  return n >= 0 ? '+' + n : String(n);
}
