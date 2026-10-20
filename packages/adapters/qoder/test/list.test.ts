import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listQoderSessions, qoderProjectKey } from '../src/index.ts';
import { QD_CWD, QD_SESSION_ID, qdTranscriptLines, writeQoderFixture } from './fixtures.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-qd-list-'));
}

test('Qoder list: 扫 projects/*/*.jsonl，按 mtime 倒序，标题照 SDK 优先级', async () => {
  const home = makeHome();
  try {
    const a = writeQoderFixture(home);
    const bId = '99999999-9999-4999-8999-999999999999';
    const bCwd = '/tmp/qoder-other';
    const bLines = qdTranscriptLines(bId, bCwd).map((line) => ({ ...line, sessionId: bId, cwd: bCwd }));
    const b = writeQoderFixture(home, { sessionId: bId, cwd: bCwd, lines: [...bLines, { type: 'custom-title', sessionId: bId, customTitle: 'B 自定义标题' }] });
    const aTime = new Date('2026-10-16T01:00:00.000Z');
    const bTime = new Date('2026-10-16T02:00:00.000Z');
    utimesSync(a.path, aTime, aTime);
    utimesSync(b.path, bTime, bTime);
    writeFileSync(join(home, 'projects', qoderProjectKey(QD_CWD), 'not-a-uuid.jsonl'), '{}\n', 'utf8');

    const sessions = await listQoderSessions({ home });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.sessionId, bId);
    assert.equal(sessions[0]!.title, 'B 自定义标题');
    assert.equal(sessions[0]!.cwd, bCwd);
    assert.equal(sessions[0]!.resumeHint, 'qodercn --resume ' + bId);
    assert.equal(sessions[0]!.updatedAt, bTime.toISOString());
    assert.equal(sessions[1]!.sessionId, QD_SESSION_ID);
    assert.equal(sessions[1]!.title, '第二个问题');

    const limited = await listQoderSessions({ home, limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]!.sessionId, bId);
    assert.deepEqual(await listQoderSessions({ home: join(home, 'missing') }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Qoder list: 没有 last-prompt/custom-title 时退回 firstPrompt', async () => {
  const home = makeHome();
  try {
    const lines = qdTranscriptLines().filter((line) => line.type !== 'last-prompt');
    writeQoderFixture(home, { lines });
    const sessions = await listQoderSessions({ home });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.title, '第一个问题');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
