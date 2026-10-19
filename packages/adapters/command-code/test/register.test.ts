import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { registerCommandCodeThread, writeCommandCodeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-cc-register-project';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({
    ...event,
    parentId: index === 0 ? null : (events[index - 1] as { id: string }).id,
  })) as IrEvent[];
}

function makeBundle(): IrBundle {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
    { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '收到' }] },
  ] as Array<Omit<IrEvent, 'parentId'>>);
  return {
    irVersion: IR_VERSION,
    createdAt: new Date(0).toISOString(),
    root: {
      id: 'ir_reg',
      source: { agent: 'dsh' },
      meta: { cwd: TEST_CWD, title: '注册测试' },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
}

/** 造一个最小可用的桌面端数据目录（app-state.json + thread-index.db） */
async function makeUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-cc-userdata-'));
  writeFileSync(join(dir, 'app-state.json'), JSON.stringify({ appState: { threads: [], projects: [], hiddenSessions: {}, deletedThreads: {}, removedProjects: {} } }, null, 2));
  const db = new DatabaseSync(join(dir, 'thread-index.db'));
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT \'\', project_path TEXT NOT NULL DEFAULT \'\', model TEXT NOT NULL DEFAULT \'\', git_branch TEXT NOT NULL DEFAULT \'\', unread INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0, has_transcript INTEGER NOT NULL DEFAULT 0)',
  );
  db.close();
  return dir;
}

test('register: 写入 thread-index 与 app-state，并清掉 tombstone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-home-'));
  const userData = await makeUserDataDir();
  try {
    // 预先制造 tombstone，验证注册会清掉
    const statePath = join(userData, 'app-state.json');
    const doc = JSON.parse(await readFile(statePath, 'utf8'));
    doc.appState.hiddenSessions['aaaaaaaa-1111-4111-8111-111111111111'] = 1;
    doc.appState.removedProjects[TEST_CWD] = 1;
    writeFileSync(statePath, JSON.stringify(doc, null, 2));

    const report = await writeCommandCodeSession(makeBundle(), {
      home,
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      cwd: TEST_CWD,
      title: '注册测试',
      register: true,
      userDataDir: userData,
    });
    assert.equal(report.registration?.installed, true);
    assert.ok(!report.losses.some((l) => l.code === 'command-code.register-skipped'));

    const db = new DatabaseSync(join(userData, 'thread-index.db'));
    const rows = db.prepare('SELECT id,title,project_path,has_transcript FROM threads').all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 'aaaaaaaa-1111-4111-8111-111111111111');
    assert.equal(rows[0]!.title, '注册测试');
    assert.equal(rows[0]!.project_path, TEST_CWD);
    assert.equal(rows[0]!.has_transcript, 1);

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.appState.threads.length, 1);
    assert.equal(state.appState.threads[0].id, 'aaaaaaaa-1111-4111-8111-111111111111');
    assert.ok(state.appState.projects.some((p: { path: string }) => p.path === TEST_CWD));
    assert.equal(state.appState.hiddenSessions['aaaaaaaa-1111-4111-8111-111111111111'], undefined);
    assert.equal(state.appState.removedProjects[TEST_CWD], undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('register: 桌面端目录不存在时降级为 warning，不阻断写入', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-home-'));
  try {
    const report = await writeCommandCodeSession(makeBundle(), {
      home,
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      cwd: TEST_CWD,
      register: true,
      userDataDir: join(home, 'does-not-exist'),
    });
    assert.equal(report.registration?.installed, false);
    assert.ok(report.losses.some((l) => l.code === 'command-code.register-skipped'));
    assert.ok(report.rows.length > 0, 'transcript 仍应写出');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('register: 幂等（同一 id 重复注册不产生重复行）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-cc-home-'));
  const userData = await makeUserDataDir();
  try {
    const spec = { id: 'cccccccc-3333-4333-8333-333333333333', title: '幂等', projectPath: TEST_CWD };
    registerCommandCodeThread(spec, { userDataDir: userData, backupDir: join(home, 'backups') });
    registerCommandCodeThread(spec, { userDataDir: userData, backupDir: join(home, 'backups') });
    const db = new DatabaseSync(join(userData, 'thread-index.db'));
    const count = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    db.close();
    assert.equal(count.n, 1);
    const state = JSON.parse(await readFile(join(userData, 'app-state.json'), 'utf8'));
    assert.equal(state.appState.threads.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});