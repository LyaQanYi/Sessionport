import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle } from '@sessionport/core';

import { verifyDshSession } from '../src/verify.ts';
import { writeDshSession } from '../src/write.ts';
import { chainEvents, makeTempDir } from './fixtures.ts';

function buildBigBundle(cwd: string): IrBundle {
  const partials: Parameters<typeof chainEvents>[0] = [];
  for (let step = 0; step < 10; step += 1) {
    partials.push({ kind: 'message', role: 'user', parts: [{ type: 'text', text: 'user step ' + step }] });
    partials.push({ kind: 'reasoning', reasoning: { kind: 'plain', text: 'reasoning ' + step + ' ' + 'r'.repeat(3000) } });
    partials.push({ kind: 'tool_call', callId: 'call_' + step, name: 'bash', input: { command: 'echo ' + 'x'.repeat(4000) } });
    partials.push({ kind: 'tool_result', callId: 'call_' + step, content: [{ type: 'text', text: 'out ' + step + ' ' + 'y'.repeat(4000) }] });
    partials.push({ kind: 'message', role: 'assistant', parts: [{ type: 'text', text: 'assistant step ' + step }] });
  }
  const events = chainEvents(partials);
  return {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: 'slim:root',
      source: { agent: 'command-code', nativeSessionId: 'slim-session', formatVersion: '3' },
      meta: { cwd, title: 'slim test', createdAt: '2026-10-19T06:00:00.000Z', updatedAt: '2026-10-19T06:10:00.000Z' },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
}

test('slim：旧 step 的工具事件丢弃、长结果截断，并记录损失', async () => {
  const home = await makeTempDir('slim-');
  try {
    const bundle = buildBigBundle('/tmp/sessionport-slim-test/project');
    const full = await writeDshSession(bundle, { home, id: 'session-11111111-1111-4111-8111-111111111111' });
    const slim = await writeDshSession(bundle, { home, id: 'session-22222222-2222-4222-8222-222222222222', slim: true });
    const codes = slim.losses.map((loss) => loss.code);
    assert.ok(slim.rows.length < full.rows.length, 'slim rows should be fewer');
    assert.ok(codes.includes('dsh.slim-old-tool-events-dropped'));
    assert.ok(codes.includes('dsh.slim-tool-result-truncated'));
    assert.ok(codes.includes('dsh.slim-reasoning-dropped'));
    assert.ok(codes.includes('dsh.slim-tool-call-arguments-truncated'));

    const verify = await verifyDshSession({ home, sessionId: 'session-22222222-2222-4222-8222-222222222222' });
    assert.equal(verify.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});