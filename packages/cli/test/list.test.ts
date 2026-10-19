import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'index.ts');

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function writeKimiFixture(home: string): void {
  for (const [index, title] of [['1', 'Kimi 会话一'], ['2', 'Kimi 会话二']] as Array<[string, string]>) {
    const dir = join(home, 'sessions', 'wd_demo_abc', 'session_' + index);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        id: 'session_' + index,
        version: 2,
        cwd: '/tmp/cli-proj',
        createdAt: 1700000000000,
        updatedAt: 1700000000000 + Number(index) * 1000,
        title,
      }),
    );
  }
}

function writeCommandCodeFixture(home: string): { id: string; title: string } {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const title = 'CC CLI 会话';
  const dir = join(home, 'projects', 'users-x-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, id + '.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-01T00:00:00.000Z', cwd: '/tmp/cc-cli-proj' }) + '\n',
  );
  writeFileSync(join(dir, id + '.meta.json'), JSON.stringify({ title }));
  return { id, title };
}

test('CLI list --json：按 agent 过滤并输出统一结构', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-cli-list-'));
  try {
    const kimiHome = join(dir, 'kimi');
    writeKimiFixture(kimiHome);
    const result = await runCli(['list', '--agent', 'kimi-code', '--home', kimiHome, '--json'], dir);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { sessions: Array<Record<string, unknown>>; warnings: string[] };
    assert.equal(parsed.sessions.length, 2);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.sessions.map((session) => session['sessionId']), ['session_2', 'session_1']);
    assert.equal(parsed.sessions[0]!['agent'], 'kimi-code');

    const limited = await runCli(['list', '--agent', 'kimi-code', '--home', kimiHome, '--limit', '1', '--json'], dir);
    assert.equal(limited.code, 0, limited.stderr);
    assert.equal((JSON.parse(limited.stdout) as { sessions: unknown[] }).sessions.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI list 人类可读输出：agent / updatedAt / title / id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-cli-list-'));
  try {
    const ccHome = join(dir, 'commandcode');
    const { id, title } = writeCommandCodeFixture(ccHome);
    const result = await runCli(['list', '--agent', 'command-code', '--home', ccHome], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /command-code/);
    assert.ok(result.stdout.includes(title), result.stdout);
    assert.ok(result.stdout.includes(id), result.stdout);
    assert.match(result.stdout, /共 1 个会话/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI list：未知 agent / 裸 --home 明确报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-cli-list-'));
  try {
    const unknown = await runCli(['list', '--agent', 'nope'], dir);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /未知 agent/);

    const nakedHome = await runCli(['list', '--home', dir], dir);
    assert.equal(nakedHome.code, 1);
    assert.match(nakedHome.stderr, /--home 需要配合 --agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
