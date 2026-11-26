import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  listBackups,
  listSessions,
  previewMergeBack,
  previewMigration,
  readSession,
  readableAgents,
  runMergeBack,
  runMigration,
  undoBackup,
  writableAgents,
} from '../src/main/services.ts';

test('capabilities：可读/可写 agent 列表', () => {
  assert.deepEqual(readableAgents().sort(), ['antigravity', 'claude-code', 'codex', 'command-code', 'cursor', 'dsh', 'kimi-code', 'opencode', 'qoder', 'workbuddy'].sort());
  assert.deepEqual(writableAgents().sort(), ['antigravity', 'claude-code', 'command-code', 'codex', 'cursor', 'dsh', 'opencode', 'qoder'].sort());
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

test('desktop backup & undo: runMigration 自动生成 backupId，undoBackup 删除新建目标并恢复 registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-undo-'));
  const stateHome = join(dir, 'state');
  const claudeHome = join(dir, 'claude');
  try {
    const srcFile = writeCodexFixtureFile(dir, '33333333-3333-4333-8333-333333333333');
    const ref = { nativePath: srcFile };
    const run = await runMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.ok(run.backupId);
    assert.equal(existsSync(run.paths[0]!), true);
    assert.equal(listBackups(stateHome).length, 1);

    const undone = await undoBackup(run.backupId, { stateHome });
    assert.equal(undone.opId, run.backupId);
    assert.equal(existsSync(run.paths[0]!), false);
    assert.equal(undone.registryDeleted, true);

    const previewAfter = await previewMigration('codex', ref, 'claude-code', { stateHome, home: claudeHome });
    assert.equal(previewAfter.sync.decision, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop merge-back: Claude -> Codex 同步后 Codex 续写 -> preview/runMergeBack 无损追加回 Claude 并可 undo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-mb-'));
  const stateHome = join(dir, 'state');
  const claudeHome = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const claudeFile = join(claudeHome, 'projects', '-tmp-desktop-mb', sessionId + '.jsonl');
  try {
    mkdirSync(dirname(claudeFile), { recursive: true });
    const claudeSeed = [
      {
        type: 'user',
        uuid: 'u-desk-1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/desktop-mb',
        version: '2.1.330',
        gitBranch: 'main',
        isSidechain: false,
        userType: 'external',
        message: { role: 'user', content: [{ type: 'text', text: '分析一下' }] },
      },
      {
        type: 'assistant',
        uuid: 'a-desk-1',
        parentUuid: 'u-desk-1',
        sessionId,
        timestamp: '2026-01-01T00:00:01.000Z',
        cwd: '/tmp/desktop-mb',
        version: '2.1.330',
        gitBranch: 'main',
        isSidechain: false,
        userType: 'external',
        message: {
          id: 'msg_desk_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [
            { type: 'thinking', thinking: '原始签名思考', signature: 'sig_desktop_preserved' },
            { type: 'text', text: '准备好了' },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const originalBytes = Buffer.from(claudeSeed.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    writeFileSync(claudeFile, originalBytes);

    const srcRef = { nativePath: claudeFile };
    const migrated = await runMigration('claude-code', srcRef, 'codex', { stateHome, home: codexHome });
    assert.equal(migrated.refused, undefined);

    // 模拟在 Codex 里追加新一轮对话与工具调用
    const codexFile = migrated.paths[0]!;
    appendFileSync(
      codexFile,
      [
        { timestamp: '2026-01-01T00:02:00.000Z', type: 'response_item', payload: { type: 'message', id: 'u2', role: 'user', content: [{ type: 'input_text', text: '跑个 ls' }] } },
        { timestamp: '2026-01-01T00:02:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_desk', arguments: '{"cmd":"ls"}' } },
        { timestamp: '2026-01-01T00:02:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_desk', output: 'ok' } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const mbPreview = await previewMergeBack('claude-code', srcRef, 'codex', { stateHome, targetHome: codexHome });
    assert.equal(mbPreview.decision, 'fast-forward');
    assert.equal(mbPreview.deltaEvents, 3);
    assert.equal(mbPreview.strategy, 'appendDelta');

    const mbRun = await runMergeBack('claude-code', srcRef, 'codex', { stateHome, targetHome: codexHome });
    assert.equal(mbRun.refused, undefined);
    assert.equal(mbRun.decision, 'fast-forward');
    assert.equal(mbRun.mergedEvents, 3);
    assert.equal(mbRun.strategy, 'appendDelta');
    assert.ok(mbRun.backupId);

    const updatedBytes = readFileSync(claudeFile);
    assert.deepEqual(updatedBytes.subarray(0, originalBytes.length), originalBytes);
    assert.match(updatedBytes.toString('utf8'), /"name":"Bash"/);

    // 合回后应已同步
    const afterSync = await previewMigration('claude-code', srcRef, 'codex', { stateHome, home: codexHome });
    assert.equal(afterSync.sync.decision, 'up-to-date');

    // undo merge-back 后字节级还原回原文件
    await undoBackup(mbRun.backupId, { stateHome });
    assert.deepEqual(readFileSync(claudeFile), originalBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('antigravity：桌面端 readSession 与 previewMigration 触发跨源工具归一', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-agy-'));
  try {
    const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const transcriptPath = join(dir, 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript_full.jsonl');
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        {
          step_index: 0,
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-26T04:00:00Z',
          content: '<USER_REQUEST>\n检查构建状态\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignored\n</ADDITIONAL_METADATA>',
        },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-26T04:00:01Z',
          model: 'gemini-4-neon',
          thinking: '先读取 package.json。',
          content: '我来检查构建文件。',
          tool_calls: [{ name: 'read_file', args: { Path: '/repo/package.json', StartLine: 1, EndLine: 20 } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-26T04:00:02Z',
          content: 'Created At: 2026-11-26T12:00:02+08:00\n{"name":"demo"}',
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
      'utf8',
    );

    const read = await readSession('antigravity', { nativePath: transcriptPath, sessionId: convId });
    assert.equal(read.agent, 'antigravity');
    assert.equal(read.sessionId, convId);
    assert.ok(read.events.some((event) => event.kind === 'message' && event.role === 'user' && event.text === '检查构建状态'));
    assert.ok(read.events.some((event) => event.kind === 'tool_call' && event.toolName === 'read_file'));

    const preview = await previewMigration('antigravity', { nativePath: transcriptPath, sessionId: convId }, 'claude-code', {
      stateHome: join(dir, 'state'),
      home: join(dir, 'claude-dst'),
    });
    assert.equal(preview.target, 'claude-code');
    assert.ok(preview.losses.some((loss) => loss.code === 'claude.tool-normalized'));

    const pushed = await runMigration('antigravity', { nativePath: transcriptPath, sessionId: convId }, 'claude-code', {
      stateHome: join(dir, 'state'),
      home: join(dir, 'claude-dst'),
    });
    assert.equal(pushed.target, 'claude-code');

    const mergePreview = await previewMergeBack('antigravity', { nativePath: transcriptPath, sessionId: convId }, 'claude-code', {
      stateHome: join(dir, 'state'),
      targetHome: join(dir, 'claude-dst'),
    });
    assert.equal(mergePreview.decision, 'source-read-only');
    await assert.rejects(
      () =>
        runMergeBack('antigravity', { nativePath: transcriptPath, sessionId: convId }, 'claude-code', {
          stateHome: join(dir, 'state'),
          targetHome: join(dir, 'claude-dst'),
        }),
      /source-read-only|不允许原位改写|不支持|只读/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('antigravity：桌面端 claude-code -> antigravity handoffOnly 迁移与 undo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-desktop-agy-write-'));
  try {
    const claudeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const claudePath = join(dir, 'claude-src', 'projects', '-tmp-repo', claudeId + '.jsonl');
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(
      claudePath,
      [
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          timestamp: '2026-11-26T05:00:00Z',
          cwd: repoDir,
          sessionId: claudeId,
          message: { role: 'user', content: '请汇总当前架构要点' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          timestamp: '2026-11-26T05:00:02Z',
          cwd: repoDir,
          sessionId: claudeId,
          message: { role: 'assistant', content: [{ type: 'text', text: '这是一个模块化适配器仓库。' }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
      'utf8',
    );

    const stateHome = join(dir, 'state');
    const agyHome = join(dir, 'agy-home');
    const preview = await previewMigration('claude-code', { nativePath: claudePath, sessionId: claudeId }, 'antigravity', {
      stateHome,
      home: agyHome,
      handoffOnly: true,
    });
    assert.equal(preview.target, 'antigravity');
    assert.ok(preview.losses.some((loss) => loss.code === 'antigravity.degraded-context-handoff'));
    assert.ok(preview.losses.some((loss) => loss.code === 'antigravity.handoff-file-only'));

    const written = await runMigration('claude-code', { nativePath: claudePath, sessionId: claudeId }, 'antigravity', {
      stateHome,
      home: agyHome,
      handoffOnly: true,
    });
    assert.equal(written.target, 'antigravity');
    assert.equal(written.paths.length, 2);
    assert.ok(existsSync(written.paths[0]!));
    assert.ok(existsSync(written.paths[1]!));
    assert.equal(written.handoff?.delivery, 'handoff-file');
    assert.ok(written.handoff?.promptText.includes(written.paths[0]!));
    assert.ok(readFileSync(written.paths[0]!, 'utf8').includes('请汇总当前架构要点'));

    assert.ok(written.backupId);
    const undone = await undoBackup(written.backupId, { stateHome });
    assert.equal(undone.opId, written.backupId);
    assert.equal(existsSync(written.paths[0]!), false);
    assert.equal(existsSync(written.paths[1]!), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});