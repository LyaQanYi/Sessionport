import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { readCodexSession, verifyCodexSession, writeCodexSession, inferCodexHome } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-codex-test';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function makeBundle(events: IrEvent[]): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00Z',
    root: {
      id: 'ir_codex',
      source: { agent: 'dsh', nativeSessionId: 'session-test' },
      meta: { cwd: TEST_CWD, title: 'codex 写入测试', createdAt: '2026-01-01T00:00:00Z' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: [],
  };
}

test('写入 rollout：session_meta + response_item，结构自检通过且能读回', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-codex-home-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
      { kind: 'reasoning', id: 'e2', at: '2026-01-01T00:00:01Z', reasoning: { kind: 'plain', text: '想想' } },
      { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02Z', role: 'assistant', parts: [{ type: 'text', text: '开始' }] },
      { kind: 'tool_call', id: 'e4', at: '2026-01-01T00:00:03Z', callId: 'call_1', name: 'exec_command', input: { cmd: 'ls' } },
      { kind: 'tool_result', id: 'e5', at: '2026-01-01T00:00:04Z', callId: 'call_1', content: [{ type: 'text', text: 'a\nb' }] },
      { kind: 'message', id: 'e6', at: '2026-01-01T00:00:05Z', role: 'assistant', parts: [{ type: 'text', text: '完成' }] },
    ] as Array<Omit<IrEvent, 'parentId'>>);
    const report = await writeCodexSession(makeBundle(events), {
      home,
      cwd: TEST_CWD,
      id: '11111111-1111-4111-8111-111111111111',
      title: 'codex 写入测试',
    });
    assert.equal(report.written.toolCalls, 1);
    assert.equal(report.written.toolResults, 1);

    const verify = await verifyCodexSession({ filePath: report.filePath });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));

    const back = await readCodexSession('11111111-1111-4111-8111-111111111111', { home });
    assert.equal(back.root.events.length, 6);
    assert.equal(back.root.meta.cwd, TEST_CWD);
    const toolCall = back.root.events.find((event) => event.kind === 'tool_call');
    assert.equal((toolCall as { callId: string }).callId, 'call_1');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('缺失工具结果时合成占位输出，保持 rollout 自洽', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-codex-home-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
      { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01Z', callId: 'call_missing', name: 'exec_command', input: {} },
    ] as Array<Omit<IrEvent, 'parentId'>>);
    const report = await writeCodexSession(makeBundle(events), {
      home,
      cwd: TEST_CWD,
      id: '22222222-2222-4222-8222-222222222222',
    });
    assert.ok(report.losses.some((loss) => loss.code === 'codex.tool-result-synthesized'));
    const verify = await verifyCodexSession({ filePath: report.filePath });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('dryRun 不落盘', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-codex-home-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ] as Array<Omit<IrEvent, 'parentId'>>);
    const report = await writeCodexSession(makeBundle(events), { home, cwd: TEST_CWD, dryRun: true });
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(report.filePath), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('非法 session id 直接报错（Codex 会静默新建会话）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-codex-home-'));
  try {
    await assert.rejects(
      () => writeCodexSession(makeBundle(chain([
        { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      ] as Array<Omit<IrEvent, 'parentId'>>)), { home, cwd: TEST_CWD, id: 'not-a-uuid' }),
      /必须是 UUID/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('paginated 模式：每行带递增 ordinal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-codex-home-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '收到' }] },
    ] as Array<Omit<IrEvent, 'parentId'>>);
    const report = await writeCodexSession(makeBundle(events), {
      home,
      cwd: TEST_CWD,
      id: '33333333-3333-4333-8333-333333333333',
      historyMode: 'paginated',
    });
    const rows = readFileSync(report.filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].payload.history_mode, 'paginated');
    assert.deepEqual(rows.map((row: { ordinal?: number }) => row.ordinal), rows.map((_, index: number) => index));
    const verify = await verifyCodexSession({ filePath: report.filePath });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('inferCodexHome 从 rollout 路径反推数据目录', () => {
  const home = inferCodexHome('/tmp/x/codex-home/sessions/2026/10/19/rollout-abc.jsonl');
  assert.equal(home, '/tmp/x/codex-home');
  assert.equal(inferCodexHome('/tmp/nowhere/file.jsonl'), undefined);
});