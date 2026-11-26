import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION, SESSION_AGENTS } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';

import { getAdapter, prefixTable, WRITE_TARGETS } from '../src/adapters.ts';

function chain(events: IrEventDraft[]): IrEvent[] {
  return events.map((event, index) => ({
    ...event,
    parentId: index === 0 ? null : events[index - 1]!.id,
  })) as IrEvent[];
}

function makeBundle(events: IrEvent[], sourceAgent: 'claude-code' | 'codex' = 'claude-code'): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root: {
      id: 'ir_adapter_test',
      source: { agent: sourceAgent, nativeSessionId: 'src-1' },
      meta: { cwd: '/tmp/sessionport-adapter-test', title: 'adapter test', createdAt: '2026-01-01T00:00:00.000Z' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: [],
  };
}

test('adapter 注册表：10 家全部可加载，WRITE_TARGETS 具备 write，只读端无 write', async () => {
  for (const agentId of SESSION_AGENTS) {
    const adapter = await getAdapter(agentId);
    assert.ok(adapter !== undefined, 'missing adapter: ' + agentId);
    assert.equal(adapter.id, agentId);
    assert.ok(adapter.sourcePrefixes.length > 0);
    assert.equal(typeof adapter.read, 'function');
  }
  for (const target of WRITE_TARGETS) {
    const adapter = await getAdapter(target);
    assert.ok(adapter !== undefined);
    assert.equal(typeof adapter.write, 'function', target + ' should implement write');
  }
  const kimi = await getAdapter('kimi-code');
  const wb = await getAdapter('workbuddy');
  const agy = await getAdapter('antigravity');
  assert.equal(kimi?.write, undefined);
  assert.equal(wb?.write, undefined);
  assert.equal(agy?.write, undefined);
  assert.equal(await getAdapter('unknown-agent'), undefined);
  assert.ok(prefixTable().length >= SESSION_AGENTS.length);
});

test('adapter dryRun：claude-code / codex / command-code / qoder / dsh 产出有效 targetId 与 paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-adapters-dry-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01.000Z', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    ]);
    const bundle = makeBundle(events, 'claude-code');
    for (const target of ['claude-code', 'codex', 'command-code', 'qoder', 'dsh'] as const) {
      const adapter = await getAdapter(target);
      assert.ok(adapter?.write !== undefined);
      const outcome = await adapter.write(bundle, { home: join(dir, target), dryRun: true, cwd: dir });
      assert.equal(outcome.target, target);
      assert.ok(outcome.targetId.length > 0, target + ' targetId empty');
      assert.ok(outcome.paths.length > 0, target + ' paths empty');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter 端到端工具归一：Codex exec_command → Claude Bash，normalizeTools:false 时保留原名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-adapters-norm-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: 'list files' }] },
      { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01.000Z', callId: 'call_1', name: 'exec_command', input: { cmd: 'ls' } },
      { kind: 'tool_result', id: 'e3', at: '2026-01-01T00:00:02.000Z', callId: 'call_1', content: [{ type: 'text', text: 'README.md' }] },
    ]);
    const bundle = makeBundle(events, 'codex');
    const claude = await getAdapter('claude-code');
    assert.ok(claude?.write !== undefined);

    const normalizedOutcome = await claude.write(bundle, { home: dir, dryRun: true, cwd: dir });
    assert.ok(normalizedOutcome.report.losses?.some((loss) => loss.code === 'claude.tool-normalized'));
    const normRows = normalizedOutcome.report.rows as Array<{ type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } }>;
    const normToolUse = normRows
      .filter((row) => row.type === 'assistant')
      .flatMap((row) => row.message?.content ?? [])
      .find((block) => block.type === 'tool_use');
    assert.equal(normToolUse?.name, 'Bash');
    assert.deepEqual(normToolUse?.input, { command: 'ls' });

    const rawOutcome = await claude.write(bundle, { home: dir, dryRun: true, cwd: dir, normalizeTools: false });
    assert.ok(!rawOutcome.report.losses?.some((loss) => loss.code === 'claude.tool-normalized'));
    const rawRows = rawOutcome.report.rows as Array<{ type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } }>;
    const rawToolUse = rawRows
      .filter((row) => row.type === 'assistant')
      .flatMap((row) => row.message?.content ?? [])
      .find((block) => block.type === 'tool_use');
    assert.equal(rawToolUse?.name, 'exec_command');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
