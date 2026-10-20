import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION, validateIrBundle } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { readClaudeSession, writeClaudeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-claude-read';
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function makeBundle(events: IrEvent[]): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: new Date(0).toISOString(),
    root: {
      id: 'ir_claude_read',
      source: { agent: 'codex' },
      meta: { cwd: TEST_CWD, title: '源标题', model: 'claude-sonnet-5' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: [],
  };
}

function jsonl(values: unknown[]): string {
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') + '\n';
}

async function writeProjectSession(root: string, sessionId: string, lines: unknown[]): Promise<string> {
  const dir = join(root, 'projects', '-tmp-sessionport-claude-read');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, sessionId + '.jsonl');
  await writeFile(filePath, jsonl(lines), 'utf8');
  return filePath;
}

test('round-trip: writeClaudeSession 写出的 IR 能被 readClaudeSession 读回（事件/角色/工具配对一致）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-read-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '跑一下测试' }] },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '开始' }] },
      { kind: 'tool_call', id: 'e3', at: '2026-01-01T00:00:02Z', callId: 'tool_1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', id: 'e4', at: '2026-01-01T00:00:03Z', callId: 'tool_1', content: [{ type: 'text', text: 'a\nb' }], isError: true },
      { kind: 'message', id: 'e5', at: '2026-01-01T00:00:04Z', role: 'assistant', parts: [{ type: 'text', text: '完成' }] },
    ] as Array<Omit<IrEvent, 'parentId'>>);

    const report = await writeClaudeSession(makeBundle(events), {
      configDir: dir,
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      model: 'claude-sonnet-5',
    });

    const bundle = await readClaudeSession(SESSION_ID, { configDir: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.id, 'claude-code:' + SESSION_ID);
    assert.equal(bundle.root.source.agent, 'claude-code');
    assert.equal(bundle.root.source.nativeSessionId, SESSION_ID);
    assert.equal(bundle.root.source.nativePath, report.filePath);
    assert.equal(bundle.root.meta.cwd, TEST_CWD);
    assert.equal(bundle.root.meta.model, 'claude-sonnet-5');
    // writer 不写 custom-title/summary，标题回落到首条真实 user 文本
    assert.equal(bundle.root.meta.title, '跑一下测试');

    assert.deepEqual(
      bundle.root.events.map((event) => event.kind),
      ['message', 'message', 'tool_call', 'tool_result', 'message'],
    );
    assert.deepEqual(
      bundle.root.events.filter((event) => event.kind === 'message').map((event) => (event as { role: string }).role),
      ['user', 'assistant', 'assistant'],
    );
    const call = bundle.root.events.find((event) => event.kind === 'tool_call') as { callId: string; name: string; input: unknown };
    const result = bundle.root.events.find((event) => event.kind === 'tool_result') as { callId: string; isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.equal(call.callId, 'tool_1');
    assert.equal(call.name, 'Bash');
    assert.deepEqual(call.input, { command: 'ls' });
    assert.equal(result.callId, call.callId);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: 'a\nb' }]);

    // 文件路径和 'last' 也能定位到同一会话
    const byPath = await readClaudeSession(report.filePath, { configDir: dir });
    assert.equal(byPath.root.events.length, bundle.root.events.length);
    const byLast = await readClaudeSession('last', { configDir: dir });
    assert.equal(byLast.root.source.nativeSessionId, SESSION_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('映射：text/thinking/tool_use/tool_result/compact_boundary/sidechain/未知行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-read-'));
  try {
    const filePath = await writeProjectSession(dir, SESSION_ID, [
      { type: 'custom-title', customTitle: '自定义标题' },
      { type: 'summary', summary: '摘要标题' },
      {
        type: 'user',
        uuid: 'u1',
        sessionId: SESSION_ID,
        cwd: '/tmp/claude-fixture',
        version: '2.1.303',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: '你好' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-opus-4',
          content: [
            { type: 'thinking', thinking: '想一想', signature: 'sig-1' },
            { type: 'text', text: '开始' },
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'pwd' } },
            { type: 'mystery_block', value: 1 },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'a\nb', is_error: true }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        sessionId: SESSION_ID,
        isMeta: true,
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '注入上下文' }] },
      },
      {
        type: 'user',
        uuid: 'u4',
        sessionId: SESSION_ID,
        isSidechain: true,
        timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'user', content: '子代理行' },
      },
      { type: 'system', subtype: 'compact_boundary', sessionId: SESSION_ID, timestamp: '2026-01-01T00:00:05.000Z' },
      { type: 'system', subtype: 'api_error', sessionId: SESSION_ID, timestamp: '2026-01-01T00:00:06.000Z' },
      { type: 'mystery-row', sessionId: SESSION_ID, timestamp: '2026-01-01T00:00:07.000Z' },
      'not json',
    ]);

    const bundle = await readClaudeSession(filePath, { configDir: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.source.nativePath, filePath);
    assert.equal(bundle.root.source.cliVersion, '2.1.303');
    assert.equal(bundle.root.meta.cwd, '/tmp/claude-fixture');
    assert.equal(bundle.root.meta.title, '自定义标题');
    assert.equal(bundle.root.meta.model, 'claude-opus-4');
    assert.equal(bundle.root.meta.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(bundle.root.meta.lastPrompt, '你好');

    assert.deepEqual(
      bundle.root.events.map((event) => event.kind),
      ['message', 'reasoning', 'message', 'tool_call', 'tool_result', 'message', 'boundary'],
    );
    const reasoning = bundle.root.events[1] as { reasoning: { kind: string; text: string; signature?: string } };
    assert.deepEqual(reasoning.reasoning, { kind: 'plain', text: '想一想', signature: 'sig-1' });
    const toolResult = bundle.root.events[4] as { callId: string; isError?: boolean };
    assert.equal(toolResult.callId, 'tool_1');
    assert.equal(toolResult.isError, true);
    const synthetic = bundle.root.events[5] as { role: string; synthetic?: boolean };
    assert.equal(synthetic.role, 'user');
    assert.equal(synthetic.synthetic, true);
    assert.equal((bundle.root.events[6] as { boundary: string }).boundary, 'compact');
    assert.ok(!bundle.root.events.some((event) => event.kind === 'message' && JSON.stringify(event).includes('子代理行')));

    const codes = bundle.root.notices.map((notice) => notice.code);
    for (const code of [
      'claude.bad-json-lines',
      'claude.sidechain-skipped',
      'claude.compact-boundary',
      'claude.system-lines-skipped',
      'claude.unknown-line-type',
      'claude.unknown-content-block',
      'claude.synthetic-user-message',
    ]) {
      assert.ok(codes.includes(code), '缺少 notice ' + code + '，实际 ' + codes.join(','));
    }
    assert.equal(bundle.root.notices.find((notice) => notice.code === 'claude.bad-json-lines')?.count, 1);
    assert.equal(bundle.root.notices.find((notice) => notice.code === 'claude.unknown-line-type')?.count, 1);
    assert.ok(!codes.includes('claude.orphan-tool-result'));
    assert.ok(!codes.includes('claude.tool-without-result'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('容错：孤立 tool_result 记 notice，不影响其它事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-read-'));
  try {
    const filePath = await writeProjectSession(dir, SESSION_ID, [
      {
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing_call', content: 'x' }] },
      },
    ]);
    const bundle = await readClaudeSession(filePath, { configDir: dir });
    assert.equal(bundle.root.events.length, 1);
    assert.equal(bundle.root.events[0]!.kind, 'tool_result');
    const notice = bundle.root.notices.find((entry) => entry.code === 'claude.orphan-tool-result');
    assert.equal(notice?.count, 1);
    assert.equal(notice?.severity, 'warning');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('标题：summary 优先于首条 user 文本；没有标题行时用首条 user 文本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-read-'));
  try {
    const summaryId = 'bbbbbbbb-2222-4222-8222-222222222222';
    await writeProjectSession(dir, summaryId, [
      { type: 'summary', summary: '摘要兜底标题' },
      { type: 'user', message: { role: 'user', content: '真正的第一条问题' }, timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    const withSummary = await readClaudeSession(summaryId, { configDir: dir });
    assert.equal(withSummary.root.meta.title, '摘要兜底标题');

    const plainId = 'cccccccc-3333-4333-8333-333333333333';
    await writeProjectSession(dir, plainId, [
      { type: 'user', message: { role: 'user', content: '真正的第一条问题' }, timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    const plain = await readClaudeSession(plainId, { configDir: dir });
    assert.equal(plain.root.meta.title, '真正的第一条问题');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
