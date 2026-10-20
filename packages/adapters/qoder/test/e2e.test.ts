import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listWorkBuddySessions, readWorkBuddySession } from '../../workbuddy/src/index.ts';
import { verifyQoderRoundTrip, writeQoderSession } from '../src/index.ts';

const wbHome = process.env.SESSIONPORT_WORKBUDDY_HOME;
const qdHome = process.env.SESSIONPORT_QODER_HOME;

/**
 * 真实端到端：本机 WorkBuddy 第一条会话 -> IR -> 临时 Qoder home -> reader 读回。
 * 只写 mkdtemp 出来的临时目录，不碰真实 ~/.qoder-cn。
 */
test('真实端到端: WorkBuddy -> IR -> Qoder -> 读回一致', { skip: wbHome === undefined || qdHome === undefined }, async () => {
  const sessions = await listWorkBuddySessions({ home: wbHome });
  assert.ok(sessions.length > 0);
  const source = await readWorkBuddySession(sessions[0]!.sessionId, { home: wbHome });
  assert.ok(source.root.events.length > 0);

  const outHome = mkdtempSync(join(tmpdir(), 'sessionport-w2q-real-'));
  try {
    const result = await writeQoderSession(source, { home: outHome });
    const roundTrip = await verifyQoderRoundTrip(source, result, { home: outHome });
    assert.equal(roundTrip.ok, true, roundTrip.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
    assert.equal(roundTrip.actual.length, roundTrip.expected.length);
    assert.ok(result.written.toolCalls >= 0);
  } finally {
    rmSync(outHome, { recursive: true, force: true });
  }
});
