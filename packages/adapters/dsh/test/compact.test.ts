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
    partials.push({ kind: 'reasoning', reasoning: { kind: 'plain', text: 'reasoning ' + step } });
    partials.push({ kind: 'tool_call', callId: 'call_' + step, name: 'bash', input: { command: 'echo ' + step } });
    partials.push({ kind: 'tool_result', callId: 'call_' + step, content: [{ type: 'text', text: 'out ' + step }] });
    partials.push({ kind: 'message', role: 'assistant', parts: [{ type: 'text', text: 'assistant step ' + step }] });
  }
  const events = chainEvents(partials);
  return {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: 'compact:root',
      source: { agent: 'command-code', nativeSessionId: 'compact-session', formatVersion: '3' },
      meta: { cwd, title: 'compact test', createdAt: '2026-10-19T06:00:00.000Z', updatedAt: '2026-10-19T06:10:00.000Z' },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
}

test('compact：summaryCommand 可注入 LLM 摘要（用假命令验证 plumbing）', async () => {
  const home = await makeTempDir('compact-llm-');
  try {
    const bundle = buildBigBundle('/tmp/sessionport-compact-llm/project');
    const report = await writeDshSession(bundle, {
      home,
      id: 'session-44444444-4444-4444-8444-444444444444',
      compact: true,
      compactKeepRecentSteps: 2,
      summaryCommand: "printf '## Fake LLM summary\\n- user wants to build a bridge'",
    });
    const summary = report.rows.find((row) => row.type === 'compaction/summary')!;
    assert.match(JSON.stringify(summary.data.summary), /Fake LLM summary/);
    assert.ok(report.losses.some((loss) => loss.code === 'dsh.summary-llm'));
    const verify = await verifyDshSession({ home, sessionId: 'session-44444444-4444-4444-8444-444444444444' });
    assert.equal(verify.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('compact：保留全部事件，写入合法 compaction 链（start/summary/checkpoint/end）', async () => {
  const home = await makeTempDir('compact-');
  try {
    const bundle = buildBigBundle('/tmp/sessionport-compact-test/project');
    const report = await writeDshSession(bundle, { home, id: 'session-33333333-3333-4333-8333-333333333333', compact: true, compactKeepRecentSteps: 2 });
    const types = new Set(report.rows.map((row) => row.type));
    assert.ok(types.has('compaction/start'));
    assert.ok(types.has('compaction/summary'));
    assert.ok(types.has('compaction/end'));

    const summary = report.rows.find((row) => row.type === 'compaction/summary')!;
    const shadowedSeqs = (summary.data as { shadowedSeqs: number[] }).shadowedSeqs;
    assert.ok(shadowedSeqs.length > 0);
    const checkpoint = report.rows.find((row) => row.type === 'user/message' && (row.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')!;
    assert.ok(checkpoint !== undefined);
    assert.deepEqual((checkpoint.surfaceOp as { op: string }).op, 'replace');
    const refs = checkpoint.sourceEventSeqs ?? [];
    for (const seq of shadowedSeqs) assert.ok(refs.includes(seq), 'checkpoint sourceEventSeqs must include shadowed seq ' + seq);
    assert.ok(report.losses.some((loss) => loss.code === 'dsh.compacted-checkpoint'));

    // 完整事件日志仍在（1356 类似的全量事件 + compaction 链）
    assert.ok(report.rows.filter((row) => row.type === 'tool/result').length > 0);

    const verify = await verifyDshSession({ home, sessionId: 'session-33333333-3333-4333-8333-333333333333' });
    assert.equal(verify.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});