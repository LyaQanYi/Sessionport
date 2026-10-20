import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURSOR_CAPS,
  countCursorTarget,
  readCursorSession,
  verifyCursorSession,
  writeCursorSession,
} from '../src/index.ts';
import { closeCursorDb, openCursorDb, readDiskKvValue } from '../src/wire.ts';
import {
  assistantMessage,
  createCursorFixture,
  makeIrBundle,
  reasoningEvent,
  toolCallEvent,
  toolResultEvent,
  userMessage,
} from './helpers.ts';

const ROOT_ID = '55555555-5555-4555-8555-555555555555';
const NEW_ID = '66666666-6666-4666-8666-666666666666';
const BASE_MS = 1789214508000;

function sampleBundle(cwd: string) {
  return makeIrBundle(
    [
      userMessage('把这段对话搬到 Cursor', new Date(BASE_MS).toISOString()),
      reasoningEvent('先看结构', new Date(BASE_MS + 500).toISOString()),
      assistantMessage('好的，我来整理。', new Date(BASE_MS + 1000).toISOString()),
      toolCallEvent('call-1', 'Bash', { command: 'ls' }, new Date(BASE_MS + 1500).toISOString()),
      toolResultEvent('call-1', 'file.txt', new Date(BASE_MS + 2000).toISOString()),
      {
        kind: 'message',
        role: 'user',
        synthetic: true,
        parts: [{ type: 'text', text: '<system_reminder>注入</system_reminder>' }],
        at: new Date(BASE_MS + 2500).toISOString(),
      },
      { kind: 'boundary', boundary: 'compact', at: new Date(BASE_MS + 2600).toISOString() },
    ],
    { cwd, title: '搬迁测试' },
  );
}

test('dryRun 只算不写：不产生数据、不产生备份', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const backupDir = join(fixture.home, 'backup');
    const result = await writeCursorSession(sampleBundle(fixture.cwd), {
      home: fixture.home,
      dryRun: true,
      composerId: NEW_ID,
      backupDir,
      model: 'gpt-5',
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.composerId, NEW_ID);
    assert.equal(result.rows.length, 5); // header + composerData + 3 bubbles
    assert.equal(result.backupPath, undefined);
    const db = openCursorDb(fixture.dbPath, { readOnly: true });
    try {
      const headerCount = (db.prepare('SELECT count(*) AS c FROM composerHeaders').get() as { c: number }).c;
      assert.equal(headerCount, 0);
      assert.equal(readDiskKvValue(db, 'composerData:' + NEW_ID), undefined);
    } finally {
      closeCursorDb(db);
    }
    assert.equal(existsSync(backupDir), false);
  } finally {
    fixture.cleanup();
  }
});

test('写入新 composer：只新增 key，不修改已有会话', async () => {
  const fixture = createCursorFixture({
    composers: [
      {
        composerId: ROOT_ID,
        name: '已有会话',
        createdAtMs: BASE_MS - 100000,
        lastUpdatedAtMs: BASE_MS - 90000,
        bubbles: [
          { type: 1, text: '已有问题' },
          { type: 2, text: '已有回答' },
        ],
      },
    ],
  });
  try {
    const before = snapshot(fixture.dbPath);
    const backupDir = join(fixture.home, 'backup');
    const result = await writeCursorSession(sampleBundle(fixture.cwd), {
      home: fixture.home,
      composerId: NEW_ID,
      backupDir,
      model: 'gpt-5',
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.sessionId, NEW_ID);
    assert.equal(result.workspaceId, 'ws-test');
    assert.equal(result.cwd, fixture.cwd);
    assert.equal(result.title, '搬迁测试');
    assert.equal(result.rows.filter((row) => row.kind === 'header').length, 1);
    assert.equal(result.rows.filter((row) => row.kind === 'composerData').length, 1);
    assert.equal(result.rows.filter((row) => row.kind === 'bubble').length, 3);
    assert.equal(result.caps, CURSOR_CAPS);
    assert.equal(CURSOR_CAPS.agent, 'cursor');

    const losses = new Set(result.losses.map((loss) => loss.code));
    for (const code of [
      'cursor.synthetic-user-dropped',
      'cursor.tool-call-dropped',
      'cursor.tool-result-dropped',
      'cursor.boundary-dropped',
      'cursor.cross-agent-import',
    ]) {
      assert.ok(losses.has(code), 'missing loss ' + code);
    }

    assert.ok(result.backupPath !== undefined);
    assert.ok(existsSync(result.backupPath));
    const backup = JSON.parse(readFileSync(result.backupPath, 'utf8')) as {
      planned: Array<{ key: string }>;
      existing: Record<string, unknown>;
    };
    assert.equal(backup.planned.length, 5);
    assert.deepEqual(backup.existing, {});

    const after = snapshot(fixture.dbPath);
    for (const [key, value] of before.kv) {
      assert.equal(after.kv.get(key), value, '已存在的 cursorDiskKV key 被改动: ' + key);
    }
    for (const [composerId, value] of before.headers) {
      assert.equal(after.headers.get(composerId), value, '已存在的 composerHeaders 行被改动: ' + composerId);
    }
    assert.equal(after.kv.size, before.kv.size + 4);
    assert.equal(after.headers.size, before.headers.size + 1);

    // 结构 + 读回
    const report = await verifyCursorSession({
      home: fixture.home,
      sessionId: NEW_ID,
      expected: { bubbles: 3, eventCount: 3, userMessages: 1, assistantMessages: 1 },
    });
    assert.deepEqual(
      report.checks.filter((check) => !check.ok),
      [],
    );
    assert.equal(report.ok, true);
    assert.equal(report.bubbles, 3);

    const bundle = await readCursorSession(NEW_ID, { home: fixture.home, includeChildren: false });
    assert.equal(bundle.root.meta.title, '搬迁测试');
    assert.equal(bundle.root.meta.cwd, fixture.cwd);
    assert.equal(bundle.root.meta.model, 'gpt-5');
    assert.deepEqual(
      bundle.root.events.map((event) => event.kind),
      ['message', 'reasoning', 'message'],
    );
    const counts = await countCursorTarget({ home: fixture.home, sessionId: NEW_ID });
    assert.deepEqual(counts, { exists: true, units: 3 });
  } finally {
    fixture.cleanup();
  }
});

test('composerId 冲突时拒绝覆盖，且不写入任何东西', async () => {
  const fixture = createCursorFixture({
    composers: [
      {
        composerId: NEW_ID,
        name: '占位会话',
        createdAtMs: BASE_MS - 10000,
        lastUpdatedAtMs: BASE_MS - 5000,
        bubbles: [{ type: 1, text: '占位' }],
      },
    ],
  });
  try {
    const before = snapshot(fixture.dbPath);
    await assert.rejects(
      () =>
        writeCursorSession(sampleBundle(fixture.cwd), {
          home: fixture.home,
          composerId: NEW_ID,
          backupDir: join(fixture.home, 'backup'),
        }),
      /目标 key 已存在/,
    );
    const after = snapshot(fixture.dbPath);
    assert.deepEqual([...after.kv.entries()], [...before.kv.entries()]);
    assert.deepEqual([...after.headers.entries()], [...before.headers.entries()]);
  } finally {
    fixture.cleanup();
  }
});

test('keepSynthetic 可保留源端注入消息', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const result = await writeCursorSession(sampleBundle(fixture.cwd), {
      home: fixture.home,
      composerId: NEW_ID,
      backupDir: join(fixture.home, 'backup'),
      keepSynthetic: true,
    });
    assert.equal(result.written.events, 4);
    assert.ok(!result.losses.some((loss) => loss.code === 'cursor.synthetic-user-dropped'));
  } finally {
    fixture.cleanup();
  }
});

test('没有可写消息时直接报错', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle([{ kind: 'boundary', boundary: 'undo', at: new Date(BASE_MS).toISOString() }]);
    await assert.rejects(
      () => writeCursorSession(bundle, { home: fixture.home, composerId: NEW_ID, backupDir: join(fixture.home, 'backup') }),
      /没有可写入的消息/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('verify 能发现被破坏的气泡', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const result = await writeCursorSession(sampleBundle(fixture.cwd), {
      home: fixture.home,
      composerId: NEW_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const db = openCursorDb(fixture.dbPath);
    try {
      const bubble = result.rows.find((row) => row.kind === 'bubble');
      assert.ok(bubble !== undefined);
      db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(bubble.key);
    } finally {
      closeCursorDb(db);
    }
    const report = await verifyCursorSession({ home: fixture.home, sessionId: NEW_ID });
    assert.equal(report.ok, false);
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.ok(failed.includes('bubbles-complete'), failed.join(','));
  } finally {
    fixture.cleanup();
  }
});

function snapshot(dbPath: string): {
  kv: Map<string, string>;
  headers: Map<string, string>;
} {
  const db = openCursorDb(dbPath, { readOnly: true });
  try {
    const kv = new Map<string, string>();
    for (const row of db.prepare('SELECT key, value FROM cursorDiskKV ORDER BY key').all() as Array<{
      key: string;
      value: unknown;
    }>) {
      kv.set(row.key, String(row.value));
    }
    const headers = new Map<string, string>();
    for (const row of db.prepare('SELECT composerId, value FROM composerHeaders ORDER BY composerId').all() as Array<{
      composerId: string;
      value: unknown;
    }>) {
      headers.set(row.composerId, String(row.value));
    }
    return { kv, headers };
  } finally {
    closeCursorDb(db);
  }
}

test('默认 recency=写入时刻（列表顶部），preserveUpdatedAt 保留源时间', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const before = Date.now();
    const freshId = '77777777-7777-4777-8777-777777777777';
    const fresh = await writeCursorSession(sampleBundle(fixture.cwd), {
      home: fixture.home,
      composerId: freshId,
      backupDir: join(fixture.home, 'backup'),
    });
    assert.equal(fresh.header.lastUpdatedAt, fresh.composerData.lastUpdatedAt);
    const db = openCursorDb(fixture.dbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT recency, lastUpdatedAt, createdAt, value FROM composerHeaders WHERE composerId = ?')
        .get(freshId) as { recency: number; lastUpdatedAt: number; createdAt: number; value: string };
      assert.ok(row.recency >= before, 'recency 应不小于写入前的时刻: ' + String(row.recency));
      assert.ok(row.recency <= Date.now() + 2000, 'recency 不应是未来时间: ' + String(row.recency));
      assert.equal(row.lastUpdatedAt, row.recency);
      // header 的 createdAt 仍是源会话开始时间（2026-09-24），消息 createdAt 也保留源时间
      assert.ok(row.createdAt < row.recency);
      const headerValue = JSON.parse(row.value) as { lastUpdatedAt: number; createdAt: number };
      assert.equal(headerValue.lastUpdatedAt, row.recency);
      assert.equal(headerValue.createdAt, row.createdAt);
    } finally {
      closeCursorDb(db);
    }

    const preservedId = '88888888-8888-4888-8888-888888888888';
    const preserved = await writeCursorSession(sampleBundle(fixture.cwd), {
      home: fixture.home,
      composerId: preservedId,
      backupDir: join(fixture.home, 'backup'),
      preserveUpdatedAt: true,
    });
    assert.equal(preserved.header.lastUpdatedAt, BASE_MS + 1000);
    const db2 = openCursorDb(fixture.dbPath, { readOnly: true });
    try {
      const row = db2.prepare('SELECT recency FROM composerHeaders WHERE composerId = ?').get(preservedId) as {
        recency: number;
      };
      assert.equal(row.recency, BASE_MS + 1000);
    } finally {
      closeCursorDb(db2);
    }
  } finally {
    fixture.cleanup();
  }
});
