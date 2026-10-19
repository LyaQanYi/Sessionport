import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeSegment, listDshSessions, projectKey, writeZstdJsonl } from '../src/index.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-dsh-list-'));
}

interface SessionFixture {
  id: string;
  cwd: string;
  createdAt: number;
  events?: unknown[];
  parentSession?: string;
}

async function writeSession(home: string, fixture: SessionFixture): Promise<string> {
  const dir = join(home, 'sessions', projectKey(fixture.cwd), encodeSegment(fixture.id));
  const header: Record<string, unknown> = {
    type: 'session',
    version: 4,
    id: fixture.id,
    createdAt: fixture.createdAt,
    cwd: fixture.cwd,
    isSeeded: false,
    delegationDepth: fixture.parentSession === undefined ? 0 : 1,
  };
  if (fixture.parentSession !== undefined) {
    header.parentSession = fixture.parentSession;
    header.origin = 'subagent';
  }
  const lines = [JSON.stringify(header), ...(fixture.events ?? []).map((event) => JSON.stringify(event))];
  await writeZstdJsonl(join(dir, 'session.v4.jsonl.zstd'), lines, { headerLines: 1, batchSize: 1 });
  return dir;
}

function writeProjCache(home: string, id: string, title: string, cwd: string, createdAt: number): void {
  const dir = join(home, 'storages', 'session_projcache', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, id + '.json'),
    JSON.stringify({ version: 7, record: { identity: { cwd, createdAt }, rows: { title: { ver: 1, seq: 1, val: title } } } }),
  );
}

function userEvent(time: number, text: string): unknown {
  return { type: 'user/message', seq: 1, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } };
}

test('dsh list: 首帧 header + projcache 标题，不读全文', async () => {
  const home = makeHome();
  try {
    const id = 'session-test-1';
    const dir = await writeSession(home, { id, cwd: '/tmp/dsh-proj', createdAt: 1700000000000, events: [userEvent(1700000001000, '你好')] });
    writeProjCache(home, id, 'DSH 标题', '/tmp/dsh-proj', 1700000000000);

    const sessions = await listDshSessions({ home });
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.agent, 'dsh');
    assert.equal(session.sessionId, id);
    assert.equal(session.title, 'DSH 标题');
    assert.equal(session.cwd, '/tmp/dsh-proj');
    assert.equal(session.createdAt, new Date(1700000000000).toISOString());
    assert.match(session.updatedAt!, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(session.nativePath, join(dir, 'session.v4.jsonl.zstd'));
    assert.equal(session.resumeHint, 'dsh headless --session-id ' + id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dsh list: 无 projcache 时用头部首条 user 文本兜底，跳过注入消息', async () => {
  const home = makeHome();
  try {
    const id = 'session-test-2';
    await writeSession(home, {
      id,
      cwd: '/tmp/dsh-proj',
      createdAt: 1700000000000,
      events: [
        { type: 'user/message', seq: 1, time: 1700000001000, data: { content: [{ type: 'text', text: 'runtime context injected' }], source: { kind: 'time-context' } } },
        userEvent(1700000002000, '真实需求：导出会话'),
      ],
    });
    const sessions = await listDshSessions({ home });
    assert.equal(sessions[0]!.title, '真实需求：导出会话');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dsh list: 子代理会话带 parentSessionId', async () => {
  const home = makeHome();
  try {
    const parentId = 'session-parent';
    const childId = 'session-child';
    await writeSession(home, { id: parentId, cwd: '/tmp/dsh-proj', createdAt: 1700000000000 });
    await writeSession(home, { id: childId, cwd: '/tmp/dsh-proj', createdAt: 1700000001000, parentSession: parentId });
    const sessions = await listDshSessions({ home });
    const child = sessions.find((item) => item.sessionId === childId)!;
    assert.equal(child.parentSessionId, parentId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dsh list: 目录不存在返回 []，坏 zstd / 无日志目录跳过', async () => {
  const home = makeHome();
  try {
    assert.deepEqual(await listDshSessions({ home: join(home, 'nope') }), []);
    // 坏 zstd
    const corruptDir = join(home, 'sessions', projectKey('/tmp/dsh-proj'), encodeSegment('session-corrupt'));
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'session.v4.jsonl.zstd'), 'not a zstd frame');
    // 空目录（没有日志文件）
    mkdirSync(join(home, 'sessions', projectKey('/tmp/dsh-proj'), encodeSegment('session-empty')), { recursive: true });
    assert.deepEqual(await listDshSessions({ home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
