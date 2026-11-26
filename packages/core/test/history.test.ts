import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyUndo,
  beginBackup,
  collectOutcomePaths,
  emptyRegistry,
  latestUndoableRecord,
  listHistory,
  loadHistoryRecord,
  planUndo,
  pruneHistory,
  saveRegistry,
  upsertRef,
} from '../src/index.ts';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('history: 新建写入备份 -> dryRun 无副作用 -> undo 删除新建文件并清理空父目录 -> 拒绝二次 undo', async () => {
  const dir = makeTempDir('sessionport-hist-fresh-');
  const stateHome = join(dir, 'state');
  const targetFile = join(dir, 'target', 'sub', 'session.jsonl');
  try {
    const handle = beginBackup({
      stateHome,
      action: 'push',
      sourceKey: 'codex:s1',
      target: 'claude-code',
      targetId: 't1',
      plannedPaths: [targetFile],
      includeRegistry: false,
    });
    mkdirSync(join(dir, 'target', 'sub'), { recursive: true });
    writeFileSync(targetFile, '{"hello":"world"}\n', 'utf8');
    const record = handle.finalize({ actualPaths: [targetFile] });
    assert.equal(record.files.length, 1);
    assert.equal(record.files[0]!.existed, false);

    const plan = planUndo(record);
    assert.deepEqual(plan.filesToDelete, [targetFile]);
    assert.deepEqual(plan.filesToRestore, []);

    const dry = await applyUndo(record, { stateHome, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(existsSync(targetFile), true);
    assert.equal(latestUndoableRecord(stateHome)?.id, record.id);

    const real = await applyUndo(record, { stateHome });
    assert.equal(real.dryRun, false);
    assert.deepEqual(real.deletedFiles, [targetFile]);
    assert.equal(existsSync(targetFile), false);
    assert.equal(existsSync(join(dir, 'target', 'sub')), false);
    assert.equal(latestUndoableRecord(stateHome), undefined);

    const reloaded = loadHistoryRecord(record.id, stateHome);
    assert.ok(reloaded?.undoneAt);
    await assert.rejects(() => applyUndo(reloaded!, { stateHome }), /已经撤销过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history: 覆盖写入字节级还原 + registry 回滚 + missingFiles 与 abort 清理', async () => {
  const dir = makeTempDir('sessionport-hist-overwrite-');
  const stateHome = join(dir, 'state');
  const targetFile = join(dir, 'existing.jsonl');
  const addedChild = join(dir, 'child.jsonl');
  try {
    const originalBytes = Buffer.from('{"line":1,"raw":"原始"}\n', 'utf8');
    writeFileSync(targetFile, originalBytes);

    const reg = emptyRegistry();
    upsertRef(reg, {
      sourceKey: 'codex:s1',
      target: 'claude-code',
      targetId: 't1',
      targetPath: targetFile,
      unit: 'rows',
      targetUnits: 1,
      sourceEvents: 1,
      sourceHead: 'e1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const regFile = saveRegistry(reg, stateHome);

    // 先验证 abort 不会留 manifest
    const aborted = beginBackup({
      stateHome,
      action: 'sync',
      sourceKey: 'codex:s1',
      target: 'claude-code',
      targetId: 't1',
      plannedPaths: [targetFile],
    });
    aborted.abort();
    assert.equal(listHistory(stateHome).length, 0);

    const handle = beginBackup({
      stateHome,
      action: 'sync',
      sourceKey: 'codex:s1',
      target: 'claude-code',
      targetId: 't1',
      plannedPaths: [targetFile],
      includeRegistry: true,
    });
    writeFileSync(targetFile, '{"line":999}\n', 'utf8');
    writeFileSync(addedChild, '{"child":true}\n', 'utf8');
    upsertRef(reg, {
      sourceKey: 'codex:s1',
      target: 'claude-code',
      targetId: 't2',
      targetPath: targetFile,
      unit: 'rows',
      targetUnits: 9,
      sourceEvents: 9,
      sourceHead: 'e9',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    saveRegistry(reg, stateHome);
    const record = handle.finalize({ targetId: 't2', actualPaths: [targetFile, addedChild] });

    // 删除 addedChild 模拟用户已手动移除新增子文件，验证 missingFiles 正常记录
    rmSync(addedChild);

    const undone = await applyUndo(record, { stateHome });
    assert.deepEqual(undone.restoredFiles, [targetFile]);
    assert.deepEqual(undone.missingFiles, [addedChild]);
    assert.equal(undone.registryRestored, true);
    assert.deepEqual(readFileSync(targetFile), originalBytes);
    assert.match(readFileSync(regFile, 'utf8'), /"targetId": "t1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history: 首次创建 registry 时 undo 删除 registry；pruneHistory 保留最新 N 条；collectOutcomePaths 去重', async () => {
  const dir = makeTempDir('sessionport-hist-prune-');
  const stateHome = join(dir, 'state');
  const regTarget = join(dir, 'target.jsonl');
  try {
    const h = beginBackup({
      stateHome,
      action: 'sync',
      sourceKey: 'dsh:s1',
      target: 'command-code',
      targetId: 'c1',
      plannedPaths: [regTarget],
      includeRegistry: true,
    });
    const reg = emptyRegistry();
    const regPath = saveRegistry(reg, stateHome);
    writeFileSync(regTarget, 'line\n', 'utf8');
    const rec = h.finalize();
    const res = await applyUndo(rec, { stateHome });
    assert.equal(res.registryDeleted, true);
    assert.equal(existsSync(regPath), false);

    // 连续创建 4 条历史并裁切至最新 2 条
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const b = beginBackup({
        stateHome,
        action: 'push',
        sourceKey: 'dsh:s' + i,
        target: 'claude-code',
        targetId: 't' + i,
        plannedPaths: [join(dir, 'f' + i + '.jsonl')],
      });
      b.finalize();
      ids.push(b.id);
    }
    const removed = pruneHistory(stateHome, 2);
    assert.equal(removed, 3); // 之前的 1 条 + 本次最老 2 条 = 3 条，剩余最新 2 条
    const remaining = listHistory(stateHome, 10);
    assert.equal(remaining.length, 2);
    assert.deepEqual(remaining.map((r) => r.id), [ids[3], ids[2]]);

    const collected = collectOutcomePaths({
      target: 'claude-code',
      targetId: 'x',
      paths: [join(dir, 'main.jsonl')],
      unit: 'rows',
      units: 1,
      report: {
        children: [{ filePath: join(dir, 'sub.jsonl'), metaPath: join(dir, 'sub.meta.json') }],
      },
    });
    assert.equal(collected.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
