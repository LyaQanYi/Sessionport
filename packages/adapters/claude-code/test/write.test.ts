import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';
import { writeClaudeSession } from '../src/write.ts';
import { verifyClaudeSession } from '../src/verify.ts';

function chain(events: IrEventDraft[]): IrEvent[] {
  return events.map((e, i) => ({ ...e, parentId: i === 0 ? null : events[i - 1]!.id })) as IrEvent[];
}

function makeBundle(events: IrEvent[]): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: new Date(0).toISOString(),
    root: {
      id: 'ir_x',
      source: { agent: 'kimi-code' },
      meta: { cwd: '/tmp/sessionport-test', title: 't', model: 'kimi-for-coding' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: [],
  };
}

test('把 IR 写成 Claude 行并结构化自检通过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
      { kind: 'reasoning', id: 'e2', at: '2026-01-01T00:00:01Z', reasoning: { kind: 'plain', text: '想一想' } },
      { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02Z', role: 'assistant', parts: [{ type: 'text', text: '开始' }] },
      { kind: 'tool_call', id: 'e4', at: '2026-01-01T00:00:03Z', callId: 'tool_1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', id: 'e5', at: '2026-01-01T00:00:04Z', callId: 'tool_1', content: [{ type: 'text', text: 'a\nb' }] },
      { kind: 'message', id: 'e6', at: '2026-01-01T00:00:05Z', role: 'assistant', parts: [{ type: 'text', text: '完成' }] },
    ] as IrEventDraft[]);
    const bundle = makeBundle(events);
    const report = await writeClaudeSession(bundle, {
      configDir: dir,
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/sessionport-test',
      version: '2.1.303',
    });
    // user / assistant(text+tool_use) / user(tool_result) / assistant(text)，reasoning 默认丢弃
    assert.equal(report.rows.length, 4);
    assert.equal(report.written.toolCalls, 1);
    assert.ok(report.losses.some((l) => l.code === 'claude.reasoning-dropped'));

    const verify = await verifyClaudeSession({
      configDir: dir,
      cwd: '/tmp/sessionport-test',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺失的 tool_result 会被合成占位，保证可加载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
      { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01Z', callId: 'tool_missing', name: 'Bash', input: {} },
    ] as IrEventDraft[]);
    const report = await writeClaudeSession(makeBundle(events), {
      configDir: dir,
      sessionId: '22222222-2222-4222-8222-222222222222',
      cwd: '/tmp/sessionport-test',
    });
    assert.ok(report.losses.some((l) => l.code === 'claude.tool-result-synthesized'));
    const verify = await verifyClaudeSession({ configDir: dir, cwd: '/tmp/sessionport-test', sessionId: '22222222-2222-4222-8222-222222222222' });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--keep-thinking 时 reasoning 降级为 text 块', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-'));
  try {
    const events = chain([
      { kind: 'reasoning', id: 'e1', at: '2026-01-01T00:00:00Z', reasoning: { kind: 'plain', text: '思考内容' } },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '答案' }] },
    ] as IrEventDraft[]);
    const report = await writeClaudeSession(makeBundle(events), {
      configDir: dir,
      sessionId: '33333333-3333-4333-8333-333333333333',
      cwd: '/tmp/sessionport-test',
      keepThinking: true,
    });
    assert.ok(!report.losses.some((l) => l.code === 'claude.reasoning-dropped'));
    assert.equal(report.rows.length, 1);
    const content = (report.rows[0] as { message: { content: Array<{ text?: string }> } }).message.content;
    assert.deepEqual(content.map((b) => b.text), ['思考内容', '答案']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
