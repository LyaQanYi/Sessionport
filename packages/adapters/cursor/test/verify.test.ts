import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  appSmokeCursor,
  cursorDisplayName,
  cursorHeadlessCapabilities,
  readCursorAgentScanLog,
  verifyCursorSession,
} from '../src/index.ts';
import { createCursorFixture } from './helpers.ts';

test('verify 对不存在的会话给出失败 checks', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const report = await verifyCursorSession({
      home: fixture.home,
      sessionId: '99999999-9999-4999-8999-999999999999',
      skipReadback: true,
    });
    assert.equal(report.ok, false);
    const names = report.checks.map((check) => check.name);
    assert.ok(names.includes('header-row'));
    assert.ok(names.includes('composer-data-row'));
    assert.deepEqual(report.readback, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('readCursorAgentScanLog 从 main.log 里取最后一次 LocalAgentStorage 扫描结果', () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const dir = join(fixture.home, 'logs', '20260101T000000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'main.log'),
      [
        '2026-10-20 10:57:08.394 [info] [LocalAgentStorage] Scanned 3 recent databases (skipped 79 old), found 448 agent headers, deduped to 448',
        '2026-10-20 10:57:09.000 [info] something else',
      ].join('\n'),
    );
    const log = readCursorAgentScanLog(fixture.home);
    assert.ok(log !== undefined);
    assert.equal(log.found, 448);
    assert.equal(log.deduped, 448);
    assert.equal(log.timestamp, '2026-10-20 10:57:08.394');

    const missing = readCursorAgentScanLog(join(fixture.home, 'nope'));
    assert.equal(missing, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('headless 能力结论：app 无 list/resume，CLI 有但读写独立 store', () => {
  const caps = cursorHeadlessCapabilities();
  assert.equal(caps.appChatListHeadless, false);
  assert.equal(caps.appChatResumeHeadless, false);
  assert.equal(caps.cliHasListResume, true);
  assert.equal(caps.cliChatsAreSeparateStore, true);
  assert.ok(caps.evidence.length >= 3);
});

test('appSmokeCursor 在当前平台返回可解释结果（不真的重启 app）', async () => {
  const result = await appSmokeCursor({ restart: false, cwd: undefined });
  assert.equal(typeof result.note, 'string');
  if (process.platform === 'darwin') {
    assert.equal(result.platformSupported, true);
    assert.ok(result.commands.length >= 1);
  } else {
    assert.equal(result.platformSupported, false);
  }
});

test('cursorDisplayName 缩略 id', () => {
  assert.equal(cursorDisplayName('12345678-1234-1234-1234-123456789012'), '12345678…9012');
  assert.equal(cursorDisplayName('short'), 'short');
});
