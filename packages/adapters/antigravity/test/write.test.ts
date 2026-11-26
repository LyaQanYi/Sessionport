import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { IR_VERSION, validateIrBundle } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';

import {
  antigravityAdapter,
  countAntigravityTarget,
  lookupAntigravityProjectId,
  writeAntigravitySession,
} from '../src/index.ts';

function chain(events: IrEventDraft[]): IrEvent[] {
  return events.map((event, index) => ({
    ...event,
    parentId: index === 0 ? null : events[index - 1]!.id,
  })) as IrEvent[];
}

function makeSampleBundle(opts: { events?: IrEvent[]; withChildren?: boolean; cwd?: string } = {}): IrBundle {
  const cwd = opts.cwd ?? '/tmp/demo-project';
  const events =
    opts.events ??
    chain([
      {
        kind: 'message',
        id: 'e1',
        at: '2026-11-26T08:00:00.000Z',
        role: 'user',
        parts: [{ type: 'text', text: '请帮我排查登录超时问题' }],
      },
      {
        kind: 'reasoning',
        id: 'e2',
        at: '2026-11-26T08:00:01.000Z',
        reasoning: { kind: 'plain', text: '先检查 auth 中间件实现。' },
      },
      {
        kind: 'tool_call',
        id: 'e3',
        at: '2026-11-26T08:00:02.000Z',
        callId: 'c1',
        name: 'exec_command',
        input: { cmd: 'npm test' },
      },
      {
        kind: 'tool_result',
        id: 'e4',
        at: '2026-11-26T08:00:03.000Z',
        callId: 'c1',
        isError: true,
        content: [{ type: 'text', text: 'FAIL auth.test.ts: timeout exceeded' }],
      },
      {
        kind: 'message',
        id: 'e5',
        at: '2026-11-26T08:00:04.000Z',
        role: 'assistant',
        parts: [{ type: 'text', text: '定位到 token 刷新竞争导致超时，已准备修复方案。' }],
      },
    ]);

  return {
    irVersion: IR_VERSION,
    createdAt: '2026-11-26T08:00:05.000Z',
    root: {
      id: 'ir_src_claude',
      source: { agent: 'claude-code', nativeSessionId: 'claude-sess-01' },
      meta: {
        cwd,
        title: '排查登录超时',
        model: 'claude-sonnet-4-5',
        createdAt: '2026-11-26T08:00:00.000Z',
      },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: opts.withChildren
      ? [
          {
            label: 'auth-researcher',
            parentSessionId: 'ir_src_claude',
            session: {
              id: 'ir_child_1',
              source: { agent: 'claude-code', nativeSessionId: 'child-01' },
              meta: { createdAt: '2026-11-26T08:00:01.500Z', title: 'Auth Researcher' },
              events: chain([
                {
                  kind: 'message',
                  id: 'ce1',
                  at: '2026-11-26T08:00:01.500Z',
                  role: 'user',
                  parts: [{ type: 'text', text: '检查 authMiddleware 锁逻辑' }],
                },
                {
                  kind: 'message',
                  id: 'ce2',
                  at: '2026-11-26T08:00:02.500Z',
                  role: 'assistant',
                  parts: [{ type: 'text', text: '发现 refreshPromise 未复用的并发 bug。' }],
                },
              ]),
              head: 'ce2',
              notices: [],
            },
          },
        ]
      : [],
  };
}

function seedProjectSummaryDb(home: string, cwd: string, projectId: string): void {
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
      deleted NUMERIC NOT NULL DEFAULT false,
      archived NUMERIC NOT NULL DEFAULT false,
      model_name TEXT NOT NULL DEFAULT "",
      last_user_input_time DATETIME NOT NULL DEFAULT ""
    );
  `);
  db.prepare(
    `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('existing-conv-1', 'Existing', '', 1, '2026-11-26T07:00:00Z', JSON.stringify(['file://' + cwd]), projectId);
  db.close();
}

test('antigravityAdapter 声明 supportsInPlaceRewrite = false 与 write/countTarget', () => {
  assert.equal(antigravityAdapter.id, 'antigravity');
  assert.equal(antigravityAdapter.supportsInPlaceRewrite, false);
  assert.equal(typeof antigravityAdapter.write, 'function');
  assert.equal(typeof antigravityAdapter.countTarget, 'function');
});

test('dryRun 不落盘文件且正确上报 handoff-file / subagents-dropped losses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-agy-dry-'));
  try {
    const bundle = makeSampleBundle({ withChildren: true });
    const outcome = await writeAntigravitySession(bundle, {
      home: dir,
      id: 'handoff-dry-1',
      dryRun: true,
      handoffOnly: true,
    });

    assert.equal(outcome.target, 'antigravity');
    assert.equal(outcome.targetId, 'handoff-dry-1');
    assert.equal(outcome.paths.length, 2);
    assert.ok(outcome.units > 0);
    assert.equal(existsSync(outcome.paths[0]!), false);
    assert.equal(existsSync(outcome.paths[1]!), false);

    const codes = new Set((outcome.report.losses ?? []).map((l) => l.code));
    assert.ok(codes.has('antigravity.degraded-context-handoff'));
    assert.ok(codes.has('antigravity.handoff-file-only'));
    assert.ok(codes.has('antigravity.subagents-dropped'));
    assert.equal(outcome.report.delivery, 'handoff-file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoffOnly 落盘 .md 与 .ir.json，支持截断、includeChildren 且 countTarget 行数一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-agy-file-'));
  try {
    const manyEvents: IrEventDraft[] = [];
    for (let i = 0; i < 20; i += 1) {
      manyEvents.push({
        kind: 'message',
        id: 'm' + i,
        at: `2026-11-26T08:00:${String(i).padStart(2, '0')}.000Z`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `第 ${i} 条对话记录 `.repeat(25) }],
      });
    }
    const bundle = makeSampleBundle({ events: chain(manyEvents), withChildren: true });
    const outcome = await writeAntigravitySession(bundle, {
      home: dir,
      id: 'handoff-file-1',
      handoffOnly: true,
      includeChildren: true,
      maxChars: 2400,
    });

    const mdPath = outcome.paths[0]!;
    const irPath = outcome.paths[1]!;
    assert.ok(existsSync(mdPath));
    assert.ok(existsSync(irPath));

    const mdText = readFileSync(mdPath, 'utf8');
    assert.ok(mdText.includes('# Session Handoff: 排查登录超时'));
    assert.ok(mdText.includes('## Child / Subagent Sessions (1)'));
    assert.ok(mdText.includes('auth-researcher'));

    const parsedIr = JSON.parse(readFileSync(irPath, 'utf8')) as IrBundle;
    assert.equal(validateIrBundle(parsedIr).length, 0);

    const codes = new Set((outcome.report.losses ?? []).map((l) => l.code));
    assert.ok(codes.has('antigravity.degraded-context-handoff'));
    assert.ok(codes.has('antigravity.handoff-file-only'));
    assert.ok(codes.has('antigravity.handoff-truncated'));
    assert.ok(codes.has('antigravity.subagents-summarized'));

    const counted = await countAntigravityTarget(outcome, { home: dir });
    assert.equal(counted.exists, true);
    assert.equal(counted.units, outcome.units);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置 lsAddress + csrfToken 时自动查询 projectId 并调用 ConversationService/CreateConversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-agy-api-'));
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  seedProjectSummaryDb(dir, repoDir, 'proj_demo_999');

  assert.equal(lookupAntigravityProjectId(dir, repoDir), 'proj_demo_999');

  let receivedUrl: string | undefined;
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  let receivedBody: Record<string, unknown> = {};

  const server = createServer((req, res) => {
    receivedUrl = req.url;
    receivedHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversation: { id: 'conv-api-created-777' } }));
    });
  });

  await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  try {
    const port = (server.address() as AddressInfo).port;
    const bundle = makeSampleBundle({ cwd: repoDir });
    const outcome = await writeAntigravitySession(bundle, {
      home: dir,
      cwd: repoDir,
      lsAddress: `127.0.0.1:${port}`,
      csrfToken: 'csrf-secret-xyz',
      model: 'gemini-4-neon',
    });

    assert.equal(receivedUrl, '/product.v1.ConversationService/CreateConversation');
    assert.equal(receivedHeaders['content-type'], 'application/json');
    assert.equal(receivedHeaders['connect-protocol-version'], '1');
    assert.equal(receivedHeaders['x-antigravity-csrf-token'], 'csrf-secret-xyz');
    assert.equal(receivedBody.title, '排查登录超时');
    assert.equal(receivedBody.projectId, 'proj_demo_999');
    assert.equal(receivedBody.model, 'gemini-4-neon');
    assert.deepEqual(receivedBody.tags, ['sessionport', 'from:claude-code']);
    const promptArr = receivedBody.prompt as Array<{ text?: string }>;
    assert.ok(promptArr[0]?.text?.includes('sessionport'));
    assert.ok(promptArr[0]?.text?.includes(outcome.paths[0]!));

    assert.equal(outcome.targetId, 'conv-api-created-777');
    assert.equal(outcome.report.imported, true);
    assert.equal(outcome.report.delivery, 'api');
    const handoff = outcome.report.handoff as { delivery: string; conversationId?: string; projectId?: string };
    assert.equal(handoff.delivery, 'api');
    assert.equal(handoff.conversationId, 'conv-api-created-777');
    assert.equal(handoff.projectId, 'proj_demo_999');

    const codes = new Set((outcome.report.losses ?? []).map((l) => l.code));
    assert.ok(codes.has('antigravity.degraded-context-handoff'));
    assert.ok(codes.has('antigravity.triggers-initial-turn'));
    assert.equal(codes.has('antigravity.handoff-file-only'), false);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CreateConversation 返回 HTTP 错误时抛出清晰错误而不是静默成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-agy-err-'));
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid csrf token' }));
  });
  await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  try {
    const port = (server.address() as AddressInfo).port;
    const bundle = makeSampleBundle();
    await assert.rejects(
      () =>
        writeAntigravitySession(bundle, {
          home: dir,
          lsAddress: `127.0.0.1:${port}`,
          csrfToken: 'bad-token',
        }),
      /CreateConversation 请求失败 \(HTTP 401\)/,
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(dir, { recursive: true, force: true });
  }
});
