import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listSessions, previewMigration, readSession, readableAgents, runMigration, writableAgents } from '../src/main/services.ts';

test('capabilities：可读/可写 agent 列表', () => {
  assert.deepEqual(readableAgents().sort(), ['claude-code', 'codex', 'command-code', 'cursor', 'dsh', 'kimi-code', 'opencode', 'qoder', 'workbuddy'].sort());
  assert.deepEqual(writableAgents().sort(), ['claude-code', 'command-code', 'codex', 'cursor', 'dsh', 'opencode', 'qoder'].sort());
});

test('listSessions 返回结构合法的行（无会话时也应是空数组）', async () => {
  const result = await listSessions();
  assert.ok(Array.isArray(result.sessions));
  assert.ok(Array.isArray(result.warnings));
  for (const row of result.sessions) {
    assert.ok(typeof row.agent === 'string' && row.agent.length > 0);
    assert.ok(typeof row.sessionId === 'string');
    assert.ok(typeof row.nativePath === 'string' && row.nativePath.length > 0);
    assert.equal(typeof row.readable, 'boolean');
  }
});

test('readSession：读一个真实 Codex 会话（没有样本时跳过）', async (t) => {
  const result = await listSessions();
  const codex = result.sessions.find((row) => row.agent === 'codex' && row.readable);
  if (!codex) {
    t.skip('本机没有 Codex 会话样本');
    return;
  }
  const read = await readSession('codex', { nativePath: codex.nativePath, sessionId: codex.sessionId }, 50);
  assert.ok(read.events.length > 0);
  assert.ok(read.events.every((event) => typeof event.id === 'string' && typeof event.at === 'string'));
  assert.equal(read.truncated, read.events.length === 50);
});

test('previewMigration：dryRun 只出损失清单，不落盘', async (t) => {
  const result = await listSessions();
  const source = result.sessions.find((row) => row.readable && row.agent === 'codex');
  if (!source) {
    t.skip('本机没有可读的 Codex 会话样本');
    return;
  }
  const preview = await previewMigration('codex', { nativePath: source.nativePath, sessionId: source.sessionId }, 'claude-code');
  assert.equal(preview.target, 'claude-code');
  assert.ok(preview.source.events > 0);
  assert.ok(Array.isArray(preview.losses));
  assert.ok(preview.losses.every((loss) => typeof loss.code === 'string' && typeof loss.message === 'string'));
});

test('readSession：没有 reader 的 agent 给出明确错误', async () => {
  await assert.rejects(() => readSession('kimi-code', { nativePath: '/nonexistent-kimi-session' }), /不是 Kimi 会话目录|ENOENT|不存在/);
});
test('sync 语义：fresh -> up-to-date -> diverged 拒绝 -> fork 另建（用临时 registry 与目标目录）', async (t) => {
  const all = await listSessions();
  const source = all.sessions.find((row) => row.agent === 'codex' && row.readable);
  if (!source) {
    t.skip('本机没有可读的 Codex 会话样本');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-sync-'));
  const stateHome = join(dir, 'state');
  const claudeHome = join(dir, 'claude');
  const ref = { nativePath: source.nativePath, sessionId: source.sessionId };
  try {
    const first = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.equal(first.sync.decision, 'fresh');

    const run1 = await runMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.equal(run1.refused, undefined);
    assert.ok(run1.paths[0], '应当写出目标文件');

    const second = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.equal(second.sync.decision, 'up-to-date');

    // 模拟用户在目标 app 里续写一条
    appendFileSync(
      run1.paths[0]!,
      JSON.stringify({
        type: 'user',
        uuid: 'sim-append-1',
        parentUuid: null,
        sessionId: run1.sessionId,
        timestamp: new Date().toISOString(),
        cwd: '/tmp',
        version: '2.1.303',
        gitBranch: '',
        isSidechain: false,
        userType: 'external',
        message: { role: 'user', content: [{ type: 'text', text: '续写' }] },
      }) + '\n',
    );

    const diverged = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.equal(diverged.sync.decision, 'diverged');
    assert.ok((diverged.sync.targetExtra ?? 0) >= 1);

    const refused = await runMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.ok(refused.refused, '默认应拒绝覆盖');

    const forked = await runMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome, onDiverged: 'fork' });
    assert.equal(forked.refused, undefined);
    assert.notEqual(forked.sessionId, run1.sessionId);

    const afterFork = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.equal(afterFork.sync.decision, 'up-to-date');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCodexFixtureFile(dir: string, sessionUuid = '11111111-2222-4333-8444-555555555555'): string {
  const file = join(dir, `rollout-2026-11-20T00-00-00-${sessionUuid}.jsonl`);
  const rows = [
    {
      timestamp: '2026-11-20T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionUuid,
        timestamp: '2026-11-20T00:00:00.000Z',
        cwd: '/tmp/desktop-fixture',
        originator: 'codex_cli_rs',
        cli_version: '0.171.0',
      },
    },
    {
      timestamp: '2026-11-20T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列文件' }] },
    },
    {
      timestamp: '2026-11-20T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call_desktop_1', arguments: '{"cmd":"ls"}' },
    },
    {
      timestamp: '2026-11-20T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_desktop_1', output: 'a.ts' },
    },
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
}

test('qoder 目标路由与 adapter 写入：不再误走 opencode，且支持 diverged force 覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-qoder-'));
  const stateHome = join(dir, 'state');
  const qoderHome = join(dir, 'qoder');
  try {
    const srcFile = writeCodexFixtureFile(dir);
    const ref = { nativePath: srcFile };
    const preview = await previewMigration('codex', ref, 'qoder', { stateHome, home: qoderHome });
    assert.equal(preview.target, 'qoder');
    assert.equal(preview.sync.decision, 'fresh');
    assert.ok(preview.losses.some((loss) => loss.code === 'qoder.tool-normalized'));

    const run = await runMigration('codex', ref, 'qoder', { stateHome, home: qoderHome });
    assert.equal(run.refused, undefined);
    assert.equal(run.target, 'qoder');
    assert.ok(run.paths[0]?.endsWith('.jsonl'));
    assert.ok(existsSync(run.paths[0]!));

    // 目标文件追加一行后，force 模式应经 allowOverwrite -> overwrite: true 成功备份并覆写
    appendFileSync(run.paths[0]!, JSON.stringify({ type: 'custom-title', customTitle: 'edited' }) + '\n');
    const forced = await runMigration('codex', ref, 'qoder', { stateHome, home: qoderHome, onDiverged: 'force' });
    assert.equal(forced.refused, undefined);
    assert.ok(forced.losses.some((loss) => loss.code === 'qoder.backup'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeTools：默认归一化，设为 false 时保留源工具名并跳过工具映射损失', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-raw-tools-'));
  const stateHome = join(dir, 'state');
  const claudeHome = join(dir, 'claude');
  try {
    const srcFile = writeCodexFixtureFile(dir, '22222222-2222-4333-8444-555555555555');
    const ref = { nativePath: srcFile };

    const normalizedPreview = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.ok(normalizedPreview.losses.some((loss) => loss.code === 'claude.tool-normalized'));

    const rawPreview = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome, normalizeTools: false });
    assert.ok(!rawPreview.losses.some((loss) => loss.code === 'claude.tool-normalized'));

    const rawRun = await runMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome, normalizeTools: false });
    assert.equal(rawRun.refused, undefined);
    const written = readFileSync(rawRun.paths[0]!, 'utf8');
    assert.ok(written.includes('"name":"exec_command"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});