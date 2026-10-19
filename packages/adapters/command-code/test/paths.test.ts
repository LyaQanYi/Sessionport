import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ccSessionPaths,
  commandCodeProjectDir,
  commandCodeProjectSlug,
  isCcTranscriptFileName,
  isoToMs,
  newEntryId,
  normalizeIso,
} from '../src/index.ts';

test('项目目录 slug 与真实样本一致（规则来自 @sindresorhus/slugify 默认参数）', () => {
  const cases: Array<[string, string]> = [
    ['/Users/lyaqanyi/Documents/GitHub/NEKO', 'users-lyaqanyi-documents-git-hub-neko'],
    ['/Users/lyaqanyi/Documents/GitHub/N.E.K.O.Verse', 'users-lyaqanyi-documents-git-hub-n-e-k-o-verse'],
    ['/Users/lyaqanyi/Documents/Coding/N.E.K.O.HarmonyOS', 'users-lyaqanyi-documents-coding-n-e-k-o-harmony-os'],
    ['/Users/lyaqanyi/Documents/Coding/0TEST', 'users-lyaqanyi-documents-coding-0-test'],
    ['/Users/lyaqanyi/Documents/Coding/0neko-mobile', 'users-lyaqanyi-documents-coding-0neko-mobile'],
    ['/Users/lyaqanyi/Documents/GitHub/vscodefork', 'users-lyaqanyi-documents-git-hub-vscodefork'],
    ['/tmp/sessionport-cc-test-project', 'tmp-sessionport-cc-test-project'],
    ['', 'root'],
  ];
  for (const [cwd, slug] of cases) assert.equal(commandCodeProjectSlug(cwd), slug, cwd);
});

test('session 路径按 <home>/projects/<slug>/<id>.jsonl 拼装', () => {
  const projectDir = commandCodeProjectDir('/tmp/cc-home', '/Users/x/GitHub/NEKO');
  assert.equal(projectDir, '/tmp/cc-home/projects/users-x-git-hub-neko');
  const paths = ccSessionPaths(projectDir, 'abc');
  assert.equal(paths.jsonl, projectDir + '/abc.jsonl');
  assert.equal(paths.meta, projectDir + '/abc.meta.json');
  assert.equal(paths.checkpoints, projectDir + '/abc.checkpoints.jsonl');
});

test('transcript 文件名过滤（排除 checkpoints/prompts/v2.bak）', () => {
  assert.equal(isCcTranscriptFileName('abc.jsonl'), true);
  assert.equal(isCcTranscriptFileName('abc.checkpoints.jsonl'), false);
  assert.equal(isCcTranscriptFileName('abc.prompts.jsonl'), false);
  assert.equal(isCcTranscriptFileName('abc.v2.bak'), false);
  assert.equal(isCcTranscriptFileName('abc.meta.json'), false);
});

test('时间戳工具：ISO 规范化与毫秒转换', () => {
  assert.equal(normalizeIso('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(normalizeIso('not-a-date'), undefined);
  assert.equal(isoToMs('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(isoToMs(undefined), undefined);
});

test('entry id 是 8 位 hex 且可避重', () => {
  const used = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const id = newEntryId(used);
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.equal(used.has(id), false);
    used.add(id);
  }
});

