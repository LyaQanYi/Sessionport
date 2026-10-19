import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent } from '@sessionport/core';
import { verifyOpencodeExport, writeOpencodeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-opencode-test';

function chain(events: Array<Omit<IrEvent, 'parentId'>>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

function makeBundle(events: IrEvent[]): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00Z',
    root: {
      id: 'ir_oc',
      source: { agent: 'dsh', nativeSessionId: 'session-x' },
      meta: { cwd: TEST_CWD, title: 'opencode 写入测试', createdAt: '2026-01-01T00:00:00Z' },
      events,
      head: events.length > 0 ? events[events.length - 1]!.id : null,
      notices: [],
    },
    children: [],
  };
}

test('IR -> opencode 导出 JSON：消息/parts/工具配对结构正确', async () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
    { kind: 'reasoning', id: 'e2', at: '2026-01-01T00:00:01Z', reasoning: { kind: 'plain', text: '想一想' } },
    { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02Z', role: 'assistant', parts: [{ type: 'text', text: '先看看' }] },
    { kind: 'tool_call', id: 'e4', at: '2026-01-01T00:00:03Z', callId: 'call_1', name: 'bash', input: { command: 'ls' } },
    { kind: 'tool_result', id: 'e5', at: '2026-01-01T00:00:04Z', callId: 'call_1', content: [{ type: 'text', text: 'README.md' }] },
    { kind: 'message', id: 'e6', at: '2026-01-01T00:00:05Z', role: 'assistant', parts: [{ type: 'text', text: '完成' }] },
  ] as Array<Omit<IrEvent, 'parentId'>>);

  const report = await writeOpencodeSession(makeBundle(events), { cwd: TEST_CWD, dryRun: true, apply: false, id: 'ses_000000000000000000000001' });
  const data = report.exportData;
  assert.equal(data.info!.id, 'ses_000000000000000000000001');
  assert.equal(data.info!.directory, TEST_CWD);
  assert.equal(data.messages!.length, 2, 'user + assistant 两条消息');
  assert.equal(data.messages![0]!.info!.role, 'user');
  assert.equal(data.messages![1]!.info!.role, 'assistant');

  const assistantParts = data.messages![1]!.parts!;
  assert.deepEqual(assistantParts.map((part) => part.type), ['reasoning', 'text', 'tool', 'text']);
  const tool = assistantParts[2]!;
  assert.equal(tool.callID, 'call_1');
  assert.equal(tool.state!.status, 'completed');
  assert.equal(tool.state!.output, 'README.md');

  const checks = verifyOpencodeExport(data);
  assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks));
});

test('缺失工具结果时保留 running 状态并记损失', async () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
    { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01Z', callId: 'call_missing', name: 'bash', input: {} },
  ] as Array<Omit<IrEvent, 'parentId'>>);
  const report = await writeOpencodeSession(makeBundle(events), { cwd: TEST_CWD, dryRun: true, apply: false, id: 'ses_000000000000000000000002' });
  const tool = report.exportData.messages![1]!.parts![0]!;
  assert.equal(tool.state!.status, 'running');
  assert.ok(report.losses.some((loss) => loss.code === 'opencode.tool-without-result'));
});

test('synthetic 消息默认丢弃', async () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'Current runtime context' }], synthetic: true },
    { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'user', parts: [{ type: 'text', text: '真实消息' }] },
  ] as Array<Omit<IrEvent, 'parentId'>>);
  const report = await writeOpencodeSession(makeBundle(events), { cwd: TEST_CWD, dryRun: true, apply: false, id: 'ses_000000000000000000000003' });
  assert.equal(report.exportData.messages!.length, 1);
  assert.ok(report.losses.some((loss) => loss.code === 'opencode.injected-message-dropped'));
});
