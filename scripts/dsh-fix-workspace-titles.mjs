#!/usr/bin/env node
// 修复 DSH 工作区标题：早前版本把 projectKey 转义串（Users-lyaqanyi-Documents-...）
// 当成了标题。这个脚本把所有「标题看起来是路径转义串」的工作区改回目录 basename。
//
// 用法:
//   node scripts/dsh-fix-workspace-titles.mjs [--home ~/.dsh] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const home = join(arg('home', join(homedir(), '.dsh')), 'storages', 'workspace.json');
const dryRun = process.argv.includes('--dry-run');
if (!existsSync(home)) {
  console.error('找不到 workspace.json:', home);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(home, 'utf8'));
const workspaces = (doc && doc.tables && doc.tables.workspaces) || {};
let changed = 0;
for (const record of Object.values(workspaces)) {
  const path = String(record.path ?? '');
  if (!path) continue;
  const expected = basename(path) || 'workspace';
  const title = typeof record.title === 'string' ? record.title : '';
  // 转义串形如 'Users-lyaqanyi-Documents-Coding-0vscode-neko'：没有斜杠、连字符很多、以转义前缀开头
  const looksMangled = title.length === 0 || (!title.includes('/') && title.split('-').length > 4 && (title.startsWith('Users-') || title.startsWith('private-') || title.startsWith('var-')));
  if (looksMangled && title !== expected) {
    console.log('fix:', JSON.stringify(title), '->', JSON.stringify(expected), '(' + path + ')');
    record.title = expected;
    changed += 1;
  }
}
if (dryRun) {
  console.log('(--dry-run)', changed, 'would change');
  process.exit(0);
}
if (changed > 0) {
  mkdirSync(join(process.cwd(), '.tmp', 'cc-backups'), { recursive: true });
  const backup = join(process.cwd(), '.tmp', 'cc-backups', 'workspace-' + Date.now() + '.json');
  copyFileSync(home, backup);
  writeFileSync(home, JSON.stringify(doc, null, 2) + '\n');
  console.log('updated', changed, 'workspace title(s); backup:', backup);
} else {
  console.log('no changes');
}