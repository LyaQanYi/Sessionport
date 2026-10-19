import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateIrBundle } from '@sessionport/core';

import { readDshSession, summarizeDshBundle } from '../src/read.ts';

async function largestRealSession(): Promise<string | undefined> {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
  if (!existsSync(root)) return undefined;
  const candidates: string[] = [];
  for (const project of await readdir(root)) {
    for (const session of await readdir(join(root, project)).catch(() => [] as string[])) {
      const candidate = join(root, project, session, 'session.v4.jsonl.zstd');
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return undefined;
  const sized = await Promise.all(candidates.map(async (candidate) => ({ candidate, size: (await stat(candidate)).size })));
  sized.sort((a, b) => b.size - a.size);
  return sized[0]!.candidate;
}

test('读取真实 DSH 会话（无样本时 skip）', async (t) => {
  const sample = await largestRealSession();
  if (sample === undefined) {
    t.skip('no real ~/.dsh sessions');
    return;
  }
  const bundle = await readDshSession(sample);
  assert.equal(validateIrBundle(bundle).length, 0, 'IR 链/head 必须自洽');
  assert.equal(bundle.root.source.agent, 'dsh');
  assert.equal(bundle.root.source.formatVersion, '4');
  assert.ok(bundle.root.events.length > 5, '真实会话应有对话事件');
  assert.ok(bundle.root.head !== null);
  assert.ok(bundle.root.meta.cwd !== undefined);
  assert.ok(bundle.root.notices.length > 0, '非对话事件要按类型进 notices');
  const kinds = new Set(bundle.root.events.map((event) => event.kind));
  assert.ok(kinds.has('message'));
  const text = summarizeDshBundle(bundle);
  assert.ok(text.includes('root dsh:'));
});

test('按 session id 读取（真实样本，无样本时 skip）', async (t) => {
  const sample = await largestRealSession();
  if (sample === undefined) {
    t.skip('no real ~/.dsh sessions');
    return;
  }
  const dir = sample.slice(0, sample.lastIndexOf('/'));
  const id = dir.slice(dir.lastIndexOf('/') + 1);
  const bundle = await readDshSession(id);
  assert.equal(bundle.root.source.nativeSessionId, id);
});

test('不存在的会话应抛错', async () => {
  await assert.rejects(readDshSession('session-does-not-exist-0000'), /找不到 DSH 会话|DSH 会话不存在/u);
});
