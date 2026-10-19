import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportToBundle, readOpencodeSession } from '../src/index.ts';

function sampleExport(): unknown {
  return {
    info: {
      id: 'ses_test000000000000000000001',
      slug: 'test-session',
      projectID: 'global',
      directory: '/tmp/sessionport-opencode',
      path: 'tmp/sessionport-opencode',
      title: 'opencode 测试会话',
      agent: 'build',
      model: { id: 'claude-haiku-5-5', providerID: 'opencode-go' },
      version: '1.19.3',
      time: { created: 1791807570253, updated: 1791807583495 },
    },
    messages: [
      {
        info: { id: 'msg_1', sessionID: 'ses_test000000000000000000001', role: 'user', time: { created: 1791807570300 } },
        parts: [{ type: 'text', text: '你好', id: 'prt_1' }],
      },
      {
        info: { id: 'msg_2', sessionID: 'ses_test000000000000000000001', role: 'assistant', parentID: 'msg_1', time: { created: 1791807570400 } },
        parts: [
          { type: 'step-start', id: 'prt_2' },
          { type: 'reasoning', text: '想一想', id: 'prt_3', metadata: { anthropic: { signature: 'sig-abc' } } },
          { type: 'text', text: '先看看目录', id: 'prt_4' },
          {
            type: 'tool',
            id: 'prt_5',
            callID: 'call_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'README.md' },
          },
          { type: 'step-finish', id: 'prt_6' },
          { type: 'text', text: '完成', id: 'prt_7' },
        ],
      },
    ],
  };
}

test('导出 JSON -> IR：user/assistant/reasoning/tool 配对映射', () => {
  const bundle = exportToBundle(sampleExport() as never);
  const kinds = bundle.root.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(kinds, { message: 3, reasoning: 1, tool_call: 1, tool_result: 1 });
  assert.equal(bundle.root.meta.cwd, '/tmp/sessionport-opencode');
  assert.equal(bundle.root.meta.title, 'opencode 测试会话');
  assert.equal(bundle.root.source.nativeSessionId, 'ses_test000000000000000000001');

  const call = bundle.root.events.find((event) => event.kind === 'tool_call') as { callId: string; name: string };
  assert.equal(call.callId, 'call_1');
  assert.equal(call.name, 'bash');
  const result = bundle.root.events.find((event) => event.kind === 'tool_result') as { callId: string };
  assert.equal(result.callId, 'call_1');
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'opencode.step-parts-skipped'));

  // 链完整
  let prev: string | null = null;
  for (const event of bundle.root.events) {
    assert.equal(event.parentId, prev);
    prev = event.id;
  }
});

test('读取已导出的 JSON 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-opencode-'));
  try {
    const file = join(dir, 'session.json');
    writeFileSync(file, JSON.stringify(sampleExport()));
    const bundle = await readOpencodeSession(file);
    assert.equal(bundle.root.events.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进行中的工具调用只保留调用并记 notice', () => {
  const raw = sampleExport() as { messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }> };
  const assistant = raw.messages[1]!;
  assistant.parts = [
    { type: 'tool', id: 'prt_x', callID: 'call_running', tool: 'bash', state: { status: 'running', input: {} } },
  ];
  const bundle = exportToBundle(raw as never);
  assert.equal(bundle.root.events.filter((event) => event.kind === 'tool_call').length, 1);
  assert.equal(bundle.root.events.filter((event) => event.kind === 'tool_result').length, 0);
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'opencode.tool-without-output'));
});
