import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import {
  readCommandCodeSession,
  resumeSmokeCommandCode,
  verifyCommandCodeSession,
  writeCommandCodeSession,
} from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-cc-test-project';
const TEST_ID = '11111111-1111-4111-8111-111111111111';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({
    ...event,
    parentId: index === 0 ? null : (events[index - 1] as { id: string }).id,
  })) as IrEvent[];
}

function makeBundle(events: IrEvent[], options: { children?: number } = {}): IrBundle {
  const childCount = options.children ?? 0;
  return {
    irVersion: IR_VERSION,
    createdAt: new Date(0).toISOString(),
    root: {
      id: 'ir_cc_test',
      source: { agent: 'kimi-code' },
      meta: { cwd: TEST_CWD, title: '合成 IR 测试', model: 'kimi-for-coding' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: Array.from({ length: childCount }, (_, index) => ({
      session: {
        id: 'ir_child_' + index,
        source: { agent: 'kimi-code' },
        meta: { cwd: TEST_CWD },
        events: [],
        head: null,
        notices: [],
      },
      parentSessionId: 'ir_cc_test',
      label: 'explore',
    })),
  };
}

function sampleEvents(): IrEvent[] {
  return chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: '帮我看下目录' }] },
    { kind: 'reasoning', id: 'e2', at: '2026-01-01T00:00:01.000Z', reasoning: { kind: 'plain', text: '先跑 ls' } },
    { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02.000Z', role: 'assistant', parts: [{ type: 'text', text: '好，执行 ls' }] },
    { kind: 'tool_call', id: 'e4', at: '2026-01-01T00:00:03.000Z', callId: 'tool_1', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool_result', id: 'e5', at: '2026-01-01T00:00:04.000Z', callId: 'tool_1', content: [{ type: 'text', text: 'a.txt' }] },
    { kind: 'message', id: 'e6', at: '2026-01-01T00:00:05.000Z', role: 'assistant', parts: [{ type: 'text', text: '只有一个文件' }] },
  ]);
}

test('把合成 IR 写成 Command Code transcript 并结构化自检 + 往返读取', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cc-write-'));
  try {
    const report = await writeCommandCodeSession(makeBundle(sampleEvents()), { home, id: TEST_ID, cwd: TEST_CWD });
    assert.equal(report.target, 'command-code');
    assert.equal(report.sessionId, TEST_ID);
    assert.equal(report.paths.length, 2);
    assert.ok(report.filePath.endsWith(TEST_ID + '.jsonl'));
    assert.ok(report.metaPath.endsWith(TEST_ID + '.meta.json'));
    // 损失清单非空：跨 agent 导入 + sidecar 未写
    assert.ok(report.losses.length > 0);
    assert.ok(report.losses.some((loss) => loss.code === 'command-code.cross-agent-import'));
    assert.ok(report.losses.some((loss) => loss.code === 'command-code.sidecars-not-written'));
    assert.equal(report.written.toolCalls, 1);
    assert.equal(report.written.toolResults, 1);
    assert.equal(report.written.reasoning, 1);

    const raw = await readFile(report.filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const header = JSON.parse(lines[0]!);
    assert.equal(header.type, 'session');
    assert.equal(header.version, 3);
    assert.equal(header.id, TEST_ID);
    assert.equal(header.cwd, TEST_CWD);
    assert.equal(lines.length, 1 + report.rows.length);
    // 每条 message 都必须带 meta.messageId（缺了 resume 会重复 append 旧消息）
    for (const line of lines.slice(1)) {
      const entry = JSON.parse(line);
      if (entry.type !== 'message') continue;
      assert.equal(typeof entry.message.meta.messageId, 'string');
      assert.ok(entry.message.meta.messageId.length > 0);
    }

    const verify = await verifyCommandCodeSession({ filePath: report.filePath });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks.filter((check) => !check.ok)));

    const roundtrip = await readCommandCodeSession(report.filePath);
    const kinds: Record<string, number> = {};
    for (const event of roundtrip.root.events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
    assert.equal(roundtrip.root.events.length, report.written.events);
    assert.deepEqual(kinds, { message: 3, reasoning: 1, tool_call: 1, tool_result: 1 });
    assert.equal(roundtrip.root.head, roundtrip.root.events.at(-1)!.id);
    assert.equal(roundtrip.root.meta.title, '合成 IR 测试');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('缺失 tool_result 时合成占位，自检仍通过并计入损失', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cc-write-'));
  try {
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00.000Z', role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
      { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01.000Z', callId: 'tool_missing', name: 'Bash', input: {} },
    ]);
    const report = await writeCommandCodeSession(makeBundle(events), { home, id: '22222222-2222-4222-8222-222222222222', cwd: TEST_CWD });
    assert.ok(report.losses.some((loss) => loss.code === 'command-code.tool-result-synthesized'));
    const verify = await verifyCommandCodeSession({ filePath: report.filePath });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks.filter((check) => !check.ok)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('子代理会话进损失清单', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cc-write-'));
  try {
    const report = await writeCommandCodeSession(makeBundle(sampleEvents(), { children: 2 }), {
      home,
      id: '33333333-3333-4333-8333-333333333333',
      cwd: TEST_CWD,
    });
    assert.ok(report.losses.some((loss) => loss.code === 'command-code.subagent-dropped' && loss.count === 2));
    assert.ok(report.losses.some((loss) => loss.code === 'command-code.subagent-events-dropped'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('dryRun 只生成不落盘', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cc-write-'));
  try {
    const report = await writeCommandCodeSession(makeBundle(sampleEvents()), {
      home,
      id: '44444444-4444-4444-8444-444444444444',
      cwd: TEST_CWD,
      dryRun: true,
    });
    assert.ok(report.rows.length > 0);
    assert.ok(report.paths.length === 2);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(report.filePath), false);
    assert.equal(existsSync(report.metaPath), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  '无头 resume 冒烟：cmd -p --session <生成的 transcript>',
  { skip: process.env.SESSIONPORT_CC_RESUME === '1' ? false : '需要真实模型调用，设置 SESSIONPORT_CC_RESUME=1 开启' },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'cc-resume-'));
    try {
      const report = await writeCommandCodeSession(makeBundle(sampleEvents()), {
        home,
        id: '55555555-5555-4555-8555-555555555555',
        cwd: TEST_CWD,
      });
      const before = (await readFile(report.filePath, 'utf8')).split('\n').filter(Boolean).length;
      const smoke = await resumeSmokeCommandCode({
        filePath: report.filePath,
        prompt: 'Reply with exactly: RESUME_OK',
        timeoutMs: 240000,
      });
      assert.equal(smoke.ok, true, JSON.stringify({ exitCode: smoke.exitCode, stderr: smoke.stderr, stdout: smoke.stdout.slice(-1500) }));
      const after = (await readFile(report.filePath, 'utf8')).split('\n').filter(Boolean).length;
      // resume 成功会把新的一轮 append 回同一个 transcript
      assert.ok(after > before, 'resume 后文件应追加新的消息');
      const verify = await verifyCommandCodeSession({ filePath: report.filePath });
      assert.equal(verify.ok, true, JSON.stringify(verify.checks.filter((check) => !check.ok)));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

