import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWorkBuddySession, verifyWorkBuddyBundle, verifyWorkBuddySession } from '../src/index.ts';
import { WB_SESSION_ID, writeWorkBuddyFixture } from './fixtures.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-wb-verify-'));
}

test('WorkBuddy verify: 正常 fixture 全部通过', async () => {
  const home = makeHome();
  try {
    writeWorkBuddyFixture(home, { includeSubagent: true });
    const report = await verifyWorkBuddySession(WB_SESSION_ID, { home });
    assert.equal(report.ok, true, report.checks.filter((check) => !check.ok).map((check) => check.name).join(','));
    assert.equal(report.sessionId, WB_SESSION_ID);
    assert.ok(report.checks.some((check) => check.name === 'jsonl-parse' && check.ok));
    assert.ok(report.checks.some((check) => check.name === 'session-meta' && check.ok));
    assert.ok(report.checks.some((check) => check.name === 'ai-title' && check.ok));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('WorkBuddy verify: 缺 assistant / 坏 JSON 报 ok=false', async () => {
  const home = makeHome();
  try {
    const lines = [
      { type: 'session-meta', id: 'm', sessionId: WB_SESSION_ID, timestamp: 1, cwd: '/tmp/wb-project' },
      { type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: 'hi' }], timestamp: 2, cwd: '/tmp/wb-project' },
    ];
    writeWorkBuddyFixture(home, { lines });
    const report = await verifyWorkBuddySession(WB_SESSION_ID, { home });
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.name === 'has-assistant-message' && !check.ok));
    assert.ok(report.checks.some((check) => check.name === 'ai-title' && !check.ok));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('WorkBuddy verify: bundle 链断裂能被 validateIrBundle 抓到', async () => {
  const home = makeHome();
  try {
    writeWorkBuddyFixture(home);
    const bundle = await readWorkBuddySession(WB_SESSION_ID, { home });
    bundle.root.head = 'wb:e999999';
    const checks = verifyWorkBuddyBundle(bundle);
    assert.equal(checks.find((check) => check.name === 'ir-structure')!.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
