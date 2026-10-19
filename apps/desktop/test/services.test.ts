import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listSessions, previewMigration, readSession, readableAgents, writableAgents } from '../src/main/services.ts';

test('capabilities：可读/可写 agent 列表', () => {
  assert.deepEqual(readableAgents().sort(), ['codex', 'command-code', 'dsh', 'kimi-code', 'opencode'].sort());
  assert.deepEqual(writableAgents().sort(), ['claude-code', 'command-code', 'codex', 'dsh', 'opencode'].sort());
});

test('listSessions 返回结构合法的行（无会话时也应是空数组）', async () => {
  const result = await listSessions();
  assert.ok(Array.isArray(result.sessions));
  assert.ok(Array.isArray(result.warnings));
  for (const row of result.sessions) {
    assert.ok(typeof row.agent === 'string' && row.agent.length > 0);
    assert.ok(typeof row.sessionId === 'string');
    assert.ok(typeof row.nativePath === 'string' && row.nativePath.length > 0);
    assert.equal(typeof row.readable, 'boolean');
  }
});

test('readSession：读一个真实 Codex 会话（没有样本时跳过）', async (t) => {
  const result = await listSessions();
  const codex = result.sessions.find((row) => row.agent === 'codex' && row.readable);
  if (!codex) {
    t.skip('本机没有 Codex 会话样本');
    return;
  }
  const read = await readSession('codex', { nativePath: codex.nativePath, sessionId: codex.sessionId }, 50);
  assert.ok(read.events.length > 0);
  assert.ok(read.events.every((event) => typeof event.id === 'string' && typeof event.at === 'string'));
  assert.equal(read.truncated, read.events.length === 50);
});

test('previewMigration：dryRun 只出损失清单，不落盘', async (t) => {
  const result = await listSessions();
  const source = result.sessions.find((row) => row.readable && row.agent === 'codex');
  if (!source) {
    t.skip('本机没有可读的 Codex 会话样本');
    return;
  }
  const preview = await previewMigration('codex', { nativePath: source.nativePath, sessionId: source.sessionId }, 'claude-code');
  assert.equal(preview.target, 'claude-code');
  assert.ok(preview.source.events > 0);
  assert.ok(Array.isArray(preview.losses));
  assert.ok(preview.losses.every((loss) => typeof loss.code === 'string' && typeof loss.message === 'string'));
});

test('readSession：没有 reader 的 agent 给出明确错误', async () => {
  await assert.rejects(() => readSession('kimi-code', { nativePath: '/nonexistent-kimi-session' }), /不是 Kimi 会话目录|ENOENT|不存在/);
});