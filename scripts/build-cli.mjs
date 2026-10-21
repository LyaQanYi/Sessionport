#!/usr/bin/env node
/**
 * 把 CLI 打包成单个可发布的 JS 文件（含 core 与全部 adapter）。
 * 背景：Node 的 type stripping 不支持 node_modules 里的 .ts，npm 安装后无法直接跑源码。
 */
import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

const outfile = 'packages/cli/dist/index.js';
mkdirSync('packages/cli/dist', { recursive: true });
await build({
  entryPoints: ['packages/cli/src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['node:*'],
  sourcemap: false,
  logLevel: 'info',
});
chmodSync(outfile, 0o755);
console.log('built', outfile);