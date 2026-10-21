#!/usr/bin/env node
/**
 * npm 发布前准备：把根目录的 LICENSE/NOTICE 复制进每个发布包，并生成最小 README。
 * 这些文件是发布产物，不入库（见 .gitignore）。
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const packageDirs = [
  'packages/core',
  'packages/cli',
  ...readdirSync(join(root, 'packages/adapters')).map((name) => 'packages/adapters/' + name),
];

let prepared = 0;
for (const dir of packageDirs) {
  const pkgPath = join(root, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const file of ['LICENSE', 'NOTICE']) {
    const source = join(root, file);
    if (!existsSync(source)) throw new Error('missing root ' + file);
    copyFileSync(source, join(root, dir, file));
  }
  const readme = [
    '# ' + pkg.name,
    '',
    pkg.description ?? '',
    '',
    'This package is part of [sessionport](' + (pkg.homepage ?? 'https://github.com/sessionport/sessionport') + ') — a local-first CLI that moves live AI coding-agent sessions between CLIs via a lossless IR.',
    '',
    '- Node.js >= 24 (TypeScript sources are executed directly via Node type stripping).',
    '- License: Apache-2.0 (see LICENSE / NOTICE).',
    '',
  ].join('\n');
  writeFileSync(join(root, dir, 'README.md'), readme);
  prepared += 1;
  console.log('prepared', pkg.name + '@' + pkg.version);
}
console.log('done:', prepared, 'packages');