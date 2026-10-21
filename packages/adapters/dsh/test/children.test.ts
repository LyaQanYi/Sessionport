import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { readDshSession, readZstdHeaderLine, writeDshSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-dsh-children';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({
    ...event,
    parentId: index === 0 ? null : (events[index - 1] as { id: string }).id,
  })) as IrEvent[];
}

function session(id: string, text: string) {
  const events = chain([
    { kind: 'message', id: id + '-e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text }] },
    { kind: 'message', id: id + '-e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
  ] as Array<Omit<IrEvent, 'parentId'>>);
  return {
    id,
    source: { agent: 'kimi-code' as const, nativeSessionId: id },
    meta: { cwd: TEST_CWD, title: text },
    events,
    head: events[events.length - 1]!.id,
    notices: [],
  };
}

function makeBundle(): IrBundle {
  const root = session('root-1', '主会话');
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root,
    children: [
      { session: session('session_11111111-1111-4111-8111-111111111111', '子代理 A'), parentSessionId: root.id, label: 'explore' },
      { session: session('session_22222222-2222-4222-8222-222222222222', '子代理 B'), parentSessionId: root.id, label: 'implement' },
    ],
  };
}

test('includeChildren：子代理写成独立会话，header 带 parentSession/delegationDepth/origin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-dsh-children-'));
  try {
    const report = await writeDshSession(makeBundle(), {
      home,
      cwd: TEST_CWD,
      id: 'session-aaaaaaaa-1111-4111-8111-111111111111',
      includeChildren: true,
    });
    assert.equal(report.children.length, 2);
    assert.ok(!report.losses.some((l) => l.code === 'dsh.subagent-dropped'));

    // Kimi 的 session_<uuid> 会被归一化成裸 uuid
    const ids = report.children.map((child) => child.sessionId).sort();
    assert.deepEqual(ids, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);

    for (const child of report.children) {
      assert.ok(existsSync(child.filePath));
      const header = JSON.parse(await readZstdHeaderLine(child.filePath));
      assert.equal(header.parentSession, 'session-aaaaaaaa-1111-4111-8111-111111111111');
      assert.equal(header.delegationDepth, 1);
      assert.equal(header.origin, 'subagent');
      assert.equal(header.id, child.sessionId);
    }

    const back = await readDshSession('session-aaaaaaaa-1111-4111-8111-111111111111', { home });
    assert.equal(back.children.length, 2);
    assert.deepEqual(
      back.children.map((child) => child.session.meta.title).sort(),
      ['子代理 A', '子代理 B'],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('includeChildren=false 时子代理记入损失清单', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-dsh-children-'));
  try {
    const report = await writeDshSession(makeBundle(), {
      home,
      cwd: TEST_CWD,
      id: 'session-bbbbbbbb-2222-4222-8222-222222222222',
    });
    assert.equal(report.children.length, 0);
    const loss = report.losses.find((l) => l.code === 'dsh.subagent-dropped');
    assert.ok(loss);
    assert.equal(loss.count, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
