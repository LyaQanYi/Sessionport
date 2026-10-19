import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { readKimiBundle } from '../src/index.ts';

const BUNDLE = process.env.SESSIONPORT_KIMI_BUNDLE
  ? resolve(process.env.SESSIONPORT_KIMI_BUNDLE)
  : resolve(import.meta.dirname, '../../../../session_fdefc84f-470a-421f-a62e-5ad404eceb82');

const hasBundle = existsSync(BUNDLE);

test('读取真实 Kimi bundle 的结构与统计', { skip: hasBundle ? false : '缺少本地真实 bundle（含隐私，未入库）' }, async () => {
  const bundle = await readKimiBundle(BUNDLE);
  assert.equal(bundle.irVersion, '0.1');
  assert.equal(bundle.root.source.agent, 'kimi-code');
  assert.equal(bundle.root.meta.cwd, '/Users/lyaqanyi');
  assert.equal(bundle.root.meta.title, '多平台会话同步工具查询');
  assert.equal(bundle.children.length, 1);
  assert.equal(bundle.children[0]!.label, 'explore');
  assert.ok(bundle.children[0]!.viaToolCallId && bundle.children[0]!.viaToolCallId.startsWith('tool_'));
  assert.equal(bundle.root.head, bundle.root.events.at(-1)!.id);

  // 事件链完整
  let prev: string | null = null;
  for (const event of bundle.root.events) {
    assert.equal(event.parentId, prev);
    prev = event.id;
  }

  // tool_call / tool_result 一一配对
  const calls = bundle.root.events.filter((e) => e.kind === 'tool_call');
  const results = bundle.root.events.filter((e) => e.kind === 'tool_result');
  assert.equal(calls.length, results.length);
  const callIds = new Set(calls.map((e) => (e as { callId: string }).callId));
  for (const r of results) assert.ok(callIds.has((r as { callId: string }).callId));

  // UI 镜像被跳过（否则消息会翻倍）
  assert.ok(bundle.root.notices.some((n) => n.code === 'kimi.ui-mirror-dropped'));
  assert.ok(!bundle.root.events.some((e) => e.kind === 'message' && JSON.stringify(e).includes('agent.message.appended')));
});

test('undo 回滚的轮次默认被裁掉，可关闭', { skip: hasBundle ? false : '缺少本地真实 bundle' }, async () => {
  const dropped = await readKimiBundle(BUNDLE, { dropUndoneTurns: true });
  const kept = await readKimiBundle(BUNDLE, { dropUndoneTurns: false });
  assert.ok(kept.root.events.length > dropped.root.events.length);
  const droppedBoundary = dropped.root.events.filter((e) => e.kind === 'boundary' && (e as { boundary: string }).boundary === 'undo');
  assert.equal(droppedBoundary.length, 1);
});

test('非 Kimi 目录会明确报错', async () => {
  await assert.rejects(() => readKimiBundle(resolve('/tmp')), /不是 Kimi 会话目录/);
});
