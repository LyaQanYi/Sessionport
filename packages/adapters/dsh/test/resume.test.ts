import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { readDshSession } from '../src/read.ts';
import { dshAppPaths, resumeSmokeDsh, verifyDshSession } from '../src/verify.ts';
import { writeDshSession } from '../src/write.ts';
import { buildCanaryBundle, buildMinimalBundle, makeTempDir } from './fixtures.ts';

const CWD = process.cwd();

test('隔离 DSH_HOME 下用官方 headless profile 真实加载写出的会话（无安装包时 skip）', async (t) => {
  const paths = dshAppPaths();
  if (paths === undefined) {
    t.skip('no DSH app');
    return;
  }
  const hasApp = await access(paths.binary).then(() => true).catch(() => false);
  if (!hasApp) {
    t.skip('DSH app binary not found: ' + paths.binary);
    return;
  }
  const home = await makeTempDir('home-resume-');
  try {
    const report = await writeDshSession(buildMinimalBundle(CWD), { home });
    const smoke = await resumeSmokeDsh({ home, sessionId: report.sessionId, cwd: CWD, timeoutMs: 120000 });
    assert.equal(smoke.loaded, true, 'DSH 没有加载会话: ' + smoke.stderr + '\n' + smoke.stdout);
    assert.equal(smoke.turnStarted, true, 'DSH 没有开始新 turn: ' + smoke.stdout);
    assert.equal(smoke.ok, true, 'resume smoke 失败: ' + smoke.stderr);
    assert.ok(smoke.command.includes('headless --json --session-id'));
    // 没有 API key 时会报 MISSING_CREDENTIAL —— 不影响"会话被加载"的结论
    assert.equal(smoke.missingCredential, true);

    // 应用已经往我们写的文件里追加了它自己的事件（session/end-seed、turn/start...），
    // 说明它按 v4 格式接管了这个会话；结构自检仍应全部通过。
    const verify = await verifyDshSession({ home, sessionId: report.sessionId });
    const failed = verify.checks.filter((check) => !check.ok);
    assert.equal(failed.length, 0, 'resume 后结构校验失败: ' + JSON.stringify(failed));

    const readBack = await readDshSession(join(report.sessionDir, 'session.v4.jsonl.zstd'), { home, includeChildren: false });
    assert.ok(readBack.root.events.length >= 4, '应能读回原对话 + 应用追加的事件');
    assert.ok(readBack.root.notices.some((notice) => notice.code === 'dsh.non-conversation-event'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('用本地 mock Messages API 完成一次真实 resume turn（会话被加载 + 上下文回放 + 追加 assistant 消息）', async (t) => {
  const paths = dshAppPaths();
  const hasApp = paths !== undefined && (await access(paths.binary).then(() => true).catch(() => false));
  if (!hasApp) {
    t.skip('DSH app binary not found');
    return;
  }
  const home = await makeTempDir('home-resume-mock-');
  const requests: string[] = [];
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK_RESUME_OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const frame of frames) response.write('data: ' + JSON.stringify(frame) + '\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = (address as { port: number }).port;
  try {
    const report = await writeDshSession(buildCanaryBundle(CWD), { home });
    const smoke = await resumeSmokeDsh({
      home,
      sessionId: report.sessionId,
      cwd: CWD,
      timeoutMs: 120000,
      env: { DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + port, DEEPSEEK_API_KEY: 'sk-mock-canary' },
    });
    assert.equal(smoke.ok, true, 'resume smoke 失败: ' + smoke.stderr + '\n' + smoke.stdout);
    assert.ok(smoke.stdout.includes('MOCK_RESUME_OK'), 'mock 回复没有出现在 stdout: ' + smoke.stdout);
    assert.equal(requests.length, 1, '应只有一次模型请求');

    // 模型可见上下文必须完整回放源会话（reasoning/tool_use/tool_result 都在）
    const body = JSON.parse(requests[0]!) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const serialized = requests[0]!;
    for (const canary of [
      'MOCK_CANARY_USER_ALPHA',
      'MOCK_CANARY_ASSISTANT_BETA',
      'MOCK_CANARY_REASONING_GAMMA',
      'MOCK_CANARY_TOOL_DELTA',
      'MOCK_CANARY_TOOL_RESULT_EPSILON',
      'MOCK_CANARY_FINAL_ZETA',
    ]) {
      assert.ok(serialized.includes(canary), '模型请求里缺 canary: ' + canary);
    }
    const roles = body.messages.map((message) => message.role);
    assert.ok(roles.includes('assistant') && roles.includes('user'));
    const toolUse = body.messages.flatMap((message) => message.content).find((block) => block.type === 'tool_use');
    assert.ok(toolUse !== undefined, '模型请求里应有 tool_use 块');
    assert.equal(toolUse['id'], 'call_mock_1');
    const toolResult = body.messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result');
    assert.ok(toolResult !== undefined, '模型请求里应有配对的 tool_result 块');
    assert.equal(toolResult['tool_use_id'], 'call_mock_1');

    // 应用把新 assistant 消息追加进了我们写的会话文件
    const readBack = await readDshSession(join(report.sessionDir, 'session.v4.jsonl.zstd'), { home, includeChildren: false });
    const appended = readBack.root.events.find((event) => event.kind === 'message' && event.role === 'assistant' && event.parts.some((part) => part.type === 'text' && part.text === 'MOCK_RESUME_OK'));
    assert.ok(appended !== undefined, 'resume 后应能读回应用追加的 assistant 消息');
    const verify = await verifyDshSession({ home, sessionId: report.sessionId });
    assert.equal(verify.ok, true, 'resume 后结构校验失败: ' + JSON.stringify(verify.checks.filter((check) => !check.ok)));
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(home, { recursive: true, force: true });
  }
});
