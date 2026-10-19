import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decompressZstdJsonl, readZstdJsonl, scanZstdFrames, writeZstdJsonl } from '../src/zstd.ts';
import { makeTempDir } from './fixtures.ts';

test('zstd 多帧往返：首帧单独放会话头，逐帧可解', async () => {
  const dir = await makeTempDir('zstd-');
  try {
    const path = join(dir, 'session.v4.jsonl.zstd');
    const lines = ['{"type":"session","version":4,"id":"session-test"}', ...Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: 'x/y', seq: i, time: i, data: {} }))];
    const written = await writeZstdJsonl(path, lines, { headerLines: 1, batchSize: 3 });
    assert.equal(written.frames, 1 + Math.ceil(12 / 3));

    const buffer = await readFile(path);
    const scan = scanZstdFrames(buffer);
    assert.equal(scan.frames.length, written.frames);
    assert.equal(scan.tornStart, undefined);

    const decoded = decompressZstdJsonl(buffer);
    assert.deepEqual(decoded.lines, lines);

    const viaFile = await readZstdJsonl(path);
    assert.deepEqual(viaFile.lines, lines);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zstd 尾部撕裂帧容忍：保留完整行并报告 tornStart', async () => {
  const dir = await makeTempDir('zstd-torn-');
  try {
    const path = join(dir, 'torn.v4.jsonl.zstd');
    const lines = ['{"type":"session"}', '{"type":"a","seq":0,"time":0,"data":{}}', '{"type":"b","seq":1,"time":1,"data":{}}'];
    await writeZstdJsonl(path, lines, { headerLines: 1, batchSize: 1 });
    const intact = await readFile(path);
    const scan = scanZstdFrames(intact);
    const lastFrame = scan.frames[scan.frames.length - 1]!;
    const partial = intact.subarray(lastFrame.start, lastFrame.start + Math.max(4, Math.floor((lastFrame.end - lastFrame.start) / 2)));
    const torn = Buffer.concat([intact, partial]);
    const decoded = decompressZstdJsonl(torn);
    assert.notEqual(decoded.tornStart, undefined);
    assert.ok(decoded.lines.length >= 2);
    assert.equal(decoded.lines[0], lines[0]);
    assert.equal(decoded.lines[1], lines[1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真实 DSH 会话文件是多帧且可完整解出（无样本时 skip）', async (t) => {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
  if (!existsSync(root)) {
    t.skip('no real ~/.dsh/sessions');
    return;
  }
  const { readdir, stat } = await import('node:fs/promises');
  const projects = await readdir(root);
  const candidates: string[] = [];
  for (const project of projects) {
    const sessions = await readdir(join(root, project)).catch(() => [] as string[]);
    for (const session of sessions) {
      const candidate = join(root, project, session, 'session.v4.jsonl.zstd');
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    t.skip('no sample session file');
    return;
  }
  const sizes = await Promise.all(candidates.map(async (candidate) => ({ candidate, size: (await stat(candidate)).size })));
  sizes.sort((a, b) => b.size - a.size);
  const sample = sizes[0]!.candidate;
  const decoded = await readZstdJsonl(sample);
  assert.ok(decoded.frames.length > 1, 'real session must be multi-frame');
  assert.ok(decoded.lines.length > 10);
  assert.equal(decoded.tornStart, undefined);
  const header = JSON.parse(decoded.lines[0]) as { type?: string; version?: number };
  assert.equal(header.type, 'session');
  assert.equal(header.version, 4);
});
