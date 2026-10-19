import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

import { claudeConfigDir, sessionFilePath } from '../src/paths.ts';
import { claudeProjectSlug } from '@sessionport/core';

test('config dir 相对路径会被绝对化（否则 claude 子进程会按自己的 cwd 解析）', () => {
  assert.ok(isAbsolute(claudeConfigDir('some/relative/dir')));
  assert.ok(isAbsolute(claudeConfigDir()));
});

test('project slug 是逐字符替换', () => {
  assert.equal(claudeProjectSlug('/Users/x/Documents/Coding/0neko-kook'), '-Users-x-Documents-Coding-0neko-kook');
  // 点与斜杠各自产生一个 '-'，不合并
  assert.equal(claudeProjectSlug('/a/.b'), '-a--b');
  assert.equal(claudeProjectSlug('/a/b'), '-a-b');
});

test('session file 路径落在 projects/<slug>/<uuid>.jsonl', () => {
  const p = sessionFilePath('/cfg', '/Users/x/proj', '11111111-2222-4333-8444-555555555555');
  assert.equal(p, '/cfg/projects/-Users-x-proj/11111111-2222-4333-8444-555555555555.jsonl');
});
