import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION, eventKindCounts } from '@sessionport/core';
import type { IrBundle, IrChildSession, IrEvent, IrEventDraft, IrSession } from '@sessionport/core';
import {
  qoderProjectKey,
  qoderSubagentsDir,
  readQoderSession,
  verifyQoderRoundTrip,
  verifyQoderSession,
  writeQoderSession,
} from '../src/index.ts';

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const TEST_CWD = '/tmp/sessionport-qoder-children';

function chain(events: IrEventDraft[]): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function headOf(events: IrEvent[]): string | null {
  return events.length > 0 ? events[events.length - 1]!.id : null;
}

function makeRoot(): IrSession {
  const events = chain([
    { kind: 'message', id: 'root-e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '主会话问题' }] },
    { kind: 'tool_call', id: 'root-e2', at: '2026-01-01T00:00:01Z', callId: 'call_child_1', name: 'Agent', input: { description: '检查测试', subagent_type: 'explore' } },
    { kind: 'tool_result', id: 'root-e3', at: '2026-01-01T00:00:02Z', callId: 'call_child_1', content: [{ type: 'text', text: '子代理完成' }] },
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

function makeChildOne(): IrChildSession {
  const events = chain([
    { kind: 'message', id: 'c1-e1', at: '2026-01-01T00:00:10Z', role: 'user', parts: [{ type: 'text', text: '子代理一任务' }] },
    { kind: 'message', id: 'c1-e2', at: '2026-01-01T00:00:11Z', role: 'assistant', parts: [{ type: 'text', text: '子代理一开始' }] },
    { kind: 'tool_call', id: 'c1-e3', at: '2026-01-01T00:00:12Z', callId: 'tool_child_1', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool_result', id: 'c1-e4', at: '2026-01-01T00:00:13Z', callId: 'tool_child_1', content: [{ type: 'text', text: 'a.txt' }] },
    { kind: 'message', id: 'c1-e5', at: '2026-01-01T00:00:14Z', role: 'assistant', parts: [{ type: 'text', text: '子代理一完成' }] },
  ] as IrEventDraft[]);
  return {
    session: {
      id: 'ir_child_1',
      source: { agent: 'kimi-code', nativeSessionId: 'aExplore-1111111111111111' },
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

function makeChildTwo(): IrChildSession {
  const events = chain([
    { kind: 'message', id: 'c2-e1', at: '2026-01-01T00:00:20Z', role: 'user', parts: [{ type: 'text', text: '子代理二任务' }] },
    { kind: 'message', id: 'c2-e2', at: '2026-01-01T00:00:21Z', role: 'assistant', parts: [{ type: 'text', text: '子代理二完成' }] },
  ] as IrEventDraft[]);
  return {
    session: {
      id: 'ir_child_2',
      // 非法的源 id（含 '/'）：writer 必须 hash 成合法文件名
      source: { agent: 'kimi-code', nativeSessionId: '../bad/id' },
      meta: { cwd: TEST_CWD, title: '写文档', profile: 'general-purpose', model: 'kimi-for-coding' },
      events,
      head: headOf(events),
      notices: [],
    },
    parentSessionId: 'ir_root',
    // 主会话里没有这个 tool_use：不能伪造 meta.toolUseId
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

function readRows(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'sessionport-qoder-children-'));
}

function expectations(report: Awaited<ReturnType<typeof writeQoderSession>>) {
  return report.children.map((child) => ({
    agentId: child.agentId,
    agentType: child.meta.agentType,
    description: child.meta.description,
    toolUseId: child.meta.toolUseId,
  }));
}

test('includeChildren：子代理写成 Qoder 原生 subagents transcript，读回 title/profile/via 一致', async () => {
  const home = makeHome();
  try {
    const bundle = makeBundle();
    const report = await writeQoderSession(bundle, {
      home,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
    });

    // 主会话行不受影响：4 控制行 + user/leaf 2 + tool_use 1 + tool_result(leaf+row+leaf) 3
    // + assistant 1 + 收尾 leaf 1 + last-prompt/leaf 2 = 14
    assert.equal(report.rows.length, 14);
    assert.equal(report.children.length, 2);
    assert.deepEqual(report.paths, [report.path, ...report.children.map((child) => child.filePath)]);
    assert.ok(!report.losses.some((loss) => loss.code === 'qoder.subagents-dropped'));
    const nativeLoss = report.losses.find((loss) => loss.code === 'qoder.subagent-native-writeback');
    assert.equal(nativeLoss?.severity, 'info');
    assert.equal(nativeLoss?.count, 2);
    // 第二个子代理的 via 在主会话里找不到：必须显式记 warning，且不写 toolUseId
    const unlinkedLoss = report.losses.find((loss) => loss.code === 'qoder.subagent-unlinked');
    assert.equal(unlinkedLoss?.severity, 'warning');
    assert.equal(unlinkedLoss?.count, 1);

    const mainRows = readRows(report.path);
    assert.equal(mainRows.length, report.rows.length);
    assert.deepEqual(mainRows, report.rows as unknown as Array<Record<string, unknown>>);
    const mainConversation = mainRows.filter((row) => row.type === 'user' || row.type === 'assistant');
    assert.ok(mainConversation.length > 0);
    assert.ok(mainConversation.every((row) => row.isSidechain === false));
    assert.ok(mainRows.every((row) => row.agentId === undefined));
    assert.ok(!mainRows.some((row) => row.parent_tool_use_id !== undefined));

    const childOne = report.children[0]!;
    const childTwo = report.children[1]!;
    // agentId：合法源 id 原样沿用；非法源 id 用 sha256 前缀兜底
    assert.equal(childOne.agentId, 'aExplore-1111111111111111');
    assert.match(childTwo.agentId, /^[0-9a-f]{17}$/);
    assert.notEqual(childOne.agentId, childTwo.agentId);

    const expectedDir = join(home, 'projects', qoderProjectKey(TEST_CWD), SESSION_ID, 'subagents');
    assert.equal(qoderSubagentsDir(home, TEST_CWD, SESSION_ID), expectedDir);
    for (const [index, source] of bundle.children.entries()) {
      const expected = expectations(report)[index]!;
      const written = report.children[index]!;
      assert.equal(written.meta.agentType, source.session.meta.profile);
      assert.equal(written.meta.description, source.session.meta.title);
      assert.equal(written.meta.invocationName, source.session.meta.profile);
      assert.equal(written.meta.toolUseId, expected.toolUseId);
      assert.equal(written.filePath, join(expectedDir, 'agent-' + written.agentId + '.jsonl'));
      assert.equal(written.metaPath, join(expectedDir, 'agent-' + written.agentId + '.meta.json'));
      assert.ok(existsSync(written.filePath));
      assert.ok(existsSync(written.metaPath));
      assert.deepEqual(JSON.parse(readFileSync(written.metaPath, 'utf8')), written.meta);

      const rows = readRows(written.filePath);
      assert.ok(rows.length > 0);
      for (const [rowIndex, row] of rows.entries()) {
        assert.ok(row.type === 'user' || row.type === 'assistant');
        assert.equal(row.isSidechain, true);
        assert.equal(row.agentId, written.agentId);
        assert.equal(row.sessionId, SESSION_ID);
        assert.equal(row.cwd, TEST_CWD);
        assert.equal(row.parentUuid, rowIndex === 0 ? null : rows[rowIndex - 1]!.uuid);
        if (row.type === 'assistant') {
          // 真实子代理 assistant 行同时带 session_id（snake）
          assert.equal(row.session_id, SESSION_ID);
        }
      }
      // 首条 user 是字符串 content（真实子代理样本），不是 block 数组
      const firstContent = (rows[0]!.message as { content?: unknown }).content;
      assert.equal(typeof firstContent, 'string');
      // 关联的调用写 parent_tool_use_id；未关联的不写
      if (index === 0) {
        for (const row of rows) assert.equal(row.parent_tool_use_id, 'call_child_1');
        assert.equal(written.meta.toolUseId, 'call_child_1');
      } else {
        for (const row of rows) assert.equal(row.parent_tool_use_id, undefined);
        assert.equal(written.meta.toolUseId, undefined);
      }
    }

    // reader 读回：children 数量、标题、profile、via 与源一致
    const readback = await readQoderSession(SESSION_ID, { home });
    assert.equal(readback.root.events.length, bundle.root.events.length);
    assert.deepEqual(readback.root.events.map((event) => event.kind), bundle.root.events.map((event) => event.kind));
    assert.equal(readback.children.length, 2);
    assert.ok(readback.root.notices.some((notice) => notice.code === 'qoder.subagents'));

    const readChildOne = readback.children.find((child) => child.viaToolCallId === 'call_child_1');
    assert.ok(readChildOne, '读回缺少子代理一');
    assert.equal(readChildOne.session.meta.title, '检查测试');
    assert.equal(readChildOne.session.meta.profile, 'explore');
    assert.equal(readChildOne.label, childOne.agentId);
    assert.equal(readChildOne.parentSessionId, SESSION_ID);
    assert.equal(readChildOne.session.events.length, bundle.children[0]!.session.events.length);
    assert.deepEqual(eventKindCounts(readChildOne.session), eventKindCounts(bundle.children[0]!.session));

    const readChildTwo = readback.children.find((child) => child.label === childTwo.agentId);
    assert.ok(readChildTwo, '读回缺少子代理二');
    assert.equal(readChildTwo.viaToolCallId, undefined);
    assert.equal(readChildTwo.session.meta.title, '写文档');
    assert.equal(readChildTwo.session.meta.profile, 'general-purpose');
    assert.equal(readChildTwo.session.events.length, 2);

    // reader 的 includeSubagents:false 仍只读主会话
    const withoutChildren = await readQoderSession(SESSION_ID, { home, includeSubagents: false });
    assert.equal(withoutChildren.children.length, 0);

    const roundTrip = await verifyQoderRoundTrip(bundle, report, { home });
    assert.equal(roundTrip.ok, true, roundTrip.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));

    const verify = await verifyQoderSession(SESSION_ID, { home, expectedChildren: expectations(report) });
    assert.equal(verify.ok, true, verify.checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail).join('; '));
    assert.equal(verify.subagents.length, 2);
    for (const child of report.children) {
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-sidechain-agent-id' && check.ok));
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-parent-chain' && check.ok));
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-meta' && check.ok));
      assert.ok(verify.checks.some((check) => check.name === 'subagent-' + child.agentId + '-parent-tool-use' && check.ok));
    }
    assert.ok(verify.checks.some((check) => check.name === 'subagent-files-match-children' && check.ok));
    assert.ok(verify.checks.some((check) => check.name === 'subagent-meta-matches-children' && check.ok));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('includeChildren=false：仍记 subagents-dropped，不创建 subagents 目录', async () => {
  const home = makeHome();
  try {
    const report = await writeQoderSession(makeBundle(), { home, cwd: TEST_CWD, sessionId: SESSION_ID });
    assert.equal(report.children.length, 0);
    assert.equal(report.paths.length, 1);
    const dropped = report.losses.find((loss) => loss.code === 'qoder.subagents-dropped');
    assert.equal(dropped?.count, 2);
    assert.equal(dropped?.severity, 'warning');
    assert.ok(report.losses.some((loss) => loss.code === 'qoder.subagent-events-dropped' && loss.count === 7));
    assert.ok(!existsSync(qoderSubagentsDir(home, TEST_CWD, SESSION_ID)));

    const readback = await readQoderSession(SESSION_ID, { home });
    assert.equal(readback.children.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dryRun：主会话与子代理都不落盘', async () => {
  const home = makeHome();
  try {
    const report = await writeQoderSession(makeBundle(), {
      home,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
      dryRun: true,
    });
    assert.equal(report.applied, false);
    assert.equal(report.dryRun, true);
    assert.equal(report.children.length, 2);
    assert.equal(report.paths.length, 0);
    assert.ok(!existsSync(report.path));
    for (const child of report.children) {
      assert.ok(!existsSync(child.filePath));
      assert.ok(!existsSync(child.metaPath));
    }
    assert.ok(!existsSync(qoderSubagentsDir(home, TEST_CWD, SESSION_ID)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verify：子代理文件 / meta / 关联被破坏后 FAIL', async () => {
  const home = makeHome();
  try {
    const report = await writeQoderSession(makeBundle(), { home, cwd: TEST_CWD, sessionId: SESSION_ID, includeChildren: true });
    const victim = report.children[0]!;

    // 1) isSidechain 被改坏
    const raw = readFileSync(victim.filePath, 'utf8');
    writeFileSync(victim.filePath, raw.replace('"isSidechain":true', '"isSidechain":false'), 'utf8');
    let broken = await verifyQoderSession(SESSION_ID, { home });
    assert.equal(broken.ok, false);
    assert.ok(broken.checks.some((check) => check.name === 'subagent-' + victim.agentId + '-sidechain-agent-id' && !check.ok));

    // 2) JSONL 无法解析
    writeFileSync(victim.filePath, '{"type":"user"}\n{broken\n', 'utf8');
    broken = await verifyQoderSession(SESSION_ID, { home });
    assert.equal(broken.ok, false);
    assert.ok(broken.checks.some((check) => check.name === 'subagent-' + victim.agentId + '-jsonl-parses' && !check.ok));

    // 3) meta.toolUseId 指向主会话里不存在的调用
    const meta = JSON.parse(readFileSync(victim.metaPath, 'utf8')) as Record<string, unknown>;
    meta.toolUseId = 'call_missing';
    writeFileSync(victim.metaPath, JSON.stringify(meta), 'utf8');
    broken = await verifyQoderSession(SESSION_ID, { home });
    assert.equal(broken.ok, false);
    assert.ok(broken.checks.some((check) => check.name === 'subagent-' + victim.agentId + '-parent-tool-use' && !check.ok));

    // 4) expectedChildren 与 meta 不一致
    const tampered = JSON.parse(readFileSync(victim.metaPath, 'utf8')) as Record<string, unknown>;
    tampered.description = '被篡改的描述';
    tampered.toolUseId = 'call_child_1';
    writeFileSync(victim.metaPath, JSON.stringify(tampered), 'utf8');
    broken = await verifyQoderSession(SESSION_ID, { home, expectedChildren: expectations(report) });
    assert.equal(broken.ok, false);
    const metaCheck = broken.checks.find((check) => check.name === 'subagent-meta-matches-children');
    assert.equal(metaCheck?.ok, false);
    assert.match(metaCheck?.detail ?? '', /description/);

    // 5) 缺少 meta.json
    const missing = report.children[1]!;
    rmSync(missing.metaPath);
    broken = await verifyQoderSession(SESSION_ID, { home });
    assert.equal(broken.ok, false);
    assert.ok(broken.checks.some((check) => check.name === 'subagent-' + missing.agentId + '-meta' && !check.ok));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('overwrite：旧子代理文件改名备份，reader 不会读回上一次的 children', async () => {
  const home = makeHome();
  try {
    const first = await writeQoderSession(makeBundle(), { home, cwd: TEST_CWD, sessionId: SESSION_ID, includeChildren: true });
    assert.equal(first.children.length, 2);
    const removed = first.children[1]!;

    const bundle = makeBundle();
    bundle.children = [makeChildOne()];
    const second = await writeQoderSession(bundle, {
      home,
      cwd: TEST_CWD,
      sessionId: SESSION_ID,
      includeChildren: true,
      overwrite: true,
    });
    assert.equal(second.children.length, 1);
    assert.ok(!existsSync(removed.filePath));
    assert.ok(!existsSync(removed.metaPath));
    const backups = readdirSync(qoderSubagentsDir(home, TEST_CWD, SESSION_ID)).filter(
      (name) => name.includes('.bak-') && name.startsWith('agent-' + removed.agentId),
    );
    assert.ok(backups.length >= 2, backups.join(','));
    assert.ok(second.losses.some((loss) => loss.code === 'qoder.backup'));

    const readback = await readQoderSession(SESSION_ID, { home });
    assert.equal(readback.children.length, 1);
    assert.equal(readback.children[0]!.label, second.children[0]!.agentId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('空的子代理会话跳过并记 info 损失', async () => {
  const home = makeHome();
  try {
    const bundle = makeBundle();
    const empty = makeChildOne();
    empty.session = { ...empty.session, id: 'ir_child_empty', events: [], head: null };
    bundle.children.push(empty);
    const report = await writeQoderSession(bundle, { home, cwd: TEST_CWD, sessionId: SESSION_ID, includeChildren: true });
    assert.equal(report.children.length, 2);
    assert.ok(report.losses.some((loss) => loss.code === 'qoder.subagent-empty-skipped'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('agentId 冲突时 hash 加盐保证文件名唯一', async () => {
  const home = makeHome();
  try {
    const bundle = makeBundle();
    const duplicate = makeChildOne();
    duplicate.session = { ...duplicate.session, id: 'ir_child_dup' };
    bundle.children = [makeChildOne(), duplicate];
    const report = await writeQoderSession(bundle, { home, cwd: TEST_CWD, sessionId: SESSION_ID, includeChildren: true });
    assert.equal(report.children.length, 2);
    assert.equal(report.children[0]!.agentId, 'aExplore-1111111111111111');
    assert.match(report.children[1]!.agentId, /^[0-9a-f]{17}$/);
    assert.notEqual(report.children[0]!.filePath, report.children[1]!.filePath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
