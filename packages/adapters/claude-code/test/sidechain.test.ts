import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import type { IrEvent, IrMessageEvent } from '@sessionport/core';
import { readClaudeSession } from '../src/index.ts';

const SESSION_ID = 'dddddddd-4444-4444-8444-444444444444';
const MAIN_ONLY_ID = 'eeeeeeee-5555-4555-8555-555555555555';
const AGENT_A = 'a1111111aaaaaaaa1';
const AGENT_B = 'b2222222bbbbbbbb2';
const TEST_CWD = '/tmp/sessionport-claude-sidechain';

type FixtureRow = Record<string, unknown> | string;

function jsonl(values: FixtureRow[]): string {
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') + '\n';
}

async function writeProjectSession(root: string, sessionId: string, lines: FixtureRow[]): Promise<string> {
  const dir = join(root, 'projects', '-tmp-sessionport-claude-sidechain');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, sessionId + '.jsonl');
  await writeFile(filePath, jsonl(lines), 'utf8');
  return filePath;
}

function assertChain(events: IrEvent[]): void {
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index]!.parentId, index === 0 ? null : events[index - 1]!.id);
  }
}

function messageTexts(events: IrEvent[]): string[] {
  return events
    .filter((event): event is IrMessageEvent => event.kind === 'message')
    .map((event) => event.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''));
}

function isMainRow(row: FixtureRow): boolean {
  return typeof row === 'object' && row !== null && (row as { isSidechain?: boolean }).isSidechain !== true;
}

test('sidechain：按 agentId 分成子会话，主会话事件保持不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-sidechain-'));
  try {
    const fullRows: FixtureRow[] = [
      {
        type: 'user',
        uuid: 'm1',
        sessionId: SESSION_ID,
        cwd: TEST_CWD,
        version: '2.1.303',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: '主会话问题' },
      },
      {
        type: 'user',
        uuid: 'sa1',
        parentUuid: 'm1',
        sessionId: SESSION_ID,
        cwd: TEST_CWD,
        timestamp: '2026-01-01T00:00:01.000Z',
        isSidechain: true,
        agentId: AGENT_A,
        message: { role: 'user', content: '子代理 A：检查测试' },
      },
      {
        type: 'assistant',
        uuid: 'm2',
        parentUuid: 'm1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          id: 'msg_main',
          role: 'assistant',
          model: 'claude-opus-4',
          content: [
            { type: 'text', text: '主会话回复' },
            { type: 'tool_use', id: 'tool_main', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'sa2',
        parentUuid: 'sa1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:03.000Z',
        isSidechain: true,
        agentId: AGENT_A,
        message: {
          id: 'msg_agent_a',
          role: 'assistant',
          model: 'claude-opus-4',
          content: [
            { type: 'thinking', thinking: 'A 想一想', signature: 'sig-a' },
            { type: 'text', text: 'A 开始' },
            { type: 'tool_use', id: 'tool_a', name: 'Bash', input: { command: 'echo a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'sb1',
        parentUuid: 'm2',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:04.000Z',
        isSidechain: true,
        agentId: AGENT_B,
        message: { role: 'user', content: '子代理 B：另一个任务' },
      },
      {
        type: 'user',
        uuid: 'm3',
        parentUuid: 'm2',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:05.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_main', content: 'main done' }] },
      },
      {
        type: 'user',
        uuid: 'sa3',
        parentUuid: 'sa2',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:06.000Z',
        isSidechain: true,
        agentId: AGENT_A,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_a', content: 'a done' }] },
      },
      {
        type: 'assistant',
        uuid: 'sb2',
        parentUuid: 'sb1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:07.000Z',
        isSidechain: true,
        agentId: AGENT_B,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'B 完成' },
            { type: 'tool_use', id: 'tool_b_missing', name: 'Read', input: { file_path: '/tmp/x' } },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'sa4',
        parentUuid: 'sa3',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:08.000Z',
        isSidechain: true,
        agentId: AGENT_A,
        message: { role: 'assistant', content: [{ type: 'text', text: 'A 完成' }] },
      },
      {
        type: 'assistant',
        uuid: 'm5',
        parentUuid: 'm3',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:09.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '主会话完成' }] },
      },
      {
        type: 'user',
        uuid: 'orphan',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:10.000Z',
        isSidechain: true,
        message: { role: 'user', content: '无法归组的 sidechain' },
      },
      'not json',
    ];

    const fullPath = await writeProjectSession(dir, SESSION_ID, fullRows);
    const mainOnlyPath = await writeProjectSession(dir, MAIN_ONLY_ID, fullRows.filter(isMainRow));
    const bundle = await readClaudeSession(fullPath, { configDir: dir });
    const mainOnly = await readClaudeSession(mainOnlyPath, { configDir: dir });

    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.children.length, 2);

    // 主会话事件数与去掉 sidechain 行后的同一 fixture 完全一致（内容、顺序、id、parentId）
    assert.equal(bundle.root.events.length, 5);
    assert.deepEqual(bundle.root.events, mainOnly.root.events);
    assert.deepEqual(bundle.root.events.map((event) => event.kind), ['message', 'message', 'tool_call', 'tool_result', 'message']);
    assert.equal(bundle.root.meta.title, '主会话问题');
    assert.equal(bundle.root.meta.lastPrompt, '主会话问题');
    assert.ok(!JSON.stringify(bundle.root.events).includes('子代理 A'));
    assert.ok(!JSON.stringify(bundle.root.events).includes('子代理 B'));
    assert.ok(!JSON.stringify(bundle.root.events).includes('无法归组的 sidechain'));

    const [agentA, agentB] = bundle.children;
    assert.equal(agentA!.label, 'agent-a1111111');
    assert.equal(agentB!.label, 'agent-b2222222');
    assert.equal(agentA!.parentSessionId, bundle.root.id);
    assert.equal(agentB!.parentSessionId, bundle.root.id);
    assert.equal(agentA!.session.source.nativeSessionId, AGENT_A);
    assert.equal(agentB!.session.source.nativeSessionId, AGENT_B);

    // A：message / reasoning / message / tool_call / tool_result / message，且工具配对完整
    assert.deepEqual(
      agentA!.session.events.map((event) => event.kind),
      ['message', 'reasoning', 'message', 'tool_call', 'tool_result', 'message'],
    );
    assert.deepEqual(messageTexts(agentA!.session.events), ['子代理 A：检查测试', 'A 开始', 'A 完成']);
    const reasoning = agentA!.session.events[1] as { reasoning: { kind: string; text: string; signature?: string } };
    assert.deepEqual(reasoning.reasoning, { kind: 'plain', text: 'A 想一想', signature: 'sig-a' });
    const call = agentA!.session.events.find((event) => event.kind === 'tool_call') as { callId: string; name: string };
    const result = agentA!.session.events.find((event) => event.kind === 'tool_result') as { callId: string };
    assert.equal(call.callId, 'tool_a');
    assert.equal(call.name, 'Bash');
    assert.equal(result.callId, 'tool_a');
    assert.ok(!agentA!.session.notices.some((notice) => notice.code === 'claude.orphan-tool-result'));
    assert.ok(!agentA!.session.notices.some((notice) => notice.code === 'claude.tool-without-result'));

    // B：子会话内部单独配对；缺结果的 tool_use 只记在 B 自己的 notices 里
    assert.deepEqual(agentB!.session.events.map((event) => event.kind), ['message', 'message', 'tool_call']);
    assert.deepEqual(messageTexts(agentB!.session.events), ['子代理 B：另一个任务', 'B 完成']);
    assert.equal(agentB!.session.notices.find((notice) => notice.code === 'claude.tool-without-result')?.count, 1);
    assert.ok(!bundle.root.notices.some((notice) => notice.code === 'claude.tool-without-result'));

    // 每个子会话的 parentId 链从 null 开始、在内部闭合
    assertChain(agentA!.session.events);
    assertChain(agentB!.session.events);
    assert.equal(agentA!.session.head, agentA!.session.events.at(-1)!.id);
    assert.equal(agentB!.session.head, agentB!.session.events.at(-1)!.id);

    const info = bundle.root.notices.find((notice) => notice.code === 'claude.sidechain-children');
    assert.equal(info?.count, 2);
    assert.equal(info?.severity, 'info');
    assert.match(info?.message ?? '', /sidechain 镜像行已归组（2 组）/);
    const skipped = bundle.root.notices.find((notice) => notice.code === 'claude.sidechain-skipped');
    assert.equal(skipped?.count, 1);
    assert.equal(skipped?.severity, 'warning');
    assert.equal(bundle.root.notices.find((notice) => notice.code === 'claude.bad-json-lines')?.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sidechain：没有 agentId 时按 parentUuid 连通关系分组，孤立行记 warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-sidechain-'));
  try {
    const filePath = await writeProjectSession(dir, SESSION_ID, [
      {
        type: 'user',
        uuid: 'm1',
        sessionId: SESSION_ID,
        cwd: TEST_CWD,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: '主会话问题' },
      },
      {
        type: 'user',
        uuid: 'c1',
        parentUuid: 'm1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:01.000Z',
        isSidechain: true,
        message: { role: 'user', content: '链 C1 开始' },
      },
      {
        type: 'assistant',
        uuid: 'c2',
        parentUuid: 'c1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:02.000Z',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '链 C1 结束' }] },
      },
      {
        type: 'user',
        uuid: 'd1',
        parentUuid: 'm1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:03.000Z',
        isSidechain: true,
        message: { role: 'user', content: '链 D1 开始' },
      },
      {
        type: 'assistant',
        uuid: 'd2',
        parentUuid: 'd1',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:04.000Z',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '链 D1 结束' }] },
      },
      {
        type: 'user',
        uuid: 'lonely',
        sessionId: SESSION_ID,
        timestamp: '2026-01-01T00:00:05.000Z',
        isSidechain: true,
        message: { role: 'user', content: '没有 agentId / parentUuid 的孤立行' },
      },
    ]);

    const bundle = await readClaudeSession(filePath, { configDir: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.events.length, 1);
    assert.equal(bundle.children.length, 2);

    const [chainC, chainD] = bundle.children;
    assert.equal(chainC!.session.source.nativeSessionId, 'c1');
    assert.equal(chainD!.session.source.nativeSessionId, 'd1');
    assert.match(chainC!.label ?? '', /^agent-/);
    assert.match(chainD!.label ?? '', /^agent-/);
    assert.deepEqual(messageTexts(chainC!.session.events), ['链 C1 开始', '链 C1 结束']);
    assert.deepEqual(messageTexts(chainD!.session.events), ['链 D1 开始', '链 D1 结束']);
    assertChain(chainC!.session.events);
    assertChain(chainD!.session.events);
    assert.equal(chainC!.parentSessionId, bundle.root.id);
    assert.equal(chainD!.parentSessionId, bundle.root.id);

    assert.equal(bundle.root.notices.find((notice) => notice.code === 'claude.sidechain-children')?.count, 2);
    const skipped = bundle.root.notices.find((notice) => notice.code === 'claude.sidechain-skipped');
    assert.equal(skipped?.count, 1);
    assert.equal(skipped?.severity, 'warning');
    assert.ok(!JSON.stringify(bundle.root.events).includes('没有 agentId'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
