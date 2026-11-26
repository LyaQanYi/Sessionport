import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';
import { appendClaudeDelta, claudeCodeAdapter, readClaudeSession, sessionFilePath, verifyClaudeSession, writeClaudeSession } from '../src/index.ts';

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

test('同一 assistant 块中部分 tool_use 缺结果时，合成结果合并进紧随其后的 user tool_result 行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-merge-'));
  try {
    const events = chain([
      { kind: 'tool_call', id: 'e1', at: '2026-01-01T00:00:00Z', callId: 'call_a', name: 'Bash', input: { command: 'pwd' } },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '再查一下' }] },
      { kind: 'tool_call', id: 'e3', at: '2026-01-01T00:00:02Z', callId: 'call_b', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', id: 'e4', at: '2026-01-01T00:00:03Z', callId: 'call_b', content: [{ type: 'text', text: 'README.md' }] },
    ] as IrEventDraft[]);
    const report = await writeClaudeSession(makeBundle(events), {
      configDir: dir,
      sessionId: '44444444-4444-4444-8444-444444444444',
      cwd: '/tmp/sessionport-test',
    });
    assert.ok(report.losses.some((l) => l.code === 'claude.tool-result-synthesized'));
    const userRows = report.rows.filter((r) => r.type === 'user') as Array<{
      message: { content: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> };
    }>;
    assert.equal(userRows.length, 1);
    const resultBlocks = userRows[0]!.message.content.filter((b) => b.type === 'tool_result');
    assert.deepEqual(
      resultBlocks.map((b) => b.tool_use_id).sort(),
      ['call_a', 'call_b'],
    );
    assert.equal(resultBlocks.find((b) => b.tool_use_id === 'call_a')?.is_error, true);

    const verify = await verifyClaudeSession({
      configDir: dir,
      cwd: '/tmp/sessionport-test',
      sessionId: '44444444-4444-4444-8444-444444444444',
    });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('callId 为空字符串的孤立 tool_result 降级为文本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-empty-callid-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
      { kind: 'tool_result', id: 'e2', at: '2026-01-01T00:00:01Z', callId: '', content: [{ type: 'text', text: 'orphan output' }] },
      { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02Z', role: 'assistant', parts: [{ type: 'text', text: '收到' }] },
    ] as IrEventDraft[]);
    const report = await writeClaudeSession(makeBundle(events), {
      configDir: dir,
      sessionId: '55555555-5555-4555-8555-555555555555',
      cwd: '/tmp/sessionport-test',
    });
    assert.ok(report.losses.some((l) => l.code === 'claude.orphan-tool-result'));
    const allBlocks = report.rows.flatMap((r) => (r.message?.content ?? []) as Array<{ type?: string; tool_use_id?: string }>);
    assert.equal(allBlocks.some((b) => b.type === 'tool_result' && b.tool_use_id === ''), false);
    const verify = await verifyClaudeSession({
      configDir: dir,
      cwd: '/tmp/sessionport-test',
      sessionId: '55555555-5555-4555-8555-555555555555',
    });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendClaudeDelta: 保留已有 thinking+signature 前缀逐字节不变，追加增量并自检通过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-append-'));
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const cwd = '/tmp/sessionport-append-test';
  const file = sessionFilePath(dir, cwd, sessionId);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const row1 = JSON.stringify({
      type: 'user',
      uuid: 'orig-u1',
      parentUuid: null,
      sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd,
      version: '2.1.330',
      gitBranch: 'main',
      isSidechain: false,
      userType: 'external',
      message: { role: 'user', content: [{ type: 'text', text: '先思考一下' }] },
    });
    const row2 = JSON.stringify({
      type: 'assistant',
      uuid: 'orig-a1',
      parentUuid: 'orig-u1',
      sessionId,
      timestamp: '2026-01-01T00:00:01.000Z',
      cwd,
      version: '2.1.330',
      gitBranch: 'main',
      isSidechain: false,
      userType: 'external',
      message: {
        id: 'msg_orig_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [
          { type: 'thinking', thinking: '原始加密思考', signature: 'sig_anthropic_preserved_xyz' },
          { type: 'text', text: '好了' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const prefixBytes = Buffer.from(row1 + '\n' + row2 + '\n', 'utf8');
    writeFileSync(file, prefixBytes);

    const deltaEvents = chain([
      { kind: 'message', id: 'd1', at: '2026-01-01T00:01:00.000Z', role: 'user', parts: [{ type: 'text', text: '继续查文件' }] },
      { kind: 'tool_call', id: 'd2', at: '2026-01-01T00:01:01.000Z', callId: 'c_delta', name: 'exec_command', input: { cmd: 'ls' } },
      { kind: 'tool_result', id: 'd3', at: '2026-01-01T00:01:02.000Z', callId: 'c_delta', content: [{ type: 'text', text: 'ok' }] },
      { kind: 'message', id: 'd4', at: '2026-01-01T00:01:03.000Z', role: 'assistant', parts: [{ type: 'text', text: '搞定' }] },
    ] as IrEventDraft[]);
    const deltaBundle: IrBundle = {
      irVersion: IR_VERSION,
      createdAt: '2026-01-01T00:01:03.000Z',
      root: {
        id: 'ir_delta',
        source: { agent: 'codex', nativeSessionId: 'codex-1' },
        meta: { cwd },
        events: deltaEvents,
        head: 'd4',
        notices: [],
      },
      children: [],
    };

    const outcome = await claudeCodeAdapter.appendDelta!(file, deltaBundle, { normalizeTools: true });
    assert.equal(existsSync(file), true);
    const updatedBytes = readFileSync(file);
    assert.deepEqual(updatedBytes.subarray(0, prefixBytes.length), prefixBytes, '已有前缀必须逐字节一致');
    assert.equal(outcome.units, updatedBytes.toString('utf8').trim().split('\n').length);

    const verify = await verifyClaudeSession({ configDir: dir, cwd, sessionId });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks.filter((c) => !c.ok)));

    const readBack = await readClaudeSession(file);
    assert.ok(readBack.root.events.some((e) => e.kind === 'reasoning' && e.reasoning.kind === 'plain' && e.reasoning.signature === 'sig_anthropic_preserved_xyz'));
    const toolCall = readBack.root.events.find((e) => e.kind === 'tool_call');
    assert.equal(toolCall?.kind === 'tool_call' ? toolCall.name : undefined, 'Bash');

    void appendClaudeDelta;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
