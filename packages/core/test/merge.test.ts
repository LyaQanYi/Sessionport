import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IR_VERSION,
  buildDeltaAndMergedBundles,
  describeMergeBackDecision,
  eventFingerprint,
  extractTargetDelta,
  planMergeBack,
  validateIrBundle,
} from '../src/index.ts';
import type { ExternalRef, IrBundle, IrEvent, IrSession } from '../src/index.ts';

function makeSession(agent: IrSession['source']['agent'], id: string, events: IrEvent[]): IrSession {
  return {
    id,
    source: { agent, nativeSessionId: id },
    meta: { cwd: '/tmp/merge-test', title: 'merge test' },
    events,
    head: events[events.length - 1]?.id ?? null,
    notices: [],
  };
}

function baseRef(overrides: Partial<ExternalRef> = {}): ExternalRef {
  return {
    sourceKey: 'claude-code:src-1',
    target: 'codex',
    targetId: 'tgt-1',
    targetPath: '/tmp/tgt.jsonl',
    unit: 'rows',
    targetUnits: 5,
    sourceEvents: 2,
    sourceHead: 's2',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sourceAgent: 'claude-code',
    targetIrEvents: 2,
    targetIrHead: 't2',
    targetIrHeadHash: 'dummy',
    ...overrides,
  };
}

const s1: IrEvent = { kind: 'message', id: 's1', parentId: null, at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
const s2: IrEvent = { kind: 'message', id: 's2', parentId: 's1', at: '2026-01-01T00:00:01.000Z', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] };
const t1: IrEvent = { ...s1, id: 't1', parentId: null };
const t2: IrEvent = { ...s2, id: 't2', parentId: 't1' };
const t3: IrEvent = { kind: 'tool_call', id: 't3', parentId: 't2', at: '2026-01-01T00:01:00.000Z', callId: 'c1', name: 'exec_command', input: { cmd: 'ls' } };
const t4: IrEvent = { kind: 'tool_result', id: 't4', parentId: 't3', at: '2026-01-01T00:01:01.000Z', callId: 'c1', content: [{ type: 'text', text: 'a.ts' }] };
const t5: IrEvent = { kind: 'message', id: 't5', parentId: 't4', at: '2026-01-01T00:01:02.000Z', role: 'assistant', parts: [{ type: 'text', text: 'done' }] };

test('merge: 覆盖 planMergeBack 六种决策、head 漂移扫描与旧 registry 指纹兜底', () => {
  const source = makeSession('claude-code', 'src-1', [s1, s2]);
  const targetSame = makeSession('codex', 'tgt-1', [t1, t2]);
  const targetGrown = makeSession('codex', 'tgt-1', [t1, t2, t3, t4, t5]);
  const ref = baseRef({ targetIrHeadHash: eventFingerprint(t2) });

  assert.equal(planMergeBack({ ref: undefined, source, target: targetGrown, sourceWritable: true }).kind, 'no-ref');
  assert.equal(planMergeBack({ ref, source, target: targetGrown, sourceWritable: false }).kind, 'source-read-only');
  assert.equal(planMergeBack({ ref, source, target: targetSame, sourceWritable: true }).kind, 'up-to-date');

  const ff = planMergeBack({ ref, source, target: targetGrown, sourceWritable: true });
  assert.equal(ff.kind, 'fast-forward');
  if (ff.kind === 'fast-forward') {
    assert.equal(ff.anchorMode, 'ref-index');
    assert.equal(ff.deltaEvents.length, 3);
    assert.match(describeMergeBackDecision(ff), /可快进回写/);
  }

  // index 偏移（前置多了一条注入消息）应落入 ref-head-scan
  const prepended: IrEvent = { kind: 'message', id: 't0', parentId: null, at: '2026-01-01T00:00:00.000Z', role: 'user', synthetic: true, parts: [{ type: 'text', text: 'meta' }] };
  const shiftedTarget = makeSession('codex', 'tgt-1', [
    prepended,
    { ...t1, id: 'x1', parentId: 't0' },
    { ...t2, id: 'x2', parentId: 'x1' },
    { ...t3, id: 'x3', parentId: 'x2' },
  ]);
  const shifted = extractTargetDelta({ source, target: shiftedTarget, ref });
  assert.equal(shifted.ok, true);
  if (shifted.ok) {
    assert.equal(shifted.anchorMode, 'ref-head-scan');
    assert.equal(shifted.deltaEvents.length, 1);
  }

  // 旧版 registry 无 targetIrEvents，走 fingerprint-fallback
  const legacyRef = baseRef({ targetIrEvents: undefined, targetIrHead: undefined, targetIrHeadHash: undefined });
  const legacy = extractTargetDelta({ source, target: targetGrown, ref: legacyRef });
  assert.equal(legacy.ok, true);
  if (legacy.ok) {
    assert.equal(legacy.anchorMode, 'fingerprint-fallback');
    assert.equal(legacy.deltaEvents.length, 3);
  }

  // 目标端找不到锚点 -> unanchored
  const unrelatedTarget = makeSession('codex', 'tgt-1', [
    { kind: 'message', id: 'u1', parentId: null, at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: 'other' }] },
  ]);
  assert.equal(planMergeBack({ ref, source, target: unrelatedTarget, sourceWritable: true }).kind, 'unanchored');

  // 源与目标都增长 -> both-changed
  const sourceGrown = makeSession('claude-code', 'src-1', [
    s1,
    s2,
    { kind: 'message', id: 's3', parentId: 's2', at: '2026-01-01T00:02:00.000Z', role: 'user', parts: [{ type: 'text', text: 'local' }] },
  ]);
  const both = planMergeBack({ ref, source: sourceGrown, target: targetGrown, sourceWritable: true });
  assert.equal(both.kind, 'both-changed');
  if (both.kind === 'both-changed') assert.equal(both.sourceDelta, 1);
});

test('merge: buildDeltaAndMergedBundles 归一工具、不撞 id、可选 fork 边界且 validateIrBundle 通过', () => {
  const sourceBundle: IrBundle = {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root: makeSession('claude-code', 'src-1', [s1, s2]),
    children: [],
  };
  const built = buildDeltaAndMergedBundles({
    sourceBundle,
    targetAgent: 'codex',
    targetId: 'tgt-1',
    deltaEvents: [t3, t4, t5],
    normalizeTools: true,
    includeDivergedBoundary: true,
  });

  assert.equal(validateIrBundle(built.deltaBundle).length, 0);
  assert.equal(validateIrBundle(built.mergedBundle).length, 0);
  assert.equal(built.deltaBundle.root.events[0]!.kind, 'boundary');
  const toolEvent = built.deltaBundle.root.events.find((e) => e.kind === 'tool_call');
  assert.equal(toolEvent?.kind === 'tool_call' ? toolEvent.name : undefined, 'Bash');
  assert.ok(built.losses.some((l) => l.code === 'claude.tool-normalized' && l.count === 1));
  assert.equal(built.mergedBundle.root.events.length, 6);
  assert.equal(built.mergedBundle.root.events[2]!.parentId, 's2');

  const raw = buildDeltaAndMergedBundles({
    sourceBundle,
    targetAgent: 'codex',
    targetId: 'tgt-1',
    deltaEvents: [t3],
    normalizeTools: false,
  });
  const rawTool = raw.deltaBundle.root.events.find((e) => e.kind === 'tool_call');
  assert.equal(rawTool?.kind === 'tool_call' ? rawTool.name : undefined, 'exec_command');
});
