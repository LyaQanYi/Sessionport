import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { validateIrBundle } from '@sessionport/core';

import { listCursorSessions, readCursorSession, resolveCursorSessionTarget } from '../src/index.ts';
import { createCursorFixture } from './helpers.ts';
import type { CursorFixture, FixtureComposerSpec } from './helpers.ts';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const OLD_ID = '33333333-3333-4333-8333-333333333333';
const ARCHIVED_ID = '44444444-4444-4444-8444-444444444444';

const BASE_MS = 1789214508000;

function mainComposer(): FixtureComposerSpec {
  return {
    composerId: ROOT_ID,
    name: 'SSH 会话',
    createdAtMs: BASE_MS,
    lastUpdatedAtMs: BASE_MS + 20000,
    subagentComposerIds: [CHILD_ID],
    bubbles: [
      { type: 1, text: '用 @id_ed25519 连接 ssh qianyi@110.42.250.98' },
      { type: 2, thinking: { text: '先定位密钥。' } },
      { type: 2, text: '先定位 `id_ed25519` 密钥。' },
      {
        type: 2,
        tool: {
          name: 'glob_file_search',
          toolCallId: 'call-1',
          params: { globPattern: '**/id_ed25519*' },
          result: { directories: [{ files: [{ relPath: './id_ed25519' }] }] },
          status: 'completed',
          tool: 42,
        },
      },
      { type: 2, empty: true },
      { type: 1, text: '继续' },
      { type: 2, text: '好的' },
      { type: 1, simulated: true, text: '<timestamp>后台任务完成</timestamp>' },
      { type: 1, text: '看图', images: [{ uuid: 'img-1', dimension: { width: 10, height: 10 } }] },
      { type: 2, interpreterResults: [{ exitCode: 0 }] },
    ],
  };
}

function allComposers(): FixtureComposerSpec[] {
  return [
    mainComposer(),
    {
      composerId: CHILD_ID,
      name: '子代理：找密钥',
      createdAtMs: BASE_MS + 30000,
      lastUpdatedAtMs: BASE_MS + 31000,
      subagent: { parentComposerId: ROOT_ID, subagentTypeName: 'general-purpose', toolCallId: 'call-1' },
      bubbles: [
        { type: 1, text: '子任务' },
        { type: 2, text: '子结果' },
      ],
    },
    {
      composerId: OLD_ID,
      name: '旧会话',
      createdAtMs: BASE_MS - 100000,
      lastUpdatedAtMs: BASE_MS - 90000,
      bubbles: [
        { type: 1, text: '旧问题' },
        { type: 2, text: '旧回答' },
      ],
    },
    {
      composerId: ARCHIVED_ID,
      name: '归档会话',
      isArchived: true,
      createdAtMs: BASE_MS - 200000,
      lastUpdatedAtMs: BASE_MS - 190000,
      bubbles: [{ type: 1, text: '归档问题' }],
    },
  ];
}

function setup(): CursorFixture {
  return createCursorFixture({ composers: allComposers() });
}

test('readCursorSession 把 composer/bubble 映射成 IR', async () => {
  const fixture = setup();
  try {
    const bundle = await readCursorSession(ROOT_ID, { home: fixture.home });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.id, 'cursor:' + ROOT_ID);
    assert.equal(bundle.root.source.agent, 'cursor');
    assert.equal(bundle.root.source.nativeSessionId, ROOT_ID);
    assert.equal(bundle.root.source.nativePath, fixture.dbPath);
    assert.equal(bundle.root.source.formatVersion, '18');
    assert.equal(bundle.root.meta.cwd, fixture.cwd);
    assert.equal(bundle.root.meta.title, 'SSH 会话');
    assert.equal(bundle.root.meta.model, 'grok-4.7');
    assert.equal(bundle.root.meta.profile, 'agent');
    assert.equal(bundle.root.meta.createdAt, new Date(BASE_MS).toISOString());
    assert.equal(bundle.root.meta.updatedAt, new Date(BASE_MS + 20000).toISOString());
    assert.equal(bundle.root.meta.lastPrompt, '看图');

    const kinds = bundle.root.events.map((event) => event.kind);
    assert.deepEqual(kinds, [
      'message',
      'reasoning',
      'message',
      'tool_call',
      'tool_result',
      'message',
      'message',
      'message',
      'message',
      'tool_result',
    ]);

    const first = bundle.root.events[0];
    assert.equal(first.kind, 'message');
    assert.equal(first.role, 'user');
    assert.equal(first.parts[0]?.type, 'text');

    const reasoning = bundle.root.events[1];
    assert.equal(reasoning.kind, 'reasoning');
    assert.equal(reasoning.reasoning.kind, 'plain');
    if (reasoning.reasoning.kind === 'plain') assert.equal(reasoning.reasoning.text, '先定位密钥。');

    const toolCall = bundle.root.events[3];
    assert.equal(toolCall.kind, 'tool_call');
    if (toolCall.kind === 'tool_call') {
      assert.equal(toolCall.name, 'glob_file_search');
      assert.equal(toolCall.callId, 'call-1');
      assert.deepEqual(toolCall.input, { globPattern: '**/id_ed25519*' });
    }

    const toolResult = bundle.root.events[4];
    assert.equal(toolResult.kind, 'tool_result');
    if (toolResult.kind === 'tool_result') {
      assert.equal(toolResult.callId, 'call-1');
      assert.equal(toolResult.content[0]?.type, 'json');
    }

    const synthetic = bundle.root.events[7];
    assert.equal(synthetic.kind, 'message');
    if (synthetic.kind === 'message') assert.equal(synthetic.synthetic, true);

    const imageMessage = bundle.root.events[8];
    assert.equal(imageMessage.kind, 'message');
    if (imageMessage.kind === 'message') {
      const image = imageMessage.parts.find((part) => part.type === 'image');
      assert.ok(image !== undefined);
    }

    const codes = new Map(bundle.root.notices.map((notice) => [notice.code, notice.count]));
    assert.equal(codes.get('cursor.empty-bubble'), 1);
    assert.equal(codes.get('cursor.thinking'), 1);
    assert.equal(codes.get('cursor.tool-bubbles'), 1);
    assert.equal(codes.get('cursor.image-metadata-only'), 1);
    assert.equal(codes.get('cursor.synthetic-user-message'), 1);
    assert.equal(codes.get('cursor.interpreter-results'), 1);

    assert.equal(bundle.children.length, 1);
    const child = bundle.children[0];
    assert.ok(child !== undefined);
    assert.equal(child.parentSessionId, ROOT_ID);
    assert.equal(child.label, 'general-purpose');
    assert.equal(child.viaToolCallId, 'call-1');
    assert.equal(child.session.events.length, 2);
    assert.deepEqual(validateIrBundle({ ...bundle, children: [child] }), []);
  } finally {
    fixture.cleanup();
  }
});

test('readCursorSession 支持 id 前缀、路径#id、last、关闭 children', async () => {
  const fixture = setup();
  try {
    const byPrefix = await readCursorSession(ROOT_ID.slice(0, 8), { home: fixture.home });
    assert.equal(byPrefix.root.source.nativeSessionId, ROOT_ID);

    const byPath = await readCursorSession(fixture.dbPath + '#' + ROOT_ID);
    assert.equal(byPath.root.source.nativeSessionId, ROOT_ID);

    const last = await readCursorSession('last', { home: fixture.home });
    assert.equal(last.root.source.nativeSessionId, ROOT_ID);

    const noChildren = await readCursorSession(ROOT_ID, { home: fixture.home, includeChildren: false });
    assert.equal(noChildren.children.length, 0);

    assert.throws(() => resolveCursorSessionTarget('not-a-session', { home: fixture.home }), /找不到 Cursor 会话/);
  } finally {
    fixture.cleanup();
  }
});

test('listCursorSessions 默认不含子代理、按更新时间倒序、带 archived/cwd/title', async () => {
  const fixture = setup();
  try {
    const rows = await listCursorSessions({ home: fixture.home });
    assert.deepEqual(
      rows.map((row) => row.sessionId),
      [ROOT_ID, OLD_ID, ARCHIVED_ID],
    );
    const root = rows[0];
    assert.ok(root !== undefined);
    assert.equal(root.agent, 'cursor');
    assert.equal(root.title, 'SSH 会话');
    assert.equal(root.cwd, fixture.cwd);
    assert.equal(root.archived, undefined);
    assert.equal(root.nativePath, fixture.dbPath);
    const archived = rows[2];
    assert.ok(archived !== undefined);
    assert.equal(archived.archived, true);

    const limited = await listCursorSessions({ home: fixture.home, limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.sessionId, ROOT_ID);

    const missing = await listCursorSessions({ home: join(fixture.home, 'nope') });
    assert.deepEqual(missing, []);
  } finally {
    fixture.cleanup();
  }
});

test('缺失气泡 / 坏 JSON / 缺 header 都只记 notice，不中断读取', async () => {
  const fixture = setup();
  try {
    const db = fixture.open();
    try {
      db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run('bubbleId:' + ROOT_ID + ':' + 'missing-never-existed');
      // 删掉第二个气泡（thinking）→ header 有、库里没有
      const dataRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composerData:' + ROOT_ID) as { value: string };
      const data = JSON.parse(dataRow.value) as { fullConversationHeadersOnly: Array<{ bubbleId: string }> };
      const secondId = data.fullConversationHeadersOnly[1]?.bubbleId;
      assert.ok(secondId !== undefined);
      db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run('bubbleId:' + ROOT_ID + ':' + secondId);
      // 把第一个用户气泡写成坏 JSON
      db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run('{not json', 'bubbleId:' + ROOT_ID + ':' + String(data.fullConversationHeadersOnly[0]?.bubbleId));
    } finally {
      db.close();
    }
    const bundle = await readCursorSession(ROOT_ID, { home: fixture.home });
    const codes = new Map(bundle.root.notices.map((notice) => [notice.code, notice.count]));
    assert.equal(codes.get('cursor.missing-bubble'), 1);
    assert.equal(codes.get('cursor.bad-bubble'), 1);
    assert.ok(bundle.root.events.length > 0);
  } finally {
    fixture.cleanup();
  }
});

test('旧版 ItemTable blob（无 composerHeaders 表）也能读', async () => {
  const fixture = createCursorFixture({ composers: allComposers(), legacyHeaderBlob: true });
  try {
    const rows = await listCursorSessions({ home: fixture.home });
    assert.equal(rows.length, 3);
    const bundle = await readCursorSession(ROOT_ID, { home: fixture.home });
    assert.equal(bundle.root.meta.title, 'SSH 会话');
    assert.equal(bundle.root.meta.cwd, fixture.cwd);
    assert.ok(bundle.root.events.length >= 8);
  } finally {
    fixture.cleanup();
  }
});

test('composerHeaders 行缺失时仍可从 composerData + bubbles 读取', async () => {
  const fixture = createCursorFixture({
    composers: [
      {
        composerId: ROOT_ID,
        name: '只有 composerData 的会话',
        createdAtMs: BASE_MS,
        lastUpdatedAtMs: BASE_MS + 1000,
        omitHeader: true,
        bubbles: [
          { type: 1, text: '问题' },
          { type: 2, text: '回答' },
        ],
      },
    ],
  });
  try {
    const bundle = await readCursorSession(ROOT_ID, { home: fixture.home });
    assert.equal(bundle.root.events.length, 2);
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'cursor.header-missing'));
    const rows = await listCursorSessions({ home: fixture.home });
    assert.deepEqual(rows, []);
  } finally {
    fixture.cleanup();
  }
});

test('空库/坏输入报错信息可读', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    await assert.rejects(() => readCursorSession('last', { home: fixture.home }), /没有任何 composer/);
    await assert.rejects(() => readCursorSession(ROOT_ID, { home: fixture.home }), /找不到 Cursor 会话/);
    await assert.rejects(
      () => readCursorSession(ROOT_ID, { home: fixture.home, dbPath: join(fixture.home, 'missing.vscdb') }),
      /找不到 Cursor 数据库/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('fixture 清理不残留临时目录', () => {
  const fixture = createCursorFixture({ composers: [] });
  const home = fixture.home;
  fixture.cleanup();
  assert.throws(() => rmSync(home, { recursive: false, force: false }));
});
