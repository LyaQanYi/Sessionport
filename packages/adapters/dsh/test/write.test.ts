import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { validateIrBundle } from '@sessionport/core';

import { projectKey, sessionLogFilename } from '../src/paths.ts';
import { readDshSession } from '../src/read.ts';
import { verifyDshSession } from '../src/verify.ts';
import { writeDshSession } from '../src/write.ts';
import { buildSyntheticBundle, makeTempDir } from './fixtures.ts';

const CWD = process.cwd();

test('registerWorkspace：新建工作区标题用目录 basename（不是 projectKey 转义串）', async () => {
  const home = await makeTempDir('ws-name-');
  try {
    const report = await writeDshSession(buildSyntheticBundle('/tmp/sessionport-ws-name/0vscode-neko'), {
      home,
      cwd: '/tmp/sessionport-ws-name/0vscode-neko',
      id: 'session-bbbbbbbb-2222-4222-8222-222222222222',
      registerWorkspace: true,
    });
    const state = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'));
    const records = Object.values(state.tables.workspaces) as Array<{ path: string; title: string; sessionIds: string[] }>;
    const record = records.find((r) => r.path === '/tmp/sessionport-ws-name/0vscode-neko');
    assert.ok(record);
    assert.equal(record.title, '0vscode-neko');
    assert.ok(record.sessionIds.includes(report.sessionId));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('projectKey 与官方规则一致（实测样本 + 特殊字符）', () => {
  assert.equal(projectKey('/Users/example/Documents/Coding/N.E.K.O.HarmonyOS'), '--Users-example-Documents-Coding-N.E.K.O.HarmonyOS--');
  assert.equal(projectKey('/Users/example/Documents/GitHub/sessionport'), '--Users-example-Documents-GitHub-sessionport--');
  assert.equal(projectKey('/Users/me/A B/C'), '--Users-me-A~0020B-C--');
  assert.equal(projectKey('/tmp/中文/目录'), '--tmp-~4E2D~6587-~76EE~5F55--');
  assert.equal(projectKey('/a//b'), '--a-b--');
  assert.equal(projectKey('C:\\\\Users\\\\me'), '--C-Users-me--');
  assert.equal(sessionLogFilename(4), 'session.v4.jsonl');
  assert.equal(sessionLogFilename(0), 'session.jsonl');
});

test('合成 IR 写入 + 结构校验 + 读回', async (t) => {
  const home = await makeTempDir('home-write-');
  try {
    const bundle = buildSyntheticBundle(CWD);
    const report = await writeDshSession(bundle, { home });
    assert.equal(report.target, 'dsh');
    assert.ok(report.sessionId.startsWith('session-'));
    assert.ok(report.rows.length > 10);
    assert.equal(report.header.version, 4);
    assert.equal(report.header.isSeeded, false);
    assert.ok(report.paths.some((path) => path.endsWith('session.v4.jsonl.zstd')));
    assert.equal(report.projcacheWritten, false);

    // 损失清单必须显式记录（边界、跨 agent、模型、system prompt、缺失 tool 结果）
    const codes = new Set(report.losses.map((loss) => loss.code));
    for (const code of ['dsh.boundary-dropped', 'dsh.cross-agent-import', 'dsh.model-selection-dropped', 'dsh.system-prompt-synthesized', 'dsh.tool-result-synthesized']) {
      assert.ok(codes.has(code), 'loss 清单缺少 ' + code);
    }

    const verify = await verifyDshSession({ home, sessionId: report.sessionId });
    const failed = verify.checks.filter((check) => !check.ok);
    assert.equal(failed.length, 0, '结构校验失败: ' + JSON.stringify(failed));
    assert.equal(verify.ok, true);
    assert.ok((verify.frames ?? 0) > 3);

    const readBack = await readDshSession(join(report.sessionDir, 'session.v4.jsonl.zstd'), { home, includeChildren: false });
    assert.equal(validateIrBundle(readBack).length, 0);
    assert.equal(readBack.root.source.nativeSessionId, report.sessionId);

    const userTexts = readBack.root.events
      .filter((event) => event.kind === 'message' && event.role === 'user')
      .map((event) => event.kind === 'message' ? event.parts.map((part) => part.type === 'text' ? part.text : '').join('') : '');
    assert.deepEqual(userTexts, ['请检查项目结构', '谢谢', '<system-reminder>runtime note</system-reminder>']);
    const assistantTexts = readBack.root.events
      .filter((event) => event.kind === 'message' && event.role === 'assistant')
      .map((event) => event.kind === 'message' ? event.parts.map((part) => part.type === 'text' ? part.text : '').join('') : '');
    assert.ok(assistantTexts.includes('我先列出目录。'));
    assert.ok(assistantTexts.includes('目录里有 README 和 package.json。'));

    const calls = readBack.root.events.filter((event) => event.kind === 'tool_call');
    assert.deepEqual(calls.map((event) => event.kind === 'tool_call' ? event.callId : ''), ['call_ls', 'call_missing']);
    const results = readBack.root.events.filter((event) => event.kind === 'tool_result');
    assert.equal(results.length, 2);
    assert.ok(results.some((event) => event.kind === 'tool_result' && event.callId === 'call_missing' && event.isError === true));
    assert.ok(readBack.root.events.some((event) => event.kind === 'reasoning'));
    assert.ok(readBack.root.notices.some((notice) => notice.code === 'dsh.non-conversation-event'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('dryRun 只生成不落盘，但仍返回完整报告', async () => {
  const home = await makeTempDir('home-dry-');
  try {
    const bundle = buildSyntheticBundle(CWD);
    const report = await writeDshSession(bundle, { home, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.ok(report.rows.length > 0);
    assert.equal(report.losses.some((loss) => loss.code === 'dsh.cross-agent-import'), true);
    const found = await import('node:fs/promises').then((fs) => fs.access(report.filePath).then(() => true).catch(() => false));
    assert.equal(found, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});