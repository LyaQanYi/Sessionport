import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import { listCodexSessions, readCodexSession } from '../src/index.ts';

const HOME = process.env.CODEX_HOME ?? process.env.HOME + '/.codex';
const SESSIONS = existsSync(HOME) ? await listCodexSessions() : [];
const hasReal = SESSIONS.length > 0;

function writeFixtureRollout(dir: string, lines: unknown[]): string {
  const file = join(dir, 'rollout-2026-11-20T00-00-00-11111111-2222-4333-8444-555555555555.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return file;
}

test('fixture: response_item 映射、双轨去重、synthetic 标记与完整工具配对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-codex-read-'));
  try {
    const file = writeFixtureRollout(dir, [
      {
        timestamp: '2026-11-20T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '11111111-2222-4333-8444-555555555555',
          timestamp: '2026-11-20T00:00:00.000Z',
          cwd: '/tmp/codex-fixture',
          originator: 'codex_cli_rs',
          cli_version: '0.170.0',
          history_mode: 'paginated',
        },
      },
      { timestamp: '2026-11-20T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } },
      {
        timestamp: '2026-11-20T00:00:01.100Z',
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] },
      },
      {
        timestamp: '2026-11-20T00:00:01.200Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp' }] },
      },
      {
        timestamp: '2026-11-20T00:00:01.250Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n用户级偏好' }] },
      },
      {
        timestamp: '2026-11-20T00:00:01.300Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列一下文件' }] },
      },
      { timestamp: '2026-11-20T00:00:01.350Z', type: 'event_msg', payload: { type: 'user_message', message: '列一下文件' } },
      {
        timestamp: '2026-11-20T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', call_id: 'call_ok_1', arguments: '{"command":"ls"}' },
      },
      {
        timestamp: '2026-11-20T00:00:02.500Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_ok_1', output: 'README.md' },
      },
      {
        timestamp: '2026-11-20T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '看到 README.md' }] },
      },
    ]);

    const bundle = await readCodexSession(file, { home: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.meta.cwd, '/tmp/codex-fixture');
    assert.equal(bundle.root.meta.title, '列一下文件');
    assert.equal(bundle.root.meta.model, 'gpt-5.4');
    assert.equal(bundle.root.events.length, 6);

    const synthetics = bundle.root.events.filter((e) => e.kind === 'message' && e.synthetic === true);
    assert.equal(synthetics.length, 2);
    assert.ok(bundle.root.notices.some((n) => n.code === 'codex.event-msg-skipped'));
    assert.ok(bundle.root.notices.some((n) => n.code === 'codex.developer-messages-skipped'));
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.tool-without-output'));
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.orphan-tool-result'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture: 未配对 function_call 与孤立 function_call_output 如实记入 warning notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-codex-unpaired-'));
  try {
    mkdirSync(dir, { recursive: true });
    const file = writeFixtureRollout(dir, [
      {
        timestamp: '2026-11-20T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: '11111111-2222-4333-8444-555555555555', timestamp: '2026-11-20T00:00:00.000Z', cwd: '/tmp/codex-fixture', originator: 'codex_cli_rs', cli_version: '0.170.0' },
      },
      {
        timestamp: '2026-11-20T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑个任务' }] },
      },
      {
        timestamp: '2026-11-20T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'spawn_agent', call_id: 'call_dangling', arguments: '{}' },
      },
      {
        timestamp: '2026-11-20T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', call_id: 'call_paired', arguments: '{"command":"pwd"}' },
      },
      {
        timestamp: '2026-11-20T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_paired', output: '/tmp/codex-fixture' },
      },
      {
        timestamp: '2026-11-20T00:00:05.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_ghost', output: 'stray output' },
      },
    ]);

    const bundle = await readCodexSession(file, { home: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    const calls = bundle.root.events.filter((e) => e.kind === 'tool_call').length;
    const results = bundle.root.events.filter((e) => e.kind === 'tool_result').length;
    assert.equal(calls, 2);
    assert.equal(results, 2);

    const withoutOutput = bundle.root.notices.find((n) => n.code === 'codex.tool-without-output');
    const orphan = bundle.root.notices.find((n) => n.code === 'codex.orphan-tool-result');
    assert.equal(withoutOutput?.severity, 'warning');
    assert.equal(withoutOutput?.count, 1);
    assert.equal(orphan?.severity, 'warning');
    assert.equal(orphan?.count, 1);
    assert.equal(calls - (withoutOutput?.count ?? 0), results - (orphan?.count ?? 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读取真实 Codex 会话：response_item 映射与双轨去重', { skip: hasReal ? false : '本机没有 Codex rollout 样本' }, async (t) => {
  // 最新的 rollout 可能只有极少事件（刚创建/被截断）或纯对话没有工具调用：挑一个满足样本
  let bundle: Awaited<ReturnType<typeof readCodexSession>> | undefined;
  for (const candidate of SESSIONS.slice(0, 12)) {
    let parsed: Awaited<ReturnType<typeof readCodexSession>>;
    try {
      parsed = await readCodexSession(candidate.id, { home: HOME });
    } catch {
      continue;
    }
    const toolCalls = parsed.root.events.filter((event) => event.kind === 'tool_call').length;
    if (parsed.root.events.length > 10 && toolCalls > 0) {
      bundle = parsed;
      break;
    }
  }
  if (bundle === undefined) {
    t.skip('本机没有同时满足「事件数 > 10 且含工具调用」的 Codex 样本');
    return;
  }
  assert.equal(bundle.root.source.agent, 'codex');
  assert.ok(bundle.root.events.length > 10);
  assert.equal(bundle.root.head, bundle.root.events.at(-1)!.id);

  // 链完整
  let prev: string | null = null;
  for (const event of bundle.root.events) {
    assert.equal(event.parentId, prev);
    prev = event.id;
  }

  const counts = bundle.root.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.ok((counts.message ?? 0) > 0);
  assert.ok((counts.tool_call ?? 0) > 0);
  assert.ok((counts.tool_result ?? 0) > 0);
  // 真实样本可能存在中断调用或子代理分叉导致的未配对项：必须与 notice 计数严格账平
  const withoutOutput = bundle.root.notices.find((n) => n.code === 'codex.tool-without-output')?.count ?? 0;
  const orphan = bundle.root.notices.find((n) => n.code === 'codex.orphan-tool-result')?.count ?? 0;
  assert.equal(
    (counts.tool_call ?? 0) - withoutOutput,
    (counts.tool_result ?? 0) - orphan,
    '已配对的 function_call 与 function_call_output 数量应一致，未配对项必须如实记入 notice',
  );

  // event_msg 是 UI 镜像，必须被跳过（否则消息会翻倍）
  assert.ok(bundle.root.notices.some((n) => n.code === 'codex.event-msg-skipped'));
  assert.ok(bundle.root.notices.some((n) => n.code === 'codex.developer-messages-skipped'));

  // AGENTS.md 注入的 user 消息应标 synthetic
  const injected = bundle.root.events.filter((e) => e.kind === 'message' && e.synthetic);
  assert.ok(injected.length > 0);
});

test('会话 id 找不到时给出明确错误', async () => {
  await assert.rejects(() => readCodexSession('00000000-0000-4000-8000-000000000000', { home: HOME }), /找不到 Codex 会话/);
});

test('fixture: custom_tool_call 与 custom_tool_call_output 读取并配对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-codex-custom-'));
  try {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch';
    const file = writeFixtureRollout(dir, [
      {
        timestamp: '2026-11-20T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: '11111111-2222-4333-8444-555555555555', timestamp: '2026-11-20T00:00:00.000Z', cwd: '/tmp/codex-fixture', originator: 'codex_cli_rs', cli_version: '0.170.0' },
      },
      {
        timestamp: '2026-11-20T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '加个文件' }] },
      },
      {
        timestamp: '2026-11-20T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_custom_1', status: 'completed', name: 'apply_patch', input: patch },
      },
      {
        timestamp: '2026-11-20T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_custom_1', output: [{ type: 'input_text', text: 'Done' }] },
      },
    ]);

    const bundle = await readCodexSession(file, { home: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    const call = bundle.root.events.find((e) => e.kind === 'tool_call');
    const result = bundle.root.events.find((e) => e.kind === 'tool_result');
    assert.equal(call?.kind, 'tool_call');
    if (call?.kind === 'tool_call') {
      assert.equal(call.name, 'apply_patch');
      assert.equal(call.input, patch);
      assert.equal(call.callId, 'call_custom_1');
    }
    assert.equal(result?.kind, 'tool_result');
    if (result?.kind === 'tool_result') {
      assert.deepEqual(result.content, [{ type: 'text', text: 'Done' }]);
    }
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.unknown-line'));
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.tool-without-output'));
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.orphan-tool-result'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture: 0.169+ 运行时结构与无 call_id 的环境输出归类为 info notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-codex-noise-'));
  try {
    const file = writeFixtureRollout(dir, [
      {
        timestamp: '2026-11-22T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: '22222222-3333-4333-8444-555555555555', timestamp: '2026-11-22T00:00:00.000Z', cwd: '/tmp/codex-fixture', originator: 'codex_cli_rs', cli_version: '0.171.0' },
      },
      {
        timestamp: '2026-11-22T00:00:00.100Z',
        type: 'response_item',
        payload: { type: 'additional_tools', id: 'at_1', role: 'developer', tools: [] },
      },
      {
        timestamp: '2026-11-22T00:00:00.200Z',
        type: 'response_item',
        payload: { type: 'configuration_update', reasoning: { effort: 'xhigh' } },
      },
      {
        timestamp: '2026-11-22T00:00:00.300Z',
        type: 'inter_agent_communication_metadata',
        payload: { trigger_turn: true },
      },
      {
        timestamp: '2026-11-22T00:00:00.400Z',
        type: 'response_item',
        payload: { type: 'agent_message', id: 'amsg_1', author: '/root', recipient: '/root/a', content: [] },
      },
      {
        timestamp: '2026-11-22T00:00:00.500Z',
        type: 'response_item',
        payload: { type: 'function_call_output', id: 'fco_1', name: 'codex_apps_open_page', namespace: 'agent', output: '{"page_id":null}' },
        metadata: { additional_context_tool_output: true },
      },
      {
        timestamp: '2026-11-22T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      },
    ]);

    const bundle = await readCodexSession(file, { home: dir });
    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.root.events.length, 1);
    assert.equal(bundle.root.events[0]!.kind, 'message');
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.unknown-line'));
    assert.ok(!bundle.root.notices.some((n) => n.code === 'codex.orphan-tool-result'));

    const sys = bundle.root.notices.find((n) => n.code === 'codex.system-lines-skipped');
    const agentMsg = bundle.root.notices.find((n) => n.code === 'codex.agent-message-skipped');
    const ambient = bundle.root.notices.find((n) => n.code === 'codex.ambient-context-skipped');
    assert.equal(sys?.count, 3);
    assert.equal(sys?.severity, 'info');
    assert.equal(agentMsg?.count, 1);
    assert.equal(agentMsg?.severity, 'info');
    assert.equal(ambient?.count, 1);
    assert.equal(ambient?.severity, 'info');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
