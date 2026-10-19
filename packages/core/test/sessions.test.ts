import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SESSION_LIMIT, finalizeSessionList, listAllSessions } from '../src/index.ts';
import type { SessionSummary } from '../src/index.ts';

function row(agent: SessionSummary['agent'], sessionId: string, updatedAt?: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  const summary: SessionSummary = { agent, sessionId, nativePath: '/tmp/' + sessionId };
  if (updatedAt !== undefined) summary.updatedAt = updatedAt;
  return { ...summary, ...extra };
}

test('finalizeSessionList: updatedAt 倒序，缺时间的排最后，limit 截断', () => {
  const sorted = finalizeSessionList([
    row('codex', 'old', '2026-01-01T00:00:00.000Z'),
    row('dsh', 'none'),
    row('dsh', 'new', '2026-03-01T00:00:00.000Z'),
  ]);
  assert.deepEqual(sorted.map((item) => item.sessionId), ['new', 'old', 'none']);
  assert.deepEqual(finalizeSessionList(sorted, 2).map((item) => item.sessionId), ['new', 'old']);
});

test('listAllSessions: 聚合多家、按 updatedAt 倒序并应用 limit', async () => {
  const result = await listAllSessions({
    agents: ['codex', 'dsh'],
    limit: 2,
    loaders: {
      codex: async () => [row('codex', 'c-old', '2026-01-01T00:00:00.000Z'), row('codex', 'c-new', '2026-02-01T00:00:00.000Z')],
      dsh: async () => [row('dsh', 'd-mid', '2026-01-15T00:00:00.000Z')],
    },
  });
  assert.deepEqual(result.sessions.map((item) => item.sessionId), ['c-new', 'd-mid']);
  assert.deepEqual(result.warnings, []);
  // agent 字段以请求的 agent 为准，且时间被规范成 ISO
  assert.ok(result.sessions.every((item) => item.agent === 'codex' || item.agent === 'dsh'));
});

test('listAllSessions: 单家抛错只记 warning，不阻断其它家', async () => {
  const result = await listAllSessions({
    agents: ['codex', 'dsh'],
    loaders: {
      codex: async () => {
        throw new Error('模拟读取失败');
      },
      dsh: async () => [row('dsh', 'ok', '2026-02-01T00:00:00.000Z')],
    },
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]!.sessionId, 'ok');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /codex: 读取会话列表失败/);
  assert.match(result.warnings[0]!, /模拟读取失败/);
});

test('listAllSessions: 默认 limit 200，非法 limit 回退默认', async () => {
  const many = Array.from({ length: DEFAULT_SESSION_LIMIT + 50 }, (_, index) =>
    row('codex', 's' + index, new Date(1800000000000 - index * 1000).toISOString()),
  );
  const result = await listAllSessions({ agents: ['codex'], loaders: { codex: async () => many } });
  assert.equal(result.sessions.length, DEFAULT_SESSION_LIMIT);

  const zero = await listAllSessions({ agents: ['codex'], limit: 0, loaders: { codex: async () => many.slice(0, 3) } });
  assert.equal(zero.sessions.length, 3);
});

test('listAllSessions: 丢掉缺 sessionId/nativePath 的坏行，未知 agent 记 warning', async () => {
  const result = await listAllSessions({
    agents: ['codex'],
    loaders: {
      codex: async () =>
        [
          row('codex', 'good', '2026-01-01T00:00:00.000Z'),
          { agent: 'codex', sessionId: '', nativePath: '/tmp/x' } as SessionSummary,
          { agent: 'codex', sessionId: 'no-path', nativePath: '' } as SessionSummary,
        ] as SessionSummary[],
    },
  });
  assert.deepEqual(result.sessions.map((item) => item.sessionId), ['good']);
});

test('listAllSessions: 内置 lister 端到端（Kimi 临时 fixture）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sessionport-core-list-'));
  try {
    const sessionDir = join(home, 'sessions', 'wd_demo_abc', 'session_core');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'state.json'),
      JSON.stringify({ id: 'session_core', version: 2, cwd: '/tmp/core-proj', createdAt: 1700000000000, updatedAt: 1700000060000, title: '核心聚合测试' }),
    );
    writeFileSync(
      join(home, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_core', sessionDir, workDir: '/tmp/core-proj' }) + '\n',
    );

    const result = await listAllSessions({ agents: ['kimi-code'], homes: { 'kimi-code': home } });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.agent, 'kimi-code');
    assert.equal(session.sessionId, 'session_core');
    assert.equal(session.title, '核心聚合测试');
    assert.equal(session.cwd, '/tmp/core-proj');
    assert.equal(session.createdAt, new Date(1700000000000).toISOString());
    assert.equal(session.updatedAt, new Date(1700000060000).toISOString());
    assert.equal(session.nativePath, sessionDir);
    assert.ok(session.resumeHint?.includes('session_core'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
