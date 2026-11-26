import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { validateIrBundle } from '@sessionport/core';
import { claudeCodeAdapter } from '../../claude-code/src/index.ts';
import { codexAdapter } from '../../codex/src/index.ts';

import {
  antigravityAdapter,
  cleanGenericOutput,
  extractUserRequestText,
  listAntigravitySessions,
  listAntigravityTranscripts,
  parseAntigravityTranscript,
  readAntigravitySession,
  verifyAntigravitySession,
} from '../src/index.ts';

function writeStepLines(filePath: string, rows: unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n', 'utf8');
}

function seedSummaryDb(
  home: string,
  rows: Array<{
    id: string;
    title?: string;
    preview?: string;
    cwd?: string;
    updatedAt?: string;
    parentId?: string;
    agentName?: string;
    nestingDepth?: number;
    archived?: boolean;
  }>,
): void {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'conversation_summaries.db'));
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT "",
      source TEXT NOT NULL DEFAULT "",
      project_id TEXT NOT NULL DEFAULT "",
      agent_name TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      battle_id TEXT NOT NULL DEFAULT "",
      winning_conversation_id TEXT NOT NULL DEFAULT "",
      not_fully_idle NUMERIC NOT NULL DEFAULT false,
      killed NUMERIC NOT NULL DEFAULT false,
      last_user_input_time DATETIME NOT NULL,
      last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
      app_data_dir TEXT NOT NULL DEFAULT "",
      raw_summary BLOB,
      group_id TEXT NOT NULL DEFAULT ""
    );
    CREATE TABLE conversations_fts (
      conversation_id TEXT,
      archived INTEGER
    );
  `);
  const insert = db.prepare(
    'INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, agent_name, parent_conversation_id, nesting_depth, last_user_input_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO conversations_fts (conversation_id, archived) VALUES (?, ?)');
  for (const row of rows) {
    const uris = row.cwd ? JSON.stringify(['file://' + row.cwd]) : '[]';
    insert.run(
      row.id,
      row.title ?? '',
      row.preview ?? '',
      5,
      row.updatedAt ?? '2026-11-26 10:00:00+00:00',
      uris,
      row.agentName ?? '',
      row.parentId ?? '',
      row.nestingDepth ?? 0,
      row.updatedAt ?? '2026-11-26 10:00:00+00:00',
    );
    if (row.archived) insertFts.run(row.id, 1);
  }
  db.close();
}

test('extractUserRequestText 与 cleanGenericOutput 准确剥离元数据与时间戳头行', () => {
  const normal = extractUserRequestText(
    '<USER_REQUEST>\n帮我看下报错\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ...\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\n...\n</USER_SETTINGS_CHANGE>',
  );
  assert.deepEqual(normal, { text: '帮我看下报错', synthetic: false });

  const compacted = extractUserRequestText('<CONTEXT_SUMMARY>\n## Summary\nDone step 1\n</CONTEXT_SUMMARY>');
  assert.deepEqual(compacted, { text: '## Summary\nDone step 1', synthetic: true });

  const plain = extractUserRequestText('继续处理\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>');
  assert.deepEqual(plain, { text: '继续处理', synthetic: false });

  const cleaned = cleanGenericOutput(
    'Created At: 2026-11-26T10:00:01+08:00\nCompleted At: 2026-11-26T10:00:02+08:00\nShowing lines 1-3\nhello world\n',
  );
  assert.equal(cleaned, 'Showing lines 1-3\nhello world');
});

test('parseAntigravityTranscript：映射 USER_INPUT / PLANNER_RESPONSE / GENERIC(FIFO+ERROR) / CHECKPOINT / 跳过噪音', () => {
  const rows = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      created_at: '2026-11-26T01:00:00Z',
      content: '<USER_REQUEST>\n读取配置并运行测试\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignored\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      created_at: '2026-11-26T01:00:01Z',
      model: 'claude-opus-5-5-high',
      thinking: '先同时读文件和跑单测。',
      content: '我先读取文件并执行测试。',
      tool_calls: [
        { name: 'read_file', args: { Path: '/repo/a.ts', StartLine: 1, EndLine: 10 } },
        JSON.stringify({ name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/repo', WaitMsBeforeAsync: 5000 } }),
      ],
    },
    {
      step_index: 2,
      type: 'SYSTEM_MESSAGE',
      source: 'SYSTEM',
      status: 'DONE',
      created_at: '2026-11-26T01:00:02Z',
      content: 'background notification',
    },
    {
      step_index: 3,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'DONE',
      created_at: '2026-11-26T01:00:03Z',
      content: 'Created At: 2026-11-26T09:00:03+08:00\nCompleted At: 2026-11-26T09:00:03+08:00\nexport const ok = true;',
    },
    {
      step_index: 4,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'ERROR',
      created_at: '2026-11-26T01:00:04Z',
      error: 'exit code 1',
      content: 'Created At: 2026-11-26T09:00:04+08:00\nCompleted At: 2026-11-26T09:00:04+08:00\nFAIL test 1',
    },
    {
      step_index: 5,
      type: 'CHECKPOINT',
      source: 'SYSTEM',
      status: 'DONE',
      created_at: '2026-11-26T01:00:05Z',
      content: '# Resuming from a compaction',
    },
    {
      step_index: 6,
      type: 'USER_INPUT',
      source: 'SYSTEM',
      status: 'DONE',
      created_at: '2026-11-26T01:00:06Z',
      content: '<CONTEXT_SUMMARY>\nPrevious summary\n</CONTEXT_SUMMARY>',
    },
    {
      step_index: 7,
      type: 'ERROR_MESSAGE',
      source: 'SYSTEM',
      status: 'DONE',
      created_at: '2026-11-26T01:00:07Z',
      error: 'stream interrupted',
      content: 'Error: stream interrupted',
    },
  ];

  const bundle = parseAntigravityTranscript(rows.map((r) => JSON.stringify(r)).join('\n'), { sessionId: 'conv-1' });
  assert.deepEqual(validateIrBundle(bundle), []);
  assert.equal(bundle.root.meta.model, 'claude-opus-5-5-high');
  assert.equal(bundle.root.meta.lastPrompt, '读取配置并运行测试');

  const kinds = bundle.root.events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    'message',
    'reasoning',
    'message',
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
    'boundary',
    'message',
  ]);

  const tc1 = bundle.root.events[3]!;
  const tc2 = bundle.root.events[4]!;
  const tr1 = bundle.root.events[5]!;
  const tr2 = bundle.root.events[6]!;
  assert.equal(tc1.kind, 'tool_call');
  assert.equal(tc2.kind, 'tool_call');
  assert.equal(tr1.kind, 'tool_result');
  assert.equal(tr2.kind, 'tool_result');
  if (tc1.kind === 'tool_call' && tr1.kind === 'tool_result' && tc2.kind === 'tool_call' && tr2.kind === 'tool_result') {
    assert.equal(tr1.callId, tc1.callId);
    assert.equal(tr2.callId, tc2.callId);
    assert.equal(tr2.isError, true);
  }
  const resumedUser = bundle.root.events[8]!;
  if (resumedUser.kind === 'message') {
    assert.equal(resumedUser.synthetic, true);
  }

  const noticeCodes = bundle.root.notices.map((n) => n.code);
  assert.ok(noticeCodes.includes('antigravity.system-messages-skipped'));
  assert.ok(noticeCodes.includes('antigravity.error-messages-skipped'));
  assert.ok(noticeCodes.includes('antigravity.failed-tool-result'));
  assert.ok(noticeCodes.includes('antigravity.compact-boundary'));
  assert.ok(noticeCodes.includes('antigravity.synthetic-user-message'));
});

test('readAntigravitySession / listAntigravitySessions：支持子代理、swarm 子会话、DB+annotation 覆盖、compact 告警与跨端工具归一', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-antigravity-'));
  try {
    const mainHome = join(dir, 'antigravity');
    const cliHome = join(dir, 'antigravity-cli');
    const rootId = '11111111-1111-4111-8111-111111111111';
    const subId = '22222222-2222-4222-8222-222222222222';
    const swarmChildId = '33333333-3333-4333-8333-333333333333';
    const cliOnlyId = '44444444-4444-4444-8444-444444444444';

    // 根会话：含 write_file / edit_file / invoke_subagent / update_steps
    writeStepLines(join(mainHome, 'brain', rootId, '.system_generated', 'logs', 'transcript_full.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-26T02:00:00Z',
        content: '<USER_REQUEST>\n实现配置模块\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T02:00:01Z',
        model: 'gemini-4-neon',
        tool_calls: [
          { name: 'write_file', args: { Path: '/repo/cfg.ts', Content: 'export const v = 1;\n' } },
          { name: 'edit_file', args: { Path: '/repo/cfg.ts', Target: 'v = 1', Replacement: 'v = 2' } },
          { name: 'update_steps', args: { steps: [{ title: 'Write config', status: 'done' }] } },
          { name: 'invoke_subagent', args: { Role: 'Code Reviewer', TypeName: 'research', Prompt: 'check cfg.ts' } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-26T02:00:02Z', content: 'Created file.' },
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-26T02:00:03Z', content: 'Edited file.' },
      { step_index: 4, type: 'GENERIC', status: 'DONE', created_at: '2026-11-26T02:00:04Z', content: 'OK' },
      {
        step_index: 5,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T02:00:05Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${subId}",\n  "logAbsoluteUri": "file://${mainHome}/brain/${subId}/.system_generated/logs/transcript_full.jsonl"\n}`,
      },
      {
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T02:00:06Z',
        content: '配置已完成并通过评审。',
      },
    ]);

    // invoke_subagent 子代理（落在 cliHome 里也应能跨目录兜底或主目录找到，这里放 mainHome）
    writeStepLines(join(mainHome, 'brain', subId, '.system_generated', 'logs', 'transcript_full.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-26T02:00:05Z', content: 'check cfg.ts' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T02:00:06Z', content: 'LGTM' },
    ]);

    // swarm worker（没有 invoke_subagent，仅通过 DB parent_conversation_id 关联）
    writeStepLines(join(mainHome, 'brain', swarmChildId, '.system_generated', 'logs', 'transcript_full.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-26T02:00:07Z', content: 'verify build' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T02:00:08Z', content: 'verified' },
    ]);

    // 同一个 rootId 如果同时出现在 cliHome，listAntigravityTranscripts 应优先 mainHome 并去重；cliOnlyId 仅用截断版 transcript.jsonl
    writeStepLines(join(cliHome, 'brain', rootId, '.system_generated', 'logs', 'transcript_full.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-26T01:00:00Z', content: 'duplicate' },
    ]);
    writeStepLines(join(cliHome, 'brain', cliOnlyId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-26T03:00:00Z', content: '<USER_REQUEST>\nCLI 独立会话\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T03:00:01Z', content: '已执行', truncated_fields: ['content'] },
    ]);

    seedSummaryDb(mainHome, [
      { id: rootId, title: 'DB Root Title', cwd: '/tmp/repo-main', updatedAt: '2026-11-26 02:00:06+00:00' },
      { id: swarmChildId, parentId: rootId, agentName: 'verifier', nestingDepth: 1, updatedAt: '2026-11-26 02:00:08+00:00', archived: true },
    ]);
    mkdirSync(join(mainHome, 'annotations'), { recursive: true });
    writeFileSync(join(mainHome, 'annotations', `${rootId}.pbtxt`), 'title:"Annotation Overrides DB"  plan_execute:true\n', 'utf8');

    // listAntigravitySessions（单目录）
    const listedMain = await listAntigravitySessions({ home: mainHome });
    assert.equal(listedMain.length, 3);
    const rootSummary = listedMain.find((r) => r.sessionId === rootId);
    assert.equal(rootSummary?.title, 'Annotation Overrides DB');
    assert.equal(rootSummary?.cwd, '/tmp/repo-main');
    const swarmRow = listedMain.find((r) => r.sessionId === swarmChildId);
    assert.equal(swarmRow?.parentSessionId, rootId);
    assert.equal(swarmRow?.archived, true);

    // 合并扫描去重（mainHome 优先于 cliHome）
    const mergedFiles = listAntigravityTranscripts([mainHome, cliHome]);
    assert.equal(mergedFiles.length, 4);
    assert.equal(mergedFiles.find((f) => f.conversationId === rootId)?.home, mainHome);
    assert.equal(mergedFiles.find((f) => f.conversationId === cliOnlyId)?.isCompact, true);

    // 读取 root（含 2 个 children）
    const bundle = await readAntigravitySession(rootId, { home: mainHome });
    assert.equal(bundle.root.meta.title, 'Annotation Overrides DB');
    assert.equal(bundle.children.length, 2);
    assert.equal(bundle.children.find((c) => c.session.source.nativeSessionId === subId)?.label, 'Code Reviewer');
    assert.equal(bundle.children.find((c) => c.session.source.nativeSessionId === swarmChildId)?.label, 'verifier');

    // 读取 cliOnly compact transcript -> 带 truncated 警告与首条用户文本标题
    const cliBundle = await readAntigravitySession(cliOnlyId, { home: cliHome });
    assert.equal(cliBundle.root.meta.title, 'CLI 独立会话');
    assert.ok(cliBundle.root.notices.some((n) => n.code === 'antigravity.compact-transcript-truncated'));

    // verify PASS & FAIL
    const passVerify = await verifyAntigravitySession(rootId, { home: mainHome });
    assert.equal(passVerify.ok, true, JSON.stringify(passVerify.checks.filter((c) => !c.ok)));
    const failVerify = await verifyAntigravitySession('missing-conv-id', { home: mainHome });
    assert.equal(failVerify.ok, false);

    // 端到端写往 Claude Code & Codex 并触发跨源工具归一
    const claudeOut = await claudeCodeAdapter.write!(bundle, { home: join(dir, 'claude-dst'), dryRun: true, cwd: '/tmp/repo-main' });
    assert.ok(claudeOut.report.losses?.some((l) => l.code === 'claude.tool-normalized'));
    const claudeRows = JSON.stringify(claudeOut.report.rows);
    assert.match(claudeRows, /"name":"Write"/);
    assert.match(claudeRows, /"name":"Edit"/);
    assert.match(claudeRows, /"name":"TodoWrite"/);

    const codexOut = await codexAdapter.write!(bundle, { home: join(dir, 'codex-dst'), dryRun: true, cwd: '/tmp/repo-main' });
    assert.ok(codexOut.report.losses?.some((l) => l.code === 'codex.tool-normalized'));
    const codexText = JSON.stringify(codexOut.report.rows);
    assert.match(codexText, /apply_patch/);
    assert.match(codexText, /update_plan/);

    // adapter metadata
    assert.equal(antigravityAdapter.id, 'antigravity');
    assert.equal(typeof antigravityAdapter.write, 'function');
    assert.equal(antigravityAdapter.supportsInPlaceRewrite, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
