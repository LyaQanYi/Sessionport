import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { sessionFilePath, verifyClaudeSession } from '../../adapters/claude-code/src/index.ts';
import { readCodexSession } from '../../adapters/codex/src/index.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'index.ts');

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function writeClaudeSeed(claudeHome: string, sessionId: string, cwd: string): string {
  const file = sessionFilePath(claudeHome, cwd, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  const row1 = JSON.stringify({
    type: 'user',
    uuid: 'u1-seed',
    parentUuid: null,
    sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd,
    version: '2.1.330',
    gitBranch: 'main',
    isSidechain: false,
    userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text: '查看当前目录' }] },
  });
  const row2 = JSON.stringify({
    type: 'assistant',
    uuid: 'a1-seed',
    parentUuid: 'u1-seed',
    sessionId,
    timestamp: '2026-01-01T00:00:01.000Z',
    cwd,
    version: '2.1.330',
    gitBranch: 'main',
    isSidechain: false,
    userType: 'external',
    message: {
      id: 'msg_seed_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        { type: 'thinking', thinking: '原始签名思考', signature: 'sig_route_a_preserved' },
        { type: 'text', text: '好，我继续分析。' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  writeFileSync(file, row1 + '\n' + row2 + '\n', 'utf8');
  return file;
}

test('CLI push + undo --list + undo --dry-run + undo 删除新建文件且拒绝二次撤销', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-cli-undo-'));
  try {
    const claudeHome = join(dir, 'claude');
    const codexHome = join(dir, 'codex');
    const stateHome = join(dir, 'state');
    const srcFile = writeClaudeSeed(claudeHome, '11111111-1111-4111-8111-111111111111', dir);

    const push = await runCli(
      ['push', 'claude:' + srcFile, '--to', 'codex', '--home', codexHome, '--state', stateHome, '--json'],
      dir,
    );
    assert.equal(push.code, 0, push.stderr);
    const pushJson = JSON.parse(push.stdout) as { filePath: string; backupId: string };
    assert.ok(pushJson.backupId);
    assert.equal(existsSync(pushJson.filePath), true);

    const list = await runCli(['undo', '--list', '--state', stateHome, '--json'], dir);
    assert.equal(list.code, 0, list.stderr);
    const items = JSON.parse(list.stdout) as Array<{ id: string }>;
    assert.equal(items[0]?.id, pushJson.backupId);

    const dryUndo = await runCli(['undo', pushJson.backupId, '--dry-run', '--state', stateHome], dir);
    assert.equal(dryUndo.code, 0, dryUndo.stderr);
    assert.equal(existsSync(pushJson.filePath), true);

    const realUndo = await runCli(['undo', pushJson.backupId, '--state', stateHome], dir);
    assert.equal(realUndo.code, 0, realUndo.stderr);
    assert.equal(existsSync(pushJson.filePath), false);

    const twice = await runCli(['undo', pushJson.backupId, '--state', stateHome], dir);
    assert.notEqual(twice.code, 0);
    assert.match(twice.stderr, /已经撤销过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI sync -> 目标续写 diverged -> merge-back 无损尾部追加到 Claude -> sync up-to-date -> undo 字节级还原', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-cli-mb-'));
  try {
    const claudeHome = join(dir, 'claude');
    const codexHome = join(dir, 'codex');
    const stateHome = join(dir, 'state');
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const srcFile = writeClaudeSeed(claudeHome, sessionId, dir);
    const originalBytes = readFileSync(srcFile);

    // 1. sync Claude -> Codex
    const synced = await runCli(
      ['sync', 'claude:' + srcFile, '--to', 'codex', '--home', codexHome, '--state', stateHome],
      dir,
    );
    assert.equal(synced.code, 0, synced.stderr);

    const regAfterSync = JSON.parse(readFileSync(join(stateHome, 'registry.json'), 'utf8')) as {
      refs: Array<{ targetPath: string; targetIrEvents?: number }>;
    };
    const codexPath = regAfterSync.refs[0]!.targetPath;
    assert.ok(typeof regAfterSync.refs[0]!.targetIrEvents === 'number');

    // 2. 在 Codex 端模拟用户继续对话 + 调用 exec_command
    const appendedCodexRows = [
      { timestamp: '2026-01-01T00:05:00.000Z', type: 'response_item', payload: { type: 'message', id: 'm_u2', role: 'user', content: [{ type: 'input_text', text: '列出目录' }] } },
      { timestamp: '2026-01-01T00:05:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_codex_mb', arguments: '{"cmd":"ls -la"}' } },
      { timestamp: '2026-01-01T00:05:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_codex_mb', output: 'total 0' } },
      { timestamp: '2026-01-01T00:05:03.000Z', type: 'response_item', payload: { type: 'message', id: 'm_a2', role: 'assistant', content: [{ type: 'output_text', text: '列完了' }] } },
    ];
    writeFileSync(codexPath, readFileSync(codexPath, 'utf8') + appendedCodexRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // 3. sync 应判 diverged (exit 2)
    const diverged = await runCli(
      ['sync', 'claude:' + srcFile, '--to', 'codex', '--home', codexHome, '--state', stateHome],
      dir,
    );
    assert.equal(diverged.code, 2);
    assert.match(diverged.stderr, /--merge-back/);

    // 4. merge-back（通过 sync --merge-back）应无损尾部追加进 Claude
    const mb = await runCli(
      ['sync', 'claude:' + srcFile, '--to', 'codex', '--merge-back', '--home', codexHome, '--state', stateHome, '--json'],
      dir,
    );
    assert.equal(mb.code, 0, mb.stderr);
    const mbJson = JSON.parse(mb.stdout) as { decision: string; strategy: string; mergedEvents: number; backupId: string };
    assert.equal(mbJson.decision, 'fast-forward');
    assert.equal(mbJson.strategy, 'appendDelta');
    assert.equal(mbJson.mergedEvents, 4);

    // 验证 Claude 原先 thinking+signature 前缀逐字节保留，且新增 exec_command 归一为 Bash，结构自检全过
    const updatedBytes = readFileSync(srcFile);
    assert.deepEqual(updatedBytes.subarray(0, originalBytes.length), originalBytes);
    const updatedText = updatedBytes.toString('utf8');
    assert.match(updatedText, /"name":"Bash"/);
    const verified = await verifyClaudeSession({ configDir: claudeHome, cwd: dir, sessionId });
    assert.equal(verified.ok, true, JSON.stringify(verified.checks.filter((c) => !c.ok)));

    // 5. 此时再 sync 应报告 up-to-date
    const upToDate = await runCli(
      ['sync', 'claude:' + srcFile, '--to', 'codex', '--home', codexHome, '--state', stateHome],
      dir,
    );
    assert.equal(upToDate.code, 0, upToDate.stderr);
    assert.match(upToDate.stdout, /已是最新/);

    // 6. undo 撤销这次 merge-back -> Claude 还原回原字节且 sync 重新变 diverged
    const undoMb = await runCli(['undo', mbJson.backupId, '--state', stateHome], dir);
    assert.equal(undoMb.code, 0, undoMb.stderr);
    assert.deepEqual(readFileSync(srcFile), originalBytes);

    const divergedAgain = await runCli(
      ['sync', 'claude:' + srcFile, '--to', 'codex', '--home', codexHome, '--state', stateHome],
      dir,
    );
    assert.equal(divergedAgain.code, 2);

    // 7. 双方都推进：源端再写一条 -> merge-back 默认 exit 2 -> --append-diverged 成功加 fork 边界
    writeFileSync(
      srcFile,
      readFileSync(srcFile, 'utf8') +
        JSON.stringify({
          type: 'user',
          uuid: 'u-local-advance',
          parentUuid: 'a1-seed',
          sessionId,
          timestamp: '2026-01-01T00:10:00.000Z',
          cwd: dir,
          version: '2.1.330',
          gitBranch: 'main',
          isSidechain: false,
          userType: 'external',
          message: { role: 'user', content: [{ type: 'text', text: '本地也推进了一步' }] },
        }) + '\n',
    );

    const bothRefused = await runCli(
      ['merge-back', 'claude:' + srcFile, '--from', 'codex', '--state', stateHome],
      dir,
    );
    assert.equal(bothRefused.code, 2);

    const bothMerged = await runCli(
      ['merge-back', 'claude:' + srcFile, '--from', 'codex', '--append-diverged', '--state', stateHome, '--json'],
      dir,
    );
    assert.equal(bothMerged.code, 0, bothMerged.stderr);
    const bothJson = JSON.parse(bothMerged.stdout) as { decision: string; strategy: string };
    assert.equal(bothJson.decision, 'both-changed');
    assert.equal(bothJson.strategy, 'appendDelta');

    void readCodexSession;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
