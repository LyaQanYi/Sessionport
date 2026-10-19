import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listCommandCodeSessions } from '../src/index.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-cc-list-'));
}

function writeTranscript(home: string, slug: string, id: string, lines: unknown[], meta?: Record<string, unknown>): string {
  const dir = join(home, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, id + '.jsonl');
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  if (meta !== undefined) writeFileSync(join(dir, id + '.meta.json'), JSON.stringify(meta));
  return filePath;
}

test('cc list: 头行 cwd/createdAt + meta.title + mtime updatedAt', async () => {
  const home = makeHome();
  try {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const filePath = writeTranscript(
      home,
      'users-x-demo',
      id,
      [
        { type: 'session', version: 3, id, timestamp: '2026-10-01T00:00:00.000Z', cwd: '/tmp/cc-proj' },
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: '2026-10-01T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: '第一句用户消息' }] },
        },
      ],
      { entrypoint: 'cli', traceIds: [], title: 'CC 标题' },
    );
    const sessions = await listCommandCodeSessions({ home });
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.agent, 'command-code');
    assert.equal(session.sessionId, id);
    assert.equal(session.title, 'CC 标题');
    assert.equal(session.cwd, '/tmp/cc-proj');
    assert.equal(session.createdAt, '2026-10-01T00:00:00.000Z');
    assert.match(session.updatedAt!, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(session.nativePath, filePath);
    assert.equal(session.resumeHint, 'command-code -p --session ' + filePath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cc list: 无 meta.title 时取首条真实 user 文本；meta-only 会话不列出', async () => {
  const home = makeHome();
  try {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeTranscript(home, 'users-x-demo', id, [
      { type: 'session', version: 3, id, timestamp: '2026-10-01T00:00:00.000Z', cwd: '/tmp/cc-proj' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-10-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入内容</system-reminder>' }] },
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-10-01T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '真实需求：迁移会话' }] },
      },
    ]);
    // 只有 meta、没有 transcript 的会话不带可 resume 内容，不列出
    writeFileSync(join(home, 'projects', 'users-x-demo', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.meta.json'), JSON.stringify({ title: '空会话' }));

    const sessions = await listCommandCodeSessions({ home });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.title, '真实需求：迁移会话');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cc list: 非 v3 头文件跳过、目录不存在返回 []、limit 生效', async () => {
  const home = makeHome();
  try {
    assert.deepEqual(await listCommandCodeSessions({ home: join(home, 'nope') }), []);
    writeTranscript(home, 'users-x-demo', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [{ type: 'not-session' }]);
    assert.deepEqual(await listCommandCodeSessions({ home }), []);

    for (const index of [1, 2, 3]) {
      const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee' + index;
      writeTranscript(
        home,
        'users-x-demo',
        id,
        [{ type: 'session', version: 3, id, timestamp: '2026-10-01T00:00:00.000Z', cwd: '/tmp/cc-proj' }],
        { title: '会话' + index },
      );
      utimesSync(join(home, 'projects', 'users-x-demo', id + '.jsonl'), new Date(1700000000000 + index * 1000), new Date(1700000000000 + index * 1000));
    }
    const sessions = await listCommandCodeSessions({ home, limit: 2 });
    assert.deepEqual(
      sessions.map((item) => item.title),
      ['会话3', '会话2'],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
