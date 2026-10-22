import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';
import { readCommandCodeSession, writeCommandCodeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-cc-children';

function chain(events: Array<IrEventDraft>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function makeSession(id: string, text: string) {
  const events = chain([
    { kind: 'message', id: id + '-e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text }] },
    { kind: 'message', id: id + '-e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
  ] as Array<IrEventDraft>);
  return { id, source: { agent: 'dsh' as const, nativeSessionId: id }, meta: { cwd: TEST_CWD, title: text }, events, head: events[events.length - 1]!.id, notices: [] };
}

function makeBundle(): IrBundle {
  const root = makeSession('root-1', '主会话');
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root,
    children: [
      { session: makeSession('11111111-1111-4111-8111-111111111111', '子代理 A'), parentSessionId: root.id, label: 'explore' },
      { session: makeSession('session_22222222-2222-4222-8222-222222222222', '子代理 B'), parentSessionId: root.id, label: 'implement' },
    ],
  };
}

test('includeChildren：子代理各写一份独立 transcript（无原生父子概念）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-children-'));
  try {
    const report = await writeCommandCodeSession(makeBundle(), {
      home,
      cwd: TEST_CWD,
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      includeChildren: true,
      title: '父会话',
    });
    assert.equal(report.children.length, 2);
    const ids = report.children.map((c) => c.sessionId).sort();
    assert.deepEqual(ids, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    for (const child of report.children) {
      assert.ok(existsSync(child.filePath));
      const back = await readCommandCodeSession(child.filePath);
      assert.ok(back.root.events.length > 0);
      assert.match(back.root.meta.title ?? '', /^子代理 · /);
    }
    assert.ok(report.losses.some((l) => l.code === 'command-code.subagent-separate-session'));
    assert.ok(!report.losses.some((l) => l.code === 'command-code.subagent-dropped'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('默认不导出子代理，计入损失', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-children-'));
  try {
    const report = await writeCommandCodeSession(makeBundle(), { home, cwd: TEST_CWD, id: 'bbbbbbbb-2222-4222-8222-222222222222' });
    assert.equal(report.children.length, 0);
    assert.ok(report.losses.some((l) => l.code === 'command-code.subagent-dropped'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
