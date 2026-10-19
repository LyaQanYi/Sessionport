import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listOpencodeSessions } from '../src/index.ts';

const SESSION_SCHEMA = `CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  slug TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  time_created INTEGER NOT NULL DEFAULT 0,
  time_updated INTEGER NOT NULL DEFAULT 0,
  time_archived INTEGER
)`;

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-oc-list-'));
}

function createDb(home: string): DatabaseSync {
  return new DatabaseSync(join(home, 'opencode.db'));
}

function insertSession(
  db: DatabaseSync,
  row: { id: string; title: string; directory: string; created: number; updated: number; parentId?: string | null; archived?: number | null },
): void {
  db.prepare('INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    row.id,
    row.title,
    row.directory,
    row.created,
    row.updated,
    row.parentId ?? null,
    row.archived ?? null,
  );
}

test('opencode list: 只读 session 表，按 updatedAt 倒序', async () => {
  const home = makeHome();
  try {
    const db = createDb(home);
    db.exec(SESSION_SCHEMA);
    insertSession(db, {
      id: 'ses_old0000000000000000000001',
      title: '旧会话',
      directory: '/tmp/oc-proj',
      created: 1700000000000,
      updated: 1700000001000,
    });
    insertSession(db, {
      id: 'ses_new0000000000000000000002',
      title: '新会话',
      directory: '/tmp/oc-proj',
      created: 1700000002000,
      updated: 1700000003000,
      parentId: 'ses_old0000000000000000000001',
      archived: 1700000004000,
    });
    db.close();

    const sessions = await listOpencodeSessions({ home });
    assert.equal(sessions.length, 2);
    const [newest, older] = sessions;
    assert.equal(newest!.agent, 'opencode');
    assert.equal(newest!.sessionId, 'ses_new0000000000000000000002');
    assert.equal(newest!.title, '新会话');
    assert.equal(newest!.cwd, '/tmp/oc-proj');
    assert.equal(newest!.createdAt, new Date(1700000002000).toISOString());
    assert.equal(newest!.updatedAt, new Date(1700000003000).toISOString());
    assert.equal(newest!.nativePath, join(home, 'opencode.db'));
    assert.equal(newest!.resumeHint, 'opencode run --session ses_new0000000000000000000002');
    assert.equal(newest!.parentSessionId, 'ses_old0000000000000000000001');
    assert.equal(newest!.archived, true);
    assert.equal(older!.archived, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('opencode list: db 不存在 / 没有 session 表返回 []', async () => {
  const home = makeHome();
  try {
    assert.deepEqual(await listOpencodeSessions({ home }), []);
    const db = createDb(home);
    db.exec('CREATE TABLE unrelated (id TEXT)');
    db.close();
    assert.deepEqual(await listOpencodeSessions({ home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('opencode list: limit 生效，dbPath 可直接指定', async () => {
  const home = makeHome();
  try {
    const db = createDb(home);
    db.exec(SESSION_SCHEMA);
    for (const index of [1, 2, 3]) {
      insertSession(db, {
        id: 'ses_' + index + '0000000000000000000000',
        title: '会话' + index,
        directory: '/tmp/oc-proj',
        created: 1700000000000,
        updated: 1700000000000 + index * 1000,
      });
    }
    db.close();
    const sessions = await listOpencodeSessions({ dbPath: join(home, 'opencode.db'), limit: 2 });
    assert.deepEqual(sessions.map((item) => item.title), ['会话3', '会话2']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
