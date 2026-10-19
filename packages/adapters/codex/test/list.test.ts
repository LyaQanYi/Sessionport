import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listCodexSessions } from '../src/index.ts';

const UUID = '01234567-89ab-4cde-8f01-23456789abcd';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-codex-list-'));
}

function writeRollout(home: string, lines: unknown[], name = 'rollout-2026-10-16T14-40-28-' + UUID + '.jsonl'): string {
  const dir = join(home, 'sessions', '2026', '10', '16');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

test('codex list: 索引标题 + session_meta 的 cwd/时间 + 兼容字段', async () => {
  const home = makeHome();
  try {
    const filePath = writeRollout(home, [
      {
        timestamp: '2026-10-16T06:40:51.538Z',
        type: 'session_meta',
        payload: { session_id: UUID, id: UUID, timestamp: '2026-10-16T06:40:28.401Z', cwd: '/tmp/codex-proj' },
      },
    ]);
    writeFileSync(
      join(home, 'session_index.jsonl'),
      JSON.stringify({ id: UUID, thread_name: 'Codex 标题', updated_at: '2026-10-16T06:41:00.284497Z' }) + '\n',
    );
    const sessions = await listCodexSessions({ home });
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.agent, 'codex');
    assert.equal(session.sessionId, UUID);
    assert.equal(session.id, UUID); // 兼容字段
    assert.equal(session.nativePath, filePath);
    assert.equal(session.path, filePath); // 兼容字段
    assert.equal(session.title, 'Codex 标题');
    assert.equal(session.cwd, '/tmp/codex-proj');
    assert.equal(session.createdAt, '2026-10-16T06:40:28.401Z');
    assert.equal(session.updatedAt, '2026-10-16T06:41:00.284Z');
    assert.equal(session.resumeHint, 'codex exec resume ' + UUID);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex list: 无索引时首条非注入 user 文本兜底；坏 rollout 跳过', async () => {
  const home = makeHome();
  try {
    writeRollout(home, [
      { timestamp: '2026-10-16T06:40:51.538Z', type: 'session_meta', payload: { session_id: UUID, id: UUID, cwd: '/tmp/codex-proj' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/codex-proj' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实需求：迁移 Codex 会话' }] },
      },
    ]);
    const sessions = await listCodexSessions({ home });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.title, '真实需求：迁移 Codex 会话');
    assert.equal(sessions[0]!.updatedAt !== undefined, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex list: 目录不存在返回 []，limit 生效', async () => {
  const home = makeHome();
  try {
    assert.deepEqual(await listCodexSessions({ home: join(home, 'nope') }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
