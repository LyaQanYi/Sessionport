import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { validateIrBundle } from '@sessionport/core';

import { listCodexSessions, readCodexSession } from '../src/index.ts';

const UUID = '01234567-89ab-4cde-8f01-23456789abcd';
const SEG2_UUID = '99999999-89ab-4cde-8f01-23456789abcd';
const CHILD_UUID = '22222222-89ab-4cde-8f01-23456789abcd';
const GUARDIAN_UUID = '33333333-89ab-4cde-8f01-23456789abcd';
const ARCHIVED_UUID = '44444444-89ab-4cde-8f01-23456789abcd';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-codex-list-'));
}

function writeRollout(home: string, lines: unknown[], name = 'rollout-2026-10-16T14-40-28-' + UUID + '.jsonl', rootDir = 'sessions'): string {
  const dir = join(home, rootDir, '2026', '10', '16');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  writeFileSync(filePath, name.endsWith('.zst') ? zstdCompressSync(Buffer.from(text, 'utf8')) : text);
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

test('codex list/read: 支持 .jsonl.zst、分页段合并去重、archived_sessions 与子代理过滤/挂载', async () => {
  const home = makeHome();
  try {
    // 1. 多段 paginated .jsonl.zst（ordinal 1..2 重叠去重）
    writeRollout(
      home,
      [
        { timestamp: '2026-10-16T06:40:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: UUID, cwd: '/tmp/paginated', originator: 'Codex Desktop', history_mode: 'paginated' } },
        { timestamp: '2026-10-16T06:40:01.000Z', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一段问题' }] } },
        { timestamp: '2026-10-16T06:40:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一段回答' }] } },
      ],
      'rollout-2026-10-16T14-40-00-' + UUID + '.jsonl.zst',
    );
    writeRollout(
      home,
      [
        { timestamp: '2026-10-16T06:40:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一段回答' }] } },
        { timestamp: '2026-10-16T06:40:03.000Z', ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二段追问' }] } },
      ],
      'rollout-2026-10-16T14-45-00-' + UUID + '_' + SEG2_UUID + '.jsonl.zst',
    );

    // 2. spawned subagent（session_meta.session_id 指向父会话）与 guardian review
    writeRollout(
      home,
      [
        {
          timestamp: '2026-10-16T06:41:00.000Z',
          type: 'session_meta',
          payload: {
            session_id: UUID,
            cwd: '/tmp/paginated',
            thread_source: 'subagent',
            source: { subagent: { thread_spawn: { parent_thread_id: UUID, depth: 1, agent_nickname: 'Gauss' } } },
          },
        },
        { timestamp: '2026-10-16T06:41:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '子任务' }] } },
      ],
      'rollout-2026-10-16T14-41-00-' + CHILD_UUID + '.jsonl.zst',
    );
    writeRollout(
      home,
      [
        { timestamp: '2026-10-16T06:42:00.000Z', type: 'session_meta', payload: { session_id: GUARDIAN_UUID, cwd: '/tmp/paginated', thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } } },
        { timestamp: '2026-10-16T06:42:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review' }] } },
      ],
      'rollout-2026-10-16T14-42-00-' + GUARDIAN_UUID + '.jsonl.zst',
    );

    // 3. archived_sessions 里的 zst 会话
    writeRollout(
      home,
      [
        { timestamp: '2026-10-15T06:00:00.000Z', type: 'session_meta', payload: { session_id: ARCHIVED_UUID, cwd: '/tmp/archived' } },
        { timestamp: '2026-10-15T06:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '归档对话' }] } },
      ],
      'rollout-2026-10-15T14-00-00-' + ARCHIVED_UUID + '.jsonl.zst',
      'archived_sessions',
    );

    // state_5.sqlite 自定义线程标题（时间晚于 mtime，确保排在归档会话前）
    const newerMs = Date.now() + 60_000;
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(UUID, '分页主线程标题', '第一段问题', '/tmp/paginated', 'user', 'vscode', 0, newerMs - 5000, newerMs);
    db.close();

    const defaultList = await listCodexSessions({ home });
    assert.deepEqual(defaultList.map((item) => item.sessionId), [UUID, ARCHIVED_UUID]);
    assert.equal(defaultList[0]!.title, '分页主线程标题');
    assert.equal(defaultList[1]!.archived, true);

    const withChildren = await listCodexSessions({ home, includeChildren: true });
    assert.equal(withChildren.length, 3);
    const childRow = withChildren.find((item) => item.sessionId === CHILD_UUID);
    assert.equal(childRow?.parentSessionId, UUID);
    assert.ok(childRow?.title?.includes('Gauss'));
    assert.equal(withChildren.find((item) => item.sessionId === GUARDIAN_UUID), undefined);

    const bundle = await readCodexSession(UUID, { home });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.meta.title, '分页主线程标题');
    assert.equal(bundle.root.events.length, 3); // 去重后：问题1 + 回答1 + 追问2
    assert.equal(bundle.children.length, 1);
    assert.equal(bundle.children[0]!.label, 'Gauss');
    assert.equal(bundle.children[0]!.session.source.nativeSessionId, CHILD_UUID);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
