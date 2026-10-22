import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IR_VERSION, bundleEventCount, contentToText, eventKindCounts, validateIrBundle } from '../src/index.ts';
import type { IrBundle, IrEvent, IrEventDraft } from '../src/index.ts';

function bundleWith(events: IrEvent[]): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: new Date(0).toISOString(),
    root: {
      id: 'ir_test',
      source: { agent: 'kimi-code' },
      meta: { cwd: '/tmp/x' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: [],
  };
}

function chain(events: IrEventDraft[]): IrEvent[] {
  return events.map((e, i) => ({ ...e, parentId: i === 0 ? null : events[i - 1]!.id })) as IrEvent[];
}

test('空会话是合法的', () => {
  const errors = validateIrBundle(bundleWith([]));
  assert.deepEqual(errors, []);
});

test('链断裂会被校验出来', () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: 'hey' }] },
  ] as IrEventDraft[]);
  const bundle = bundleWith(events);
  assert.deepEqual(validateIrBundle(bundle), []);
  events[1]!.parentId = 'nope';
  const errors = validateIrBundle(bundle);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /parentId/);
});

test('head 与链尾不一致会被校验出来', () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  ] as IrEventDraft[]);
  const bundle = bundleWith(events);
  bundle.root.head = 'e1';
  assert.deepEqual(validateIrBundle(bundle), []);
  bundle.root.head = 'e2';
  assert.equal(validateIrBundle(bundle).length, 1);
});

test('事件统计与内容抽取', () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'a' }] },
    { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01Z', callId: 'c1', name: 'Bash', input: {} },
    { kind: 'tool_result', id: 'e3', at: '2026-01-01T00:00:02Z', callId: 'c1', content: [{ type: 'text', text: 'out' }] },
    { kind: 'reasoning', id: 'e4', at: '2026-01-01T00:00:03Z', reasoning: { kind: 'plain', text: 'think' } },
  ] as IrEventDraft[]);
  const bundle = bundleWith(events);
  assert.equal(bundleEventCount(bundle), 4);
  assert.deepEqual(eventKindCounts(bundle.root), { message: 1, tool_call: 1, tool_result: 1, reasoning: 1 });
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'json', value: { b: 1 } }]), 'a\n{"b":1}');
});
