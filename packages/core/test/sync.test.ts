import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyRegistry, findRef, loadRegistry, planSync, removeRef, saveRegistry, sourceKeyOf, upsertRef } from '../src/index.ts';
import type { ExternalRef } from '../src/index.ts';

function ref(overrides: Partial<ExternalRef> = {}): ExternalRef {
  return {
    sourceKey: 'dsh:session-1',
    target: 'command-code',
    targetId: 'target-1',
    targetPath: '/tmp/target-1.jsonl',
    unit: 'rows',
    targetUnits: 10,
    sourceEvents: 5,
    sourceHead: 'e5',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

test('planSync: 没有登记 → fresh', () => {
  const decision = planSync({ ref: undefined, source: { head: 'e5', events: 5 }, target: { exists: true, units: 10 } });
  assert.equal(decision.kind, 'fresh');
});

test('planSync: 目标文件不存在 → fresh', () => {
  const decision = planSync({ ref: ref(), source: { head: 'e5', events: 5 }, target: { exists: false, units: 0 } });
  assert.equal(decision.kind, 'fresh');
});

test('planSync: 源与目标都没变 → up-to-date', () => {
  const decision = planSync({ ref: ref(), source: { head: 'e5', events: 5 }, target: { exists: true, units: 10 } });
  assert.equal(decision.kind, 'up-to-date');
});

test('planSync: 源增长、目标未变 → refresh', () => {
  const decision = planSync({ ref: ref(), source: { head: 'e9', events: 9 }, target: { exists: true, units: 10 } });
  assert.equal(decision.kind, 'refresh');
  if (decision.kind === 'refresh') {
    assert.equal(decision.sourceDelta, 4);
    assert.equal(decision.targetDelta, 0);
  }
});

test('planSync: 目标端新增 → diverged', () => {
  const decision = planSync({ ref: ref(), source: { head: 'e5', events: 5 }, target: { exists: true, units: 13 } });
  assert.equal(decision.kind, 'diverged');
  if (decision.kind === 'diverged') assert.equal(decision.targetExtra, 3);
});

test('planSync: 目标端被截断（少于上次）→ refresh 而不是 diverge', () => {
  const decision = planSync({ ref: ref(), source: { head: 'e5', events: 5 }, target: { exists: true, units: 4 } });
  assert.equal(decision.kind, 'refresh');
});

test('registry: 保存/读取/查找/更新/删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-state-'));
  try {
    const registry = emptyRegistry();
    assert.equal(findRef(registry, 'dsh:session-1', 'command-code'), undefined);
    upsertRef(registry, ref());
    upsertRef(registry, ref({ targetUnits: 12 }));
    assert.equal(registry.refs.length, 1, '同一 source+target 只保留一条');
    assert.equal(findRef(registry, 'dsh:session-1', 'command-code')?.targetUnits, 12);

    saveRegistry(registry, dir);
    const loaded = loadRegistry(dir);
    assert.equal(loaded.refs.length, 1);
    assert.equal(loaded.refs[0]!.targetId, 'target-1');

    assert.equal(removeRef(loaded, 'dsh:session-1', 'command-code'), true);
    assert.equal(loaded.refs.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sourceKeyOf: 优先用源端 nativeSessionId', () => {
  assert.equal(sourceKeyOf({ agent: 'dsh', nativeSessionId: 'session-x' }, 'ir-fallback'), 'dsh:session-x');
  assert.equal(sourceKeyOf({ agent: 'dsh' }, 'ir-fallback'), 'dsh:ir-fallback');
});
