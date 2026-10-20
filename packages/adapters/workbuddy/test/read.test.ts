import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkBuddyTranscript, readWorkBuddySession } from '../src/index.ts';
import { WB_CWD, WB_SESSION_ID, writeWorkBuddyFixture } from './fixtures.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-wb-read-'));
}

test('WorkBuddy: 读 transcript -> IR（user/reasoning/tool/assistant + 子代理）', async () => {
  const home = makeHome();
  try {
    writeWorkBuddyFixture(home, { includeSubagent: true });
    const bundle = await readWorkBuddySession(WB_SESSION_ID, { home });
    const kinds: Record<string, number> = {};
    for (const event of bundle.root.events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
    assert.deepEqual(kinds, { message: 2, reasoning: 1, tool_call: 1, tool_result: 1, boundary: 1 });

    assert.equal(bundle.root.id, 'workbuddy:' + WB_SESSION_ID);
    assert.equal(bundle.root.source.agent, 'workbuddy');
    assert.equal(bundle.root.source.nativeSessionId, WB_SESSION_ID);
    assert.equal(bundle.root.meta.cwd, WB_CWD);
    assert.equal(bundle.root.meta.title, 'WorkBuddy 测试会话');
    assert.equal(bundle.root.meta.model, 'step-5-preview');
    assert.equal(bundle.root.meta.lastPrompt, '你好，帮我看看目录');
    assert.equal(bundle.children.length, 1);
    assert.equal(bundle.children[0]!.parentSessionId, WB_SESSION_ID);
    assert.equal(bundle.children[0]!.label, '22222222-2222-4222-8222-222222222222');
    assert.equal(bundle.children[0]!.session.events.filter((event) => event.kind === 'message').length, 2);

    const user = bundle.root.events.find((event) => event.kind === 'message' && event.role === 'user');
    assert.ok(user && user.kind === 'message');
    assert.equal(user.parts[0]!.type, 'text');
    assert.equal((user.parts[0] as { text: string }).text, '你好，帮我看看目录');
    assert.equal(user.synthetic, undefined);

    const call = bundle.root.events.find((event) => event.kind === 'tool_call');
    assert.ok(call && call.kind === 'tool_call');
    assert.equal(call.callId, 'call_1');
    assert.equal(call.name, 'Bash');
    assert.deepEqual(call.input, { command: 'ls' });
    const result = bundle.root.events.find((event) => event.kind === 'tool_result');
    assert.ok(result && result.kind === 'tool_result');
    assert.equal(result.callId, 'call_1');
    assert.equal((result.content[0] as { text: string }).text, 'README.md\nsrc');

    assert.ok(bundle.root.notices.some((notice) => notice.code === 'workbuddy.credit-usage-skipped'));
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'workbuddy.resend-fork'));
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'workbuddy.subagents'));

    let prev: string | null = null;
    for (const event of bundle.root.events) {
      assert.equal(event.parentId, prev);
      prev = event.id;
    }
    assert.equal(bundle.root.head, prev);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('WorkBuddy: 按路径读；system-reminder 注入消息标记 synthetic', async () => {
  const home = makeHome();
  try {
    const fixture = writeWorkBuddyFixture(home);
    const byPath = await readWorkBuddySession(fixture.path);
    assert.equal(byPath.root.events.length, 6);

    const text = [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder data-role="tool-hint">Read ...</system-reminder>' }], timestamp: 1, cwd: '/tmp/x' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }], timestamp: 2, cwd: '/tmp/x' }),
    ].join('\n');
    const bundle = parseWorkBuddyTranscript(text);
    const user = bundle.root.events.find((event) => event.kind === 'message' && event.role === 'user');
    assert.ok(user && user.kind === 'message');
    assert.equal(user.synthetic, true);
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'workbuddy.injected-user-message'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('WorkBuddy: 坏行/未知行/坏工具参数不阻断，记 notice', () => {
  const lines = [
    JSON.stringify({ type: 'session-meta', id: 'm', timestamp: 1, cwd: '/tmp/x' }),
    '{broken json',
    JSON.stringify({ type: 'mystery', timestamp: 2, cwd: '/tmp/x' }),
    JSON.stringify({ type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: 'hi' }], timestamp: 3, cwd: '/tmp/x' }),
    JSON.stringify({ type: 'function_call', id: 'fc', callId: 'c1', name: 'Bash', arguments: '{not json', timestamp: 4, cwd: '/tmp/x' }),
    JSON.stringify({ type: 'function_call_result', id: 'fr', callId: 'c1', name: 'Bash', status: 'completed', output: { type: 'text', text: 'ok' }, timestamp: 5, cwd: '/tmp/x' }),
  ];
  const bundle = parseWorkBuddyTranscript(lines.join('\n'));
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'workbuddy.unknown-line'));
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'workbuddy.bad-tool-arguments'));
  const call = bundle.root.events.find((event) => event.kind === 'tool_call');
  assert.ok(call && call.kind === 'tool_call');
  assert.deepEqual(call.input, { raw: '{not json' });
});
