import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { verifyCommandCodeSession, writeCommandCodeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-cc-injected-project';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({
    ...event,
    parentId: index === 0 ? null : (events[index - 1] as { id: string }).id,
  })) as IrEvent[];
}

function makeBundle(): IrBundle {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '真实用户消息' }] },
    { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'user', parts: [{ type: 'text', text: 'Current runtime context. 运行时注入' }], synthetic: true },
    { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02Z', role: 'assistant', parts: [{ type: 'text', text: '回复' }] },
  ] as Array<Omit<IrEvent, 'parentId'>>);
  return {
    irVersion: IR_VERSION,
    createdAt: new Date(0).toISOString(),
    root: {
      id: 'ir_injected',
      source: { agent: 'dsh' },
      meta: { cwd: TEST_CWD, title: '注入消息测试' },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
}

test('默认丢弃 synthetic 用户消息并计入损失，keepInjected 可保留', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-home-'));
  try {
    const dropped = await writeCommandCodeSession(makeBundle(), { home, cwd: TEST_CWD, id: 'dddddddd-4444-4444-8444-444444444444' });
    assert.ok(dropped.losses.some((l) => l.code === 'command-code.injected-message-dropped'));
    const kept = await writeCommandCodeSession(makeBundle(), { home, cwd: TEST_CWD, id: 'eeeeeeee-5555-4555-8555-555555555555', keepInjected: true });
    assert.ok(!kept.losses.some((l) => l.code === 'command-code.injected-message-dropped'));
    assert.equal(kept.rows.length, dropped.rows.length + 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('verify 容忍目标 app 续写产生的悬空 parentId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-home-'));
  try {
    const id = 'ffffffff-6666-4666-8666-666666666666';
    const report = await writeCommandCodeSession(makeBundle(), { home, cwd: TEST_CWD, id });
    const clean = await verifyCommandCodeSession({ filePath: report.filePath });
    assert.equal(clean.ok, true, JSON.stringify(clean.checks));
    const chainCheck = clean.checks.find((c) => c.name === 'parent-chain');
    assert.ok(chainCheck && chainCheck.detail && !chainCheck.detail.includes('悬空'));

    // 模拟 resume 之后 app 追加：parentId 指向文件里不存在的 id
    appendFileSync(
      report.filePath,
      JSON.stringify({
        type: 'message',
        id: 'appended0001',
        parentId: 'missing-record-id',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '续写' }],
          meta: { source: 'model', messageId: 'appended-msg-0001', createdAt: Date.now() },
        },
      }) + '\n',
    );
    const after = await verifyCommandCodeSession({ filePath: report.filePath });
    assert.equal(after.ok, true, JSON.stringify(after.checks));
    const afterCheck = after.checks.find((c) => c.name === 'parent-chain');
    assert.ok(afterCheck && afterCheck.detail && afterCheck.detail.includes('悬空'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});