import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listWorkBuddySessions, readWorkBuddySession, verifyWorkBuddySession } from '../src/index.ts';
import { WB_CWD, WB_SESSION_ID, wbTranscriptLines, writeWorkBuddyFixture } from './fixtures.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-wb-list-'));
}

function createDb(home: string): DatabaseSync {
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    title TEXT,
    custom_title TEXT,
    status TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    last_activity_at INTEGER,
    deleted_at INTEGER,
    model TEXT,
    mode TEXT,
    transport TEXT
  )`);
  return db;
}

test('WorkBuddy list: 文件为主表，DB 补 title/cwd/时间/archived', async () => {
  const home = makeHome();
  try {
    writeWorkBuddyFixture(home);
    const otherId = '33333333-3333-4333-8333-333333333333';
    writeWorkBuddyFixture(home, {
      sessionId: otherId,
      lines: wbTranscriptLines().map((line) => ({ ...line, sessionId: otherId, aiTitle: '另一个会话' })),
    });
    const db = createDb(home);
    db.prepare('INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, last_activity_at, deleted_at, model, mode, transport) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      WB_SESSION_ID,
      WB_CWD,
      'DB 标题',
      '自定义标题',
      'completed',
      1790000000000,
      1790000100000,
      1790000090000,
      1790000200000,
      'step-5-preview',
      'craft',
      'local',
    );
    db.close();

    const sessions = await listWorkBuddySessions({ home });
    assert.equal(sessions.length, 2);
    const main = sessions.find((session) => session.sessionId === WB_SESSION_ID)!;
    assert.equal(main.agent, 'workbuddy');
    assert.equal(main.title, '自定义标题');
    assert.equal(main.cwd, WB_CWD);
    assert.equal(main.createdAt, new Date(1790000000000).toISOString());
    assert.equal(main.updatedAt, new Date(1790000100000).toISOString());
    assert.equal(main.archived, true);
    assert.equal(main.nativePath, join(home, 'projects', '-tmp-wb-project', WB_SESSION_ID + '.jsonl'));

    const other = sessions.find((session) => session.sessionId === otherId)!;
    assert.equal(other.title, '另一个会话');
    assert.equal(other.cwd, WB_CWD);
    assert.equal(other.archived, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('WorkBuddy list: 没有 DB 时退回文件头；limit 生效', async () => {
  const home = makeHome();
  try {
    writeWorkBuddyFixture(home);
    const sessions = await listWorkBuddySessions({ home });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.title, 'WorkBuddy 测试会话');
    assert.equal(sessions[0]!.cwd, WB_CWD);
    assert.equal((await listWorkBuddySessions({ home, limit: 1 })).length, 1);
    assert.deepEqual(await listWorkBuddySessions({ home: join(home, 'missing') }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const realHome = process.env.SESSIONPORT_WORKBUDDY_HOME;

test('WorkBuddy list/read: 真实目录（SESSIONPORT_WORKBUDDY_HOME 门控）', { skip: realHome === undefined }, async () => {
  const sessions = await listWorkBuddySessions({ home: realHome });
  assert.ok(sessions.length > 0);
  const first = sessions[0]!;
  assert.equal(first.agent, 'workbuddy');
  const bundle = await readWorkBuddySession(first.sessionId, { home: realHome });
  assert.ok(bundle.root.events.length > 0);
  const report = await verifyWorkBuddySession(first.sessionId, { home: realHome });
  assert.equal(report.ok, true, report.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
});
