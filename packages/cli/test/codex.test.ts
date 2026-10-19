import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function findRollout(home: string, id: string): string | undefined {
  const walk = (dir: string): string | undefined => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (name.endsWith(id + '.jsonl')) {
        return full;
      }
    }
    return undefined;
  };
  return walk(join(home, 'sessions'));
}

function writeIr(path: string): void {
  const bundle = {
    irVersion: '0.1',
    createdAt: '2026-01-01T00:00:00.000Z',
    root: {
      id: 'ir_codex_cli',
      source: { agent: 'kimi-code', nativeSessionId: 'session-codex-cli' },
      meta: { cwd: '/tmp/sessionport-codex-cli', title: 'codex cli e2e' },
      events: [
        { kind: 'message', id: 'e1', parentId: null, at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
        { kind: 'message', id: 'e2', parentId: 'e1', at: '2026-01-01T00:00:02.000Z', role: 'assistant', parts: [{ type: 'text', text: '收到' }] },
      ],
      head: 'e2',
      notices: [],
    },
    children: [],
  };
  writeFileSync(path, JSON.stringify(bundle, null, 2));
}

test('CLI：push --to codex 写出 rollout，verify 结构校验通过，sync 幂等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-codex-cli-'));
  try {
    const ir = join(dir, 'session.ir.json');
    writeIr(ir);
    const home = join(dir, 'codex-home');
    const state = join(dir, 'state');
    const id = '77777777-7777-4777-8777-777777777777';

    const push = await runCli(['push', ir, '--to', 'codex', '--home', home, '--id', id], dir);
    assert.equal(push.code, 0, push.stderr);
    const rollout = findRollout(home, id);
    assert.ok(rollout, 'rollout 应存在');

    const verify = await runCli(['verify', '--agent', 'codex', '--file', rollout!], dir);
    assert.equal(verify.code, 0, verify.stderr);
    assert.match(verify.stdout, /结构化校验通过/);

    const sync1 = await runCli(['sync', ir, '--to', 'codex', '--home', home, '--state', state, '--id', id], dir);
    assert.equal(sync1.code, 0, sync1.stderr);
    assert.match(sync1.stdout, /全新写入|安全重写/);

    const sync2 = await runCli(['sync', ir, '--to', 'codex', '--home', home, '--state', state, '--id', id], dir);
    assert.equal(sync2.code, 0, sync2.stderr);
    assert.match(sync2.stdout, /已是最新|没有写入/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
