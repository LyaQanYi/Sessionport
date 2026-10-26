import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { listCodexSessions, readCodexSession } from '../src/index.ts';

const HOME = process.env.CODEX_HOME ?? process.env.HOME + '/.codex';
const SESSIONS = existsSync(HOME) ? await listCodexSessions() : [];
const hasReal = SESSIONS.length > 0;

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
  assert.equal(counts.tool_call, counts.tool_result, 'function_call 与 function_call_output 应一一配对');

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