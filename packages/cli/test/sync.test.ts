import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function writeIr(path: string, text: string): void {
  const bundle = {
    irVersion: '0.1',
    createdAt: '2026-01-01T00:00:00.000Z',
    root: {
      id: 'ir_sync_test',
      source: { agent: 'dsh', nativeSessionId: 'session-test-sync' },
      meta: { cwd: '/tmp/sessionport-sync-e2e', title: 'sync e2e' },
      events: [
        { kind: 'message', id: 'e1', parentId: null, at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text }] },
        { kind: 'message', id: 'e2', parentId: 'e1', at: '2026-01-01T00:00:01.000Z', role: 'assistant', parts: [{ type: 'text', text: '收到：' + text }] },
      ],
      head: 'e2',
      notices: [],
    },
    children: [],
  };
  writeFileSync(path, JSON.stringify(bundle, null, 2));
}

test('sync：fresh → up-to-date → diverged 拒绝 → --fork 另建会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-sync-cli-'));
  try {
    const ir = join(dir, 'session.ir.json');
    writeIr(ir, '第一版');
    const home = join(dir, 'cc-home');
    const state = join(dir, 'state');

    const first = await runCli(['sync', ir, '--to', 'command-code', '--home', home, '--state', state], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /全新写入/);

    const second = await runCli(['sync', ir, '--to', 'command-code', '--home', home, '--state', state], dir);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /已是最新/);

    const registry = JSON.parse(readFileSync(join(state, 'registry.json'), 'utf8'));
    assert.equal(registry.refs.length, 1);
    const targetPath = registry.refs[0].targetPath;

    // 模拟目标端续写
    const rows = readFileSync(targetPath, 'utf8').trim().split('\n');
    const last = JSON.parse(rows[rows.length - 1]!);
    appendFileSync(
      targetPath,
      JSON.stringify({
        type: 'message',
        id: 'testsim1',
        parentId: last.id,
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '目标端续写' }], meta: { source: 'model', messageId: 'sim', createdAt: 0 } },
      }) + '\n',
    );

    const diverged = await runCli(['sync', ir, '--to', 'command-code', '--home', home, '--state', state], dir);
    assert.equal(diverged.code, 2);
    assert.match(diverged.stderr, /拒绝写入/);

    const forked = await runCli(['sync', ir, '--to', 'command-code', '--home', home, '--state', state, '--fork'], dir);
    assert.equal(forked.code, 0, forked.stderr);
    assert.match(forked.stdout, /fork/);
    const after = JSON.parse(readFileSync(join(state, 'registry.json'), 'utf8'));
    assert.notEqual(after.refs[0].targetId, registry.refs[0].targetId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
