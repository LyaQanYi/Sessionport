import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseQoderTranscript, qoderLinesToBundle, readQoderSession } from '../src/index.ts';
import { QD_CWD, QD_SESSION_ID, qdTranscriptLines, writeQoderFixture } from './fixtures.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-qd-read-'));
}

test('Qoder: 读 transcript -> IR（active-leaf 分支、tool 配对、attachment 跳过）', async () => {
  const home = makeHome();
  try {
    writeQoderFixture(home);
    const bundle = await readQoderSession(QD_SESSION_ID, { home });
    const kinds: Record<string, number> = {};
    for (const event of bundle.root.events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
    assert.deepEqual(kinds, { message: 3, reasoning: 1, tool_call: 1, tool_result: 1 });

    assert.equal(bundle.root.id, 'qoder:' + QD_SESSION_ID);
    assert.equal(bundle.root.source.agent, 'qoder');
    assert.equal(bundle.root.source.nativeSessionId, QD_SESSION_ID);
    assert.equal(bundle.root.source.formatVersion, '1.1.69');
    assert.equal(bundle.root.meta.cwd, QD_CWD);
    assert.equal(bundle.root.meta.title, '第二个问题');
    assert.equal(bundle.root.meta.model, 'qfmodel');
    assert.equal(bundle.root.meta.lastPrompt, '第一个问题');

    const user = bundle.root.events.find((event) => event.kind === 'message' && event.role === 'user');
    assert.ok(user && user.kind === 'message');
    assert.equal((user.parts[0] as { text: string }).text, '第一个问题');
    const tool = bundle.root.events.find((event) => event.kind === 'tool_call');
    assert.ok(tool && tool.kind === 'tool_call');
    assert.equal(tool.callId, 'call_1');
    assert.equal(tool.name, 'Bash');
    assert.deepEqual(tool.input, { command: 'ls' });
    const result = bundle.root.events.find((event) => event.kind === 'tool_result');
    assert.ok(result && result.kind === 'tool_result');
    assert.equal(result.callId, 'call_1');
    assert.equal((result.content[0] as { text: string }).text, 'README.md\nsrc');

    assert.ok(bundle.root.notices.some((notice) => notice.code === 'qoder.attachments-skipped' && notice.count === 1));
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'qoder.branch-pruned' && notice.count === 2));

    // 旧分支不应出现
    const texts = bundle.root.events.filter((event) => event.kind === 'message').map((event) => (event.parts[0] as { text: string }).text);
    assert.ok(!texts.some((text) => text.includes('旧分支')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Qoder: readAllBranches 读所有分叉；子代理作为 children', async () => {
  const home = makeHome();
  try {
    writeQoderFixture(home, { withSubagent: true });
    const all = await readQoderSession(QD_SESSION_ID, { home, readAllBranches: true });
    assert.equal(all.root.events.filter((event) => event.kind === 'message').length, 5);
    assert.ok(all.root.events.some((event) => event.kind === 'message' && (event.parts[0] as { text: string }).text.includes('旧分支')));

    const bundle = await readQoderSession(QD_SESSION_ID, { home });
    assert.equal(bundle.children.length, 1);
    const child = bundle.children[0]!;
    assert.equal(child.parentSessionId, QD_SESSION_ID);
    assert.equal(child.label, 'aExplore-abc123');
    assert.equal(child.viaToolCallId, 'call_sub');
    // meta.json 的 description/agentType 落到 child 标题/profile（真实 Qoder 样本同款）
    assert.equal(child.session.meta.title, '探索 src');
    assert.equal(child.session.meta.profile, 'Explore');
    assert.equal(child.session.events.filter((event) => event.kind === 'message').length, 2);
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'qoder.subagents'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Qoder: system-reminder 注入 user 标记 synthetic；坏行不阻断', () => {
  const lines = [
    ...qdTranscriptLines(),
    { type: 'user', uuid: '00000000-0000-4000-8000-0000000000d1', parentUuid: '00000000-0000-4000-8000-000000000007', timestamp: '2026-10-16T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }] }, sessionId: QD_SESSION_ID, cwd: QD_CWD },
  ];
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n{bad json\n';
  const bundle = parseQoderTranscript(text, { readAllBranches: true });
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'qoder.bad-json-lines'));
  const synthetic = bundle.root.events.find((event) => event.kind === 'message' && event.role === 'user' && event.synthetic === true);
  assert.ok(synthetic);

  const direct = qoderLinesToBundle(lines as never[]);
  assert.equal(direct.root.source.nativeSessionId, QD_SESSION_ID);
});
