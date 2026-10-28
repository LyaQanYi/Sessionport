import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { IR_VERSION, eventKindCounts } from '@sessionport/core';
import type { IrBundle, IrChildSession, IrEvent, IrEventDraft, IrMessageEvent, IrSession } from '@sessionport/core';
import { readClaudeSession, verifyClaudeSession, writeClaudeSession } from '../src/index.ts';

const SESSION_ID = 'cccccccc-3333-4333-8333-333333333333';
const TEST_CWD = '/tmp/sessionport-claude-children';

function chain(events: IrEventDraft[]): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function headOf(events: IrEvent[]): string | null {
  return events.length > 0 ? events[events.length - 1]!.id : null;
}

function makeRoot(): IrSession {
  const events = chain([
    { kind: 'message', id: 'root-e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '主会话问题' }] },
    {
      kind: 'tool_call',
      id: 'root-e2',
      at: '2026-01-01T00:00:01Z',
      callId: 'call_child_1',
      name: 'Task',
      input: { description: '检查测试', subagent_type: 'explore' },
    },
    {
      kind: 'tool_result',
      id: 'root-e3',
      at: '2026-01-01T00:00:02Z',
      callId: 'call_child_1',
      content: [{ type: 'text', text: '子代理完成' }],
    },
    { kind: 'message', id: 'root-e4', at: '2026-01-01T00:00:03Z', role: 'assistant', parts: [{ type: 'text', text: '主会话答复' }] },
  ] as IrEventDraft[]);
  return {
    id: 'ir_root',
    source: { agent: 'kimi-code', nativeSessionId: 'root-native' },
    meta: { cwd: TEST_CWD, title: '主会话', model: 'kimi-for-coding' },
    events,
    head: headOf(events),
    notices: [],
  };
}

/** 第一个 child：user / assistant / tool_call / tool_result / assistant，5 个事件 */
function makeChildOne(): IrChildSession {
  const events = chain([
    { kind: 'message', id: 'c1-e1', at: '2026-01-01T00:00:10Z', role: 'user', parts: [{ type: 'text', text: '子代理一任务' }] },
    { kind: 'message', id: 'c1-e2', at: '2026-01-01T00:00:11Z', role: 'assistant', parts: [{ type: 'text', text: '子代理一开始' }] },
    { kind: 'tool_call', id: 'c1-e3', at: '2026-01-01T00:00:12Z', callId: 'tool_child_1', name: 'Bash', input: { command: 'ls' } },
    {
      kind: 'tool_result',
      id: 'c1-e4',
      at: '2026-01-01T00:00:13Z',
      callId: 'tool_child_1',
      content: [{ type: 'text', text: 'a.txt' }],
    },
    { kind: 'message', id: 'c1-e5', at: '2026-01-01T00:00:14Z', role: 'assistant', parts: [{ type: 'text', text: '子代理一完成' }] },
  ] as IrEventDraft[]);
  return {
    session: {
      id: 'ir_child_1',
      source: { agent: 'kimi-code', nativeSessionId: '11111111-1111-4111-8111-111111111111' },
      meta: { cwd: TEST_CWD, title: '检查测试', profile: 'explore', model: 'kimi-for-coding' },
      events,
      head: headOf(events),
      notices: [],
    },
    parentSessionId: 'ir_root',
    viaToolCallId: 'call_child_1',
    label: 'explore',
  };
}

/** 第二个 child：user / assistant，2 个事件 */
function makeChildTwo(): IrChildSession {
  const events = chain([
    { kind: 'message', id: 'c2-e1', at: '2026-01-01T00:00:20Z', role: 'user', parts: [{ type: 'text', text: '子代理二任务' }] },
    { kind: 'message', id: 'c2-e2', at: '2026-01-01T00:00:21Z', role: 'assistant', parts: [{ type: 'text', text: '子代理二完成' }] },
  ] as IrEventDraft[]);
  return {
    session: {
      id: 'ir_child_2',
      source: { agent: 'kimi-code', nativeSessionId: '22222222-2222-4222-8222-222222222222' },
      meta: { cwd: TEST_CWD, title: '写文档', profile: 'general-purpose', model: 'kimi-for-coding' },
      events,
      head: headOf(events),
      notices: [],
    },
    parentSessionId: 'ir_root',
    viaToolCallId: 'call_child_2',
    label: 'writer',
  };
}

function makeBundle(): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root: makeRoot(),
    children: [makeChildOne(), makeChildTwo()],
  };
}

function messageTexts(events: IrEvent[]): string[] {
  return events
    .filter((event): event is IrMessageEvent => event.kind === 'message')
    .map((event) => event.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''));
}

async function readRows(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectations(report: Awaited<ReturnType<typeof writeClaudeSession>>) {
  return report.children.map((child) => ({
    agentId: child.agentId,
    agentType: child.meta.agentType,
    description: child.meta.description,
    toolUseId: child.meta.toolUseId,
  }));
}

test('includeChildren：子代理写成原生 subagents transcript，读回 title/profile/via/事件数与源一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-children-'));
  try {
    const bundle = makeBundle();
    const report = await writeClaudeSession(bundle, {
      configDir: dir,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
    });

    assert.equal(report.rows.length, 4);
    assert.equal(report.children.length, 2);
    assert.deepEqual(report.paths, [report.filePath, ...report.children.map((child) => child.filePath)]);
    assert.ok(!report.losses.some((loss) => loss.code === 'claude.subagent-separate-session'));
    const nativeLoss = report.losses.find((loss) => loss.code === 'claude.subagent-native-writeback');
    assert.equal(nativeLoss?.severity, 'info');
    assert.equal(nativeLoss?.count, 2);
    // 子代理二在主会话里没有对应 Task 调用：handler 仍写文件，但要显式警告「UI 不会关联」
    const unlinkedLoss = report.losses.find((loss) => loss.code === 'claude.subagent-unlinked');
    assert.equal(unlinkedLoss?.severity, 'warning');
    assert.equal(unlinkedLoss?.count, 1);

    // 主会话文件不掺 sidechain 镜像行，事件不变
    const mainRows = await readRows(report.filePath);
    assert.equal(mainRows.length, report.rows.length);
    assert.ok(mainRows.every((row) => row.isSidechain === false));
    assert.ok(mainRows.every((row) => row.agentId === undefined));

    // 主会话里有 Task 调用的子代理，其 tool_result 行必须带 Claude 的 toolUseResult（CLI 靠它关联 sidecar）
    const rowForChildOne = mainRows.find((candidate) => {
      const message = candidate.message as { content?: Array<{ type?: string; tool_use_id?: string }> } | undefined;
      return Array.isArray(message?.content)
        && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === bundle.children[0]!.viaToolCallId);
    });
    assert.ok(rowForChildOne, '缺少子代理一对应的 tool_result 行');
    const linkedResult = rowForChildOne.toolUseResult as Record<string, unknown>;
    assert.equal(linkedResult.status, 'completed');
    assert.equal(linkedResult.agentId, report.children[0]!.agentId);
    assert.equal(linkedResult.agentType, report.children[0]!.meta.agentType);
    assert.equal(typeof linkedResult.prompt, 'string');
    assert.ok((linkedResult.prompt as string).length > 0);
    assert.ok(Array.isArray(linkedResult.content));
    // Claude 渲染 "Done (...)" 需要 usage + 三个统计字段
    assert.equal(typeof linkedResult.totalToolUseCount, 'number');
    assert.equal(typeof linkedResult.totalTokens, 'number');
    assert.equal(typeof linkedResult.totalDurationMs, 'number');
    assert.ok(linkedResult.usage !== null && typeof linkedResult.usage === 'object');
    // 子代理二在主会话里没有对应 Task 调用：不应伪造关联
    assert.equal(mainRows.filter((row) => row.toolUseResult !== undefined).length, 1);

    const expectedDir = join(dirname(report.filePath), SESSION_ID, 'subagents');
    for (const [index, source] of bundle.children.entries()) {
      const written = report.children[index]!;
      assert.match(written.agentId, /^[A-Za-z0-9]+$/);
      assert.equal(dirname(written.filePath), expectedDir);
      assert.equal(basename(written.filePath), 'agent-' + written.agentId + '.jsonl');
      assert.equal(basename(written.metaPath), 'agent-' + written.agentId + '.meta.json');
      assert.ok(existsSync(written.filePath));
      assert.ok(existsSync(written.metaPath));

      assert.equal(written.meta.agentType, source.session.meta.profile);
      assert.equal(written.meta.description, source.session.meta.title);
      assert.equal(written.meta.requestShape, 'foreground');
      assert.equal(written.meta.requestNonInteractive, true);
      assert.equal(written.meta.spawnDepth, 1);
      assert.equal(written.meta.toolUseId, source.viaToolCallId);
      assert.deepEqual(JSON.parse(await readFile(written.metaPath, 'utf8')), written.meta);

      const rows = await readRows(written.filePath);
      assert.ok(rows.length > 0);
      for (const [rowIndex, row] of rows.entries()) {
        assert.ok(row.type === 'user' || row.type === 'assistant');
        assert.equal(row.isSidechain, true);
        assert.equal(row.agentId, written.agentId);
        assert.equal(row.sessionId, SESSION_ID);
        if (rowIndex === 0) assert.equal(row.parentUuid, null);
        else assert.equal(row.parentUuid, rows[rowIndex - 1]!.uuid);
      }
    }

    const readback = await readClaudeSession(report.filePath, { configDir: dir });
    assert.deepEqual(readback.root.events.map((event) => event.kind), bundle.root.events.map((event) => event.kind));
    assert.deepEqual(messageTexts(readback.root.events), messageTexts(bundle.root.events));
    assert.equal(readback.children.length, 2);

    for (const source of bundle.children) {
      const got = readback.children.find((child) => child.viaToolCallId === source.viaToolCallId);
      assert.ok(got, '读回缺少子代理：' + source.session.meta.title);
      assert.equal(got.session.meta.title, source.session.meta.title);
      assert.equal(got.session.meta.profile, source.session.meta.profile);
      assert.equal(got.viaToolCallId, source.viaToolCallId);
      assert.equal(got.session.events.length, source.session.events.length);
      assert.deepEqual(eventKindCounts(got.session), eventKindCounts(source.session));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('includeChildren=false：仍记 subagent-dropped，不创建 subagents 目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-children-'));
  try {
    const report = await writeClaudeSession(makeBundle(), {
      configDir: dir,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: false,
    });
    assert.equal(report.children.length, 0);
    assert.equal(report.paths.length, 1);
    const dropped = report.losses.find((loss) => loss.code === 'claude.subagent-dropped');
    assert.equal(dropped?.count, 2);
    assert.equal(dropped?.severity, 'warning');
    assert.ok(report.losses.some((loss) => loss.code === 'claude.subagent-events-dropped' && loss.count === 7));
    assert.ok(!existsSync(join(dirname(report.filePath), SESSION_ID)));

    const readback = await readClaudeSession(report.filePath, { configDir: dir });
    assert.equal(readback.children.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dryRun：主会话与子代理都不落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-children-'));
  try {
    const report = await writeClaudeSession(makeBundle(), {
      configDir: dir,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
      dryRun: true,
    });
    assert.equal(report.rows.length, 4);
    assert.equal(report.children.length, 2);
    assert.ok(!existsSync(report.filePath));
    assert.ok(!existsSync(dirname(report.filePath)));
    for (const child of report.children) {
      assert.ok(!existsSync(child.filePath));
      assert.ok(!existsSync(child.metaPath));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify：原生 subagents 结构 PASS，破坏子代理文件后 FAIL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-children-'));
  try {
    const report = await writeClaudeSession(makeBundle(), {
      configDir: dir,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
    });
    const expected = expectations(report);
    const verify = await verifyClaudeSession({ configDir: dir, cwd: TEST_CWD, sessionId: SESSION_ID, expectedChildren: expected });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks, null, 2));
    assert.equal(verify.subagents.length, 2);
    for (const child of report.children) {
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-sidechain-agent-id' && check.ok));
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-parent-chain' && check.ok));
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-meta' && check.ok));
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-tool-use-result' && check.ok));
    }
    assert.ok(verify.checks.some((check) => check.name === 'subagent-files-match-children' && check.ok));
    assert.ok(verify.checks.some((check) => check.name === 'subagent-meta-matches-children' && check.ok));

    // 破坏第一个子代理的 isSidechain 标记
    const victim = report.children[0]!;
    const raw = await readFile(victim.filePath, 'utf8');
    await writeFile(victim.filePath, raw.replace('"isSidechain":true', '"isSidechain":false'), 'utf8');
    const broken = await verifyClaudeSession({ configDir: dir, cwd: TEST_CWD, sessionId: SESSION_ID });
    assert.equal(broken.ok, false);
    assert.ok(broken.checks.some((check) => check.name === 'subagent-' + victim.agentId + '-sidechain-agent-id' && !check.ok));

    // 再破坏 JSON：解析检查必须失败
    await writeFile(victim.filePath, '{"type":"user"}\n{broken\n', 'utf8');
    const unparsable = await verifyClaudeSession({ configDir: dir, cwd: TEST_CWD, sessionId: SESSION_ID });
    assert.equal(unparsable.ok, false);
    assert.ok(unparsable.checks.some((check) => check.name === 'subagent-' + victim.agentId + '-jsonl-parses' && !check.ok));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify：meta.json 缺失或与 child 不一致时 FAIL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-children-'));
  try {
    const report = await writeClaudeSession(makeBundle(), {
      configDir: dir,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
    });
    const expected = expectations(report);

    const damaged = report.children[0]!;
    const meta = JSON.parse(await readFile(damaged.metaPath, 'utf8')) as Record<string, unknown>;
    meta.description = '被篡改的描述';
    await writeFile(damaged.metaPath, JSON.stringify(meta), 'utf8');
    const mismatched = await verifyClaudeSession({ configDir: dir, cwd: TEST_CWD, sessionId: SESSION_ID, expectedChildren: expected });
    assert.equal(mismatched.ok, false);
    const metaCheck = mismatched.checks.find((check) => check.name === 'subagent-meta-matches-children');
    assert.equal(metaCheck?.ok, false);
    assert.match(metaCheck?.detail ?? '', /description/);

    const missing = report.children[1]!;
    await rm(missing.metaPath);
    const noMeta = await verifyClaudeSession({ configDir: dir, cwd: TEST_CWD, sessionId: SESSION_ID });
    assert.equal(noMeta.ok, false);
    assert.ok(noMeta.checks.some((check) => check.name === 'subagent-' + missing.agentId + '-meta' && !check.ok));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
