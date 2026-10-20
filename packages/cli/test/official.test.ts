import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { officialSupport, OFFICIAL_IMPORTS, planOfficialImport, verifyOfficialImport } from '../src/official.ts';

function fakeBundle(agent: string, nativePath: string, cwd: string, title: string): never {
  return {
    irVersion: '0.1',
    root: {
      id: 'x',
      source: { agent, nativePath, nativeSessionId: 'x' },
      meta: { cwd, title },
      events: [],
      notices: [],
      head: 'x',
    },
    children: [],
  } as never;
}

test('officialSupport：ZCode/Qoder 有官方导入，Cursor 没有', () => {
  assert.equal(officialSupport('zcode').supported, true);
  assert.equal(officialSupport('qoder').supported, true);
  assert.equal(officialSupport('cursor').supported, false);
  assert.deepEqual(officialSupport('zcode').sources, ['claude-code']);
  assert.deepEqual(officialSupport('qoder').sources, ['workbuddy']);
  assert.ok(OFFICIAL_IMPORTS.length >= 3);
});

test('planOfficialImport：源/目标不匹配时明确报错', async () => {
  const bundle = fakeBundle('workbuddy', '/tmp/x.jsonl', '/tmp', 't');
  await assert.rejects(() => planOfficialImport({ target: 'zcode', bundle }), /只扫描 Claude Code/);
  const claude = fakeBundle('claude-code', '/tmp/y.jsonl', '/tmp', 't');
  await assert.rejects(() => planOfficialImport({ target: 'qoder', bundle: claude }), /来源是 WorkBuddy/);
  await assert.rejects(() => planOfficialImport({ target: 'cursor', bundle: claude }), /没有官方导入路径/);
});

test('planOfficialImport：ZCode 准备已存在的 Claude transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-official-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"user"}\n');
    const bundle = fakeBundle('claude-code', file, '/tmp/proj', '标题');
    const result = await planOfficialImport({ target: 'zcode', bundle });
    assert.equal(result.prepared, file);
    assert.ok(result.steps.some((step) => step.includes('迁移会话数据')));
    assert.equal(result.opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planOfficialImport：Qoder 确认 WorkBuddy 数据目录存在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-official-'));
  try {
    mkdirSync(join(dir, 'projects'), { recursive: true });
    const bundle = fakeBundle('workbuddy', join(dir, 'projects', 'p', 's.jsonl'), '/tmp/proj', '标题');
    const result = await planOfficialImport({ target: 'qoder', bundle, home: dir });
    assert.equal(result.prepared, join(dir, 'projects'));
    assert.ok(result.steps.some((step) => step.includes('数据导入')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyOfficialImport：ZCode 从 tasks-index 里匹配 cwd/标题', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-official-'));
  try {
    mkdirSync(join(dir, '.zcode', 'v2'), { recursive: true });
    const db = new DatabaseSync(join(dir, '.zcode', 'v2', 'tasks-index.sqlite'));
    db.exec('create table tasks (task_id text primary key, title text, workspace_path text, migration_source text, updated_at integer)');
    db.prepare('insert into tasks values (?, ?, ?, ?, ?)').run('t1', '标题', '/tmp/proj', 'claude-code', Date.now());
    db.close();
    const result = await verifyOfficialImport({ target: 'zcode', cwd: '/tmp/proj', home: dir });
    assert.equal(result.ok, true);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.id, 't1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyOfficialImport：Qoder 从 projects/*.jsonl 里匹配 cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-official-'));
  try {
    const projectDir = join(dir, '.qoder-cn', 'projects', 'p1');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 's1.jsonl'),
      JSON.stringify({ type: 'workspace-directories', directories: ['/tmp/proj'] }) + '\n' +
        JSON.stringify({ type: 'custom-title', customTitle: '标题' }) + '\n',
    );
    const result = await verifyOfficialImport({ target: 'qoder', cwd: '/tmp/proj', home: dir });
    assert.equal(result.ok, true);
    assert.equal(result.matches.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
