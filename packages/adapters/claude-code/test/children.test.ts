import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { verifyClaudeSession, writeClaudeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-claude-children';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function makeSession(id: string, text: string) {
  const events = chain([
    { kind: 'message', id: id + '-e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text }] },
    { kind: 'message', id: id + '-e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
  ] as Array<Omit<IrEvent, 'parentId'>>);
  return { id, source: { agent: 'kimi-code' as const, nativeSessionId: id }, meta: { cwd: TEST_CWD, title: text }, events, head: events[events.length - 1]!.id, notices: [] };
}

function makeBundle(): IrBundle {
  const root = makeSession('root-1', '主会话');
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root,
    children: [{ session: makeSession('session_33333333-3333-4333-8333-333333333333', '子代理'), parentSessionId: root.id, label: 'explore' }],
  };
}

test('includeChildren：子代理写成独立 Claude 会话并可通过结构校验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-children-'));
  try {
    const report = await writeClaudeSession(makeBundle(), {
      configDir: dir,
      cwd: TEST_CWD,
      sessionId: 'cccccccc-3333-4333-8333-333333333333',
      includeChildren: true,
    });
    assert.equal(report.children.length, 1);
    const child = report.children[0]!;
    assert.equal(child.sessionId, '33333333-3333-4333-8333-333333333333');
    assert.ok(existsSync(child.filePath));
    const verify = await verifyClaudeSession({ configDir: dir, cwd: TEST_CWD, sessionId: child.sessionId });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
    assert.ok(report.losses.some((l) => l.code === 'claude.subagent-separate-session'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
