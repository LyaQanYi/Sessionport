import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { validateIrBundle } from '@sessionport/core';
import {
  commandCodeProjectSlug,
  isCcHeader,
  listCommandCodeSessions,
  readCommandCodeSession,
  readCommandCodeSessionDetailed,
} from '../src/index.ts';

const PROJECTS_ROOT = join(homedir(), '.commandcode', 'projects');

async function realProjectDirs(): Promise<Array<{ dir: string; transcript: string; cwd: string }>> {
  if (!existsSync(PROJECTS_ROOT)) return [];
  const out: Array<{ dir: string; transcript: string; cwd: string }> = [];
  for (const entry of await readdir(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PROJECTS_ROOT, entry.name);
    const names = await readdir(dir).catch(() => [] as string[]);
    const transcript = names.find((name) => name.endsWith('.jsonl') && !name.includes('.checkpoints.'));
    if (!transcript) continue;
    const firstLine = (await readFile(join(dir, transcript), 'utf8')).split('\n')[0] ?? '';
    try {
      const header = JSON.parse(firstLine) as unknown;
      if (isCcHeader(header)) out.push({ dir, transcript: join(dir, transcript), cwd: header.cwd });
    } catch {
      // 忽略坏样本
    }
  }
  return out;
}

test('读取真实 Command Code 会话：结构、链、工具配对', { skip: existsSync(PROJECTS_ROOT) ? false : '本机没有 ~/.commandcode 真实会话' }, async () => {
  const sessions = await listCommandCodeSessions();
  assert.ok(sessions.length > 0, '应能列出真实会话');
  const sample = sessions[0]!;
  const bundle = await readCommandCodeSession(sample.nativePath);

  assert.equal(bundle.irVersion, '0.1');
  assert.equal(bundle.root.source.agent, 'command-code');
  assert.equal(bundle.root.source.formatVersion, '3');
  assert.ok(bundle.root.source.nativeSessionId && bundle.root.source.nativeSessionId.length > 0);
  assert.ok(bundle.root.meta.cwd && bundle.root.meta.cwd.startsWith('/'));
  assert.ok(bundle.root.events.length > 0);
  assert.equal(bundle.root.head, bundle.root.events.at(-1)!.id);

  // IR 事件链 + head 自检
  assert.deepEqual(validateIrBundle(bundle), []);

  // tool_call / tool_result 一一配对
  const calls = bundle.root.events.filter((event) => event.kind === 'tool_call');
  const results = bundle.root.events.filter((event) => event.kind === 'tool_result');
  const resultIds = new Set(results.map((event) => (event as { callId: string }).callId));
  for (const call of calls) assert.ok(resultIds.has((call as { callId: string }).callId));
  assert.ok(calls.length > 0, '真实样本里应有工具调用');

  // reasoning 可保留（thinking block -> IR reasoning）
  assert.ok(bundle.root.events.some((event) => event.kind === 'reasoning'));
});

test('按会话 id / 项目目录读取同一份 transcript', { skip: existsSync(PROJECTS_ROOT) ? false : '本机没有真实会话' }, async () => {
  const sessions = await listCommandCodeSessions();
  const sample = sessions[0]!;
  const byId = await readCommandCodeSession(sample.sessionId);
  assert.equal(byId.root.events.length, (await readCommandCodeSession(sample.nativePath)).root.events.length);
  const byDir = await readCommandCodeSession(sample.nativePath.replace(/\/[^/]+\.jsonl$/, ''), { sessionId: sample.sessionId });
  assert.equal(byDir.root.source.nativeSessionId, sample.sessionId);
});

test('项目 slug 规则：用真实 cwd 反推目录名', { skip: existsSync(PROJECTS_ROOT) ? false : '本机没有真实会话' }, async () => {
  const samples = await realProjectDirs();
  assert.ok(samples.length > 0);
  for (const sample of samples) {
    const dirName = sample.dir.split('/').at(-1)!;
    assert.equal(commandCodeProjectSlug(sample.cwd), dirName, 'slug 不匹配：' + sample.cwd);
  }
});

test('非 Command Code 文件明确报错', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'cc-read-bad-'));
  try {
    const file = join(dir, 'not-cc.jsonl');
    await writeFile(file, JSON.stringify({ type: 'not-a-session', hello: 'world' }) + '\n');
    await assert.rejects(() => readCommandCodeSession(file), /不是 Command Code v3 会话/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('详细读取结果带 header/metaFile/notices', { skip: existsSync(PROJECTS_ROOT) ? false : '本机没有真实会话' }, async () => {
  const sessions = await listCommandCodeSessions();
  const detailed = await readCommandCodeSessionDetailed(sessions[0]!.nativePath);
  assert.equal(detailed.header.type, 'session');
  assert.equal(detailed.header.version, 3);
  assert.ok(Array.isArray(detailed.notices));
  assert.equal(detailed.sessionId, detailed.header.id);
});

