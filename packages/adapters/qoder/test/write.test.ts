import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWorkBuddySession } from '../../workbuddy/src/index.ts';
import { writeWorkBuddyFixture } from '../../workbuddy/test/fixtures.ts';
import {
  QODER_CAPS,
  listQoderSessions,
  qoderProjectKey,
  readQoderSession,
  verifyQoderRoundTrip,
  verifyQoderSession,
  writeQoderSession,
} from '../src/index.ts';
import { QD_SESSION_ID, writeQoderFixture } from './fixtures.ts';

function makeHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('Qoder write: 行序列落盘 -> reader 读回逐事件一致', async () => {
  const fixtureHome = makeHome('sessionport-qd-src-');
  const outHome = makeHome('sessionport-qd-out-');
  try {
    writeQoderFixture(fixtureHome);
    const source = await readQoderSession(QD_SESSION_ID, { home: fixtureHome });
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const result = await writeQoderSession(source, { home: outHome, sessionId });

    assert.equal(result.applied, true);
    assert.equal(result.written.events, source.root.events.length);
    assert.equal(result.path, join(outHome, 'projects', qoderProjectKey(source.root.meta.cwd!), sessionId + '.jsonl'));
    assert.ok(existsSync(result.path));
    assert.equal(result.rows[0]!.type, 'workspace-directories');
    assert.equal(result.rows[1]!.type, 'runtime-config');
    assert.ok(result.rows.some((row) => row.type === 'custom-title'));
    assert.ok(result.rows.some((row) => row.type === 'last-prompt'));
    assert.equal(result.rows.at(-1)!.type, 'active-leaf');
    assert.deepEqual(QODER_CAPS, { agent: 'qoder', reasoning: 'plain', toolResults: 'separate', branching: false, subagents: false, modelPinned: true });

    const readBack = await readQoderSession(sessionId, { home: outHome });
    assert.equal(readBack.root.meta.title, source.root.meta.title);
    assert.equal(readBack.root.meta.cwd, source.root.meta.cwd);
    assert.equal(readBack.root.events.length, source.root.events.length);

    const roundTrip = await verifyQoderRoundTrip(source, result, { home: outHome });
    assert.equal(roundTrip.ok, true, roundTrip.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
    assert.deepEqual(roundTrip.expected, roundTrip.actual);

    const verify = await verifyQoderSession(sessionId, { home: outHome });
    assert.equal(verify.ok, true, verify.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
    rmSync(outHome, { recursive: true, force: true });
  }
});

test('Qoder write: dryRun 不落盘；默认拒绝覆盖；overwrite 先备份', async () => {
  const fixtureHome = makeHome('sessionport-qd-src2-');
  const outHome = makeHome('sessionport-qd-out2-');
  try {
    writeQoderFixture(fixtureHome);
    const source = await readQoderSession(QD_SESSION_ID, { home: fixtureHome });
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const dry = await writeQoderSession(source, { home: outHome, sessionId, dryRun: true });
    assert.equal(dry.applied, false);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.rows.length > 0);
    assert.equal(existsSync(dry.path), false);

    const first = await writeQoderSession(source, { home: outHome, sessionId });
    assert.equal(first.applied, true);
    await assert.rejects(() => writeQoderSession(source, { home: outHome, sessionId }), /拒绝覆盖/);

    const second = await writeQoderSession(source, { home: outHome, sessionId, overwrite: true });
    assert.equal(second.applied, true);
    assert.ok(second.backupPath !== undefined);
    assert.ok(existsSync(second.backupPath!));
    assert.ok(second.losses.some((loss) => loss.code === 'qoder.backup'));
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
    rmSync(outHome, { recursive: true, force: true });
  }
});

test('端到端: WorkBuddy transcript -> IR -> Qoder transcript -> 读回一致', async () => {
  const wbHome = makeHome('sessionport-w2q-wb-');
  const qdHome = makeHome('sessionport-w2q-qd-');
  try {
    writeWorkBuddyFixture(wbHome, { includeSubagent: true });
    const bundle = await readWorkBuddySession('11111111-1111-4111-8111-111111111111', { home: wbHome });
    const result = await writeQoderSession(bundle, { home: qdHome, sessionId: '88888888-8888-4888-8888-888888888888' });
    assert.equal(result.applied, true);

    const roundTrip = await verifyQoderRoundTrip(bundle, result, { home: qdHome });
    assert.equal(roundTrip.ok, true, roundTrip.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
    const user = roundTrip.bundle!.root.events.find((event) => event.kind === 'message' && event.role === 'user');
    assert.ok(user && user.kind === 'message');
    assert.equal((user.parts[0] as { text: string }).text, '你好，帮我看看目录');
    const tool = roundTrip.bundle!.root.events.find((event) => event.kind === 'tool_call');
    assert.ok(tool && tool.kind === 'tool_call');
    assert.equal(tool.name, 'Bash');
    assert.ok(result.losses.some((loss) => loss.code === 'qoder.subagents-dropped'));
    assert.ok(result.losses.some((loss) => loss.code === 'qoder.model-pinned'));
    assert.ok(result.losses.some((loss) => loss.code === 'qoder.cross-agent-import'));
  } finally {
    rmSync(wbHome, { recursive: true, force: true });
    rmSync(qdHome, { recursive: true, force: true });
  }
});

const realHome = process.env.SESSIONPORT_QODER_HOME;

test('Qoder list/read: 真实目录（SESSIONPORT_QODER_HOME 门控）', { skip: realHome === undefined }, async () => {
  const sessions = await listQoderSessions({ home: realHome });
  assert.ok(sessions.length > 0);
  const first = sessions[0]!;
  assert.equal(first.agent, 'qoder');
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/);
  const bundle = await readQoderSession(first.sessionId, { home: realHome });
  assert.ok(bundle.root.events.length > 0);
  const report = await verifyQoderSession(first.sessionId, { home: realHome });
  assert.equal(report.ok, true, report.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
});
