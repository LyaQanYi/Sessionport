import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listKimiSessions } from '../src/index.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-kimi-list-'));
}

function writeSession(home: string, wd: string, id: string, state: Record<string, unknown>): string {
  const dir = join(home, 'sessions', wd, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return dir;
}

test('kimi list: 从 state.json 读 id/title/cwd/时间/归档', async () => {
  const home = makeHome();
  try {
    const dir = writeSession(home, 'wd_demo_1234', 'session_alpha', {
      id: 'session_alpha',
      version: 2,
      cwd: '/tmp/kimi-proj',
      createdAt: 1700000000000,
      updatedAt: 1700000060000,
      title: 'Kimi 标题',
      archived: false,
    });
    const sessions = await listKimiSessions({ home });
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.agent, 'kimi-code');
    assert.equal(session.sessionId, 'session_alpha');
    assert.equal(session.title, 'Kimi 标题');
    assert.equal(session.cwd, '/tmp/kimi-proj');
    assert.equal(session.createdAt, new Date(1700000000000).toISOString());
    assert.equal(session.updatedAt, new Date(1700000060000).toISOString());
    assert.equal(session.nativePath, dir);
    assert.equal(session.resumeHint, 'kimi --session session_alpha');
    assert.equal(session.archived, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('kimi list: 无标题用 lastPrompt 兜底，索引兜底 cwd，坏 state.json 跳过', async () => {
  const home = makeHome();
  try {
    writeSession(home, 'wd_demo_1234', 'session_alpha', {
      id: 'session_alpha',
      version: 2,
      cwd: '/tmp/kimi-proj',
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      lastPrompt: '帮我看看这个项目\n第二行',
    });
    const missingCwdDir = writeSession(home, 'wd_demo_1234', 'session_beta', {
      id: 'session_beta',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000002000,
      title: '索引兜底',
      archived: true,
    });
    // 索引提供 workDir
    writeFileSync(
      join(home, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_beta', sessionDir: missingCwdDir, workDir: '/tmp/index-proj' }) + '\n',
    );
    // 坏文件
    const badDir = join(home, 'sessions', 'wd_demo_1234', 'session_bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'state.json'), '{not json');

    const sessions = await listKimiSessions({ home });
    assert.deepEqual(sessions.map((item) => item.sessionId), ['session_beta', 'session_alpha']);
    const alpha = sessions.find((item) => item.sessionId === 'session_alpha')!;
    assert.equal(alpha.title, '帮我看看这个项目 第二行');
    const beta = sessions.find((item) => item.sessionId === 'session_beta')!;
    assert.equal(beta.cwd, '/tmp/index-proj');
    assert.equal(beta.archived, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('kimi list: 目录不存在返回 []，limit 生效', async () => {
  const home = makeHome();
  try {
    assert.deepEqual(await listKimiSessions({ home: join(home, 'nope') }), []);
    for (const index of [1, 2, 3]) {
      writeSession(home, 'wd_demo_1234', 'session_' + index, {
        id: 'session_' + index,
        version: 2,
        createdAt: 1700000000000,
        updatedAt: 1700000000000 + index * 1000,
        title: '会话' + index,
      });
    }
    const sessions = await listKimiSessions({ home, limit: 2 });
    assert.deepEqual(sessions.map((item) => item.sessionId), ['session_3', 'session_2']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
