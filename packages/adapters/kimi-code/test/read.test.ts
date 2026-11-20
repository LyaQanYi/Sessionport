import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import { readKimiBundle } from '../src/index.ts';

const BUNDLE = process.env.SESSIONPORT_KIMI_BUNDLE
  ? resolve(process.env.SESSIONPORT_KIMI_BUNDLE)
  : resolve(import.meta.dirname, '../../../../session_fdefc84f-470a-421f-a62e-5ad404eceb82');

const hasBundle = existsSync(BUNDLE);

test('读取真实 Kimi bundle 的结构与统计', { skip: hasBundle ? false : '缺少本地真实 bundle（含隐私，未入库）' }, async () => {
  const bundle = await readKimiBundle(BUNDLE);
  assert.equal(bundle.irVersion, '0.1');
  assert.equal(bundle.root.source.agent, 'kimi-code');
  assert.match(bundle.root.meta.cwd ?? '', /^\/Users\/.+/u);
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

test('fixture: Kimi 2.6.x 运行时事件与 turn.steer 归入 info，不误报 unknown-event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-kimi-26-'));
  try {
    mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        id: 'session_kimi26_fixture',
        version: 2,
        cwd: '/tmp/kimi-26',
        title: 'Kimi 2.6 fixture',
        createdAt: 1795000000000,
        updatedAt: 1795000010000,
        agents: { main: { type: 'main', homedir: join(dir, 'agents', 'main') } },
      }),
      'utf8',
    );
    const wire = [
      { type: 'metadata', protocol_version: '1.5', time: 1795000000000 },
      { type: 'environment.set_binding', environmentId: 'env_1', agentId: 'main', time: 1795000000100 },
      { type: 'tool_select.initialized', agentId: 'main', tools: [], time: 1795000000200 },
      { type: 'tools.update_store', agentId: 'main', key: 'k', value: [], time: 1795000000250 },
      { type: 'changeNotifier.snapshot', agentId: 'main', time: 1795000000300 },
      { type: 'turn.prompt', promptId: 'msg_1', turnId: 1, time: 1795000001000 },
      { type: 'context.append_message', message: { id: 'msg_1', role: 'user', content: [{ type: 'text', text: '查一下状态' }] }, time: 1795000001001 },
      { type: 'permission.record_approval_result', turnId: 1, toolCallId: 'tc_1', toolName: 'shell', result: { decision: 'allow' }, time: 1795000001500 },
      { type: 'task.started', agentId: 'main', info: { taskId: 't_1' }, time: 1795000001600 },
      { type: 'task.terminated', agentId: 'main', info: { taskId: 't_1' }, time: 1795000001700 },
      { type: 'task.waitDelivered', agentId: 'main', keys: ['t_1'], time: 1795000001800 },
      { type: 'turn.step.retrying', agentId: 'main', turnId: 1, step: 1, time: 1795000001900 },
      { type: 'context.append_message', message: { id: 'msg_steer', role: 'user', content: [{ type: 'text', text: '顺便看日志' }] }, time: 1795000002000 },
      { type: 'turn.steer', agentId: 'main', messageId: 'msg_steer', turnId: 1, input: [{ type: 'text', text: '顺便看日志' }], time: 1795000002001 },
      { type: 'context.append_loop_event', event: { type: 'content.part', turnId: 1, part: { type: 'text', text: '已完成检查' } }, time: 1795000003000 },
    ];
    writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), wire.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');

    const bundle = await readKimiBundle(dir);
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.events.length, 3);
    assert.equal(bundle.root.source.formatVersion, '2');
    assert.equal(bundle.root.source.protocolVersion, '1.5');
    assert.equal(bundle.root.notices.filter((n) => n.code === 'kimi.unknown-event').length, 0);
    const echo = bundle.root.notices.find((n) => n.code === 'kimi.prompt-echo-dropped');
    assert.equal(echo?.severity, 'info');
    assert.equal(echo?.count, 2);
    const runtime = bundle.root.notices.find((n) => n.code === 'kimi.runtime-events-dropped');
    assert.equal(runtime?.severity, 'info');
    assert.equal(runtime?.count, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
