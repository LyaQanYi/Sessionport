import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import { detectOpencodeExportFormat, exportOpencodeSession, exportToBundle, readOpencodeSession } from '../src/index.ts';

function sampleExport(): unknown {
  return {
    info: {
      id: 'ses_test000000000000000000001',
      slug: 'test-session',
      projectID: 'global',
      directory: '/tmp/sessionport-opencode',
      path: 'tmp/sessionport-opencode',
      title: 'opencode 测试会话',
      agent: 'build',
      model: { id: 'claude-haiku-5-5', providerID: 'opencode-go' },
      version: '1.19.3',
      time: { created: 1791807570253, updated: 1791807583495 },
    },
    messages: [
      {
        info: { id: 'msg_1', sessionID: 'ses_test000000000000000000001', role: 'user', time: { created: 1791807570300 } },
        parts: [{ type: 'text', text: '你好', id: 'prt_1' }],
      },
      {
        info: { id: 'msg_2', sessionID: 'ses_test000000000000000000001', role: 'assistant', parentID: 'msg_1', time: { created: 1791807570400 } },
        parts: [
          { type: 'step-start', id: 'prt_2' },
          { type: 'reasoning', text: '想一想', id: 'prt_3', metadata: { anthropic: { signature: 'sig-abc' } } },
          { type: 'text', text: '先看看目录', id: 'prt_4' },
          {
            type: 'tool',
            id: 'prt_5',
            callID: 'call_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'README.md' },
          },
          { type: 'step-finish', id: 'prt_6' },
          { type: 'text', text: '完成', id: 'prt_7' },
        ],
      },
    ],
  };
}

test('导出 JSON -> IR：user/assistant/reasoning/tool 配对映射', () => {
  const bundle = exportToBundle(sampleExport() as never);
  const kinds = bundle.root.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(kinds, { message: 3, reasoning: 1, tool_call: 1, tool_result: 1 });
  assert.equal(bundle.root.meta.cwd, '/tmp/sessionport-opencode');
  assert.equal(bundle.root.meta.title, 'opencode 测试会话');
  assert.equal(bundle.root.source.nativeSessionId, 'ses_test000000000000000000001');

  const call = bundle.root.events.find((event) => event.kind === 'tool_call') as { callId: string; name: string };
  assert.equal(call.callId, 'call_1');
  assert.equal(call.name, 'bash');
  const result = bundle.root.events.find((event) => event.kind === 'tool_result') as { callId: string };
  assert.equal(result.callId, 'call_1');
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'opencode.step-parts-skipped'));

  // 链完整
  let prev: string | null = null;
  for (const event of bundle.root.events) {
    assert.equal(event.parentId, prev);
    prev = event.id;
  }
});

test('读取已导出的 JSON 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-opencode-'));
  try {
    const file = join(dir, 'session.json');
    writeFileSync(file, JSON.stringify(sampleExport()));
    const bundle = await readOpencodeSession(file);
    assert.equal(bundle.root.events.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进行中的工具调用只保留调用并记 notice', () => {
  const raw = sampleExport() as { messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }> };
  const assistant = raw.messages[1]!;
  assistant.parts = [
    { type: 'tool', id: 'prt_x', callID: 'call_running', tool: 'bash', state: { status: 'running', input: {} } },
  ];
  const bundle = exportToBundle(raw as never);
  assert.equal(bundle.root.events.filter((event) => event.kind === 'tool_call').length, 1);
  assert.equal(bundle.root.events.filter((event) => event.kind === 'tool_result').length, 0);
  assert.ok(bundle.root.notices.some((notice) => notice.code === 'opencode.tool-without-output'));
});

function sampleV2Export(): unknown {
  return {
    info: {
      id: 'ses_v2test00000000000000001',
      projectID: 'proj_123',
      agent: 'build',
      model: { id: 'deepseek-v4.1-flash', providerID: 'opencode', variant: 'max' },
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
      outcome: 'succeeded',
      time: { created: 1794446993000, updated: 1794447006000 },
      title: 'opencode 2.x 测试会话',
      permissions: [],
      location: { directory: '/tmp/sessionport-opencode-v2' },
    },
    messages: [
      {
        id: 'msg_v2_01',
        type: 'user',
        time: { created: 1794446993100 },
        text: '请检查仓库',
        files: [{ url: 'file:///tmp/a.png' }],
        agents: [],
      },
      {
        id: 'msg_v2_02',
        type: 'synthetic',
        time: { created: 1794446993150 },
        text: 'Loaded AGENTS.md instructions',
      },
      {
        id: 'msg_v2_03',
        type: 'system',
        time: { created: 1794446993160 },
        text: 'System notice',
      },
      {
        id: 'msg_v2_04',
        type: 'assistant',
        time: { created: 1794446993200, completed: 1794446995000 },
        agent: 'build',
        model: { id: 'deepseek-v4.1-flash', providerID: 'opencode' },
        content: [
          { type: 'reasoning', text: '先列目录', state: { signature: 'sig-v2' }, time: { created: 1794446993210, completed: 1794446993300 } },
          { type: 'text', text: '我看一下文件' },
          {
            type: 'tool',
            id: 'call_v2_1',
            name: 'shell',
            executed: false,
            state: {
              status: 'completed',
              input: { command: 'ls' },
              content: [{ type: 'text', text: 'package.json' }],
              metadata: { exit: 0 },
            },
            time: { created: 1794446993400, ran: 1794446993410, completed: 1794446993500 },
          },
          {
            type: 'tool',
            id: 'call_v2_2',
            name: 'shell',
            executed: false,
            state: {
              status: 'error',
              input: { command: 'false' },
              error: { type: 'tool.execution', message: 'exit code 1' },
            },
            time: { created: 1794446993600, ran: 1794446993610, completed: 1794446993700 },
          },
          { type: 'text', text: '检查完了' },
        ],
        finish: 'stop',
        cost: 0,
        tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
      },
      {
        id: 'msg_v2_05',
        type: 'assistant',
        time: { created: 1794446995100, completed: 1794446995200 },
        agent: 'build',
        model: { id: 'deepseek-v4.1-flash', providerID: 'opencode' },
        content: [],
        finish: 'error',
        error: { type: 'provider.quota', message: 'quota exceeded' },
      },
      { id: 'msg_v2_06', type: 'model-switched', time: { created: 1794446995300 } },
      { id: 'msg_v2_07', type: 'idle', time: { created: 1794446995400 }, outcome: 'succeeded' },
    ],
  };
}

test('v2 导出 JSON -> IR：location/content/tool/reasoning/synthetic/runtime 消息完整映射', () => {
  const raw = sampleV2Export();
  assert.equal(detectOpencodeExportFormat(raw as never), 'v2');
  const bundle = exportToBundle(raw as never);
  assert.deepEqual(validateIrBundle(bundle), []);
  assert.equal(bundle.root.meta.cwd, '/tmp/sessionport-opencode-v2');
  assert.equal(bundle.root.meta.title, 'opencode 2.x 测试会话');
  assert.equal(bundle.root.meta.model, 'deepseek-v4.1-flash');
  assert.equal(bundle.root.source.formatVersion, '2');

  const kinds = bundle.root.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1;
    return acc;
  }, {});
  // 1 real user + 2 synthetic/system + 2 assistant text = 5 message; 1 reasoning; 2 tool_call; 2 tool_result
  assert.deepEqual(kinds, { message: 5, reasoning: 1, tool_call: 2, tool_result: 2 });

  const synthetics = bundle.root.events.filter((event) => event.kind === 'message' && event.synthetic === true);
  assert.equal(synthetics.length, 2);

  const reasoning = bundle.root.events.find((event) => event.kind === 'reasoning');
  assert.ok(reasoning && reasoning.kind === 'reasoning' && reasoning.reasoning.kind === 'plain');
  assert.equal(reasoning.reasoning.signature, 'sig-v2');

  const results = bundle.root.events.filter((event) => event.kind === 'tool_result');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.isError, false);
  assert.equal(results[1]!.isError, true);

  const noticeCodes = new Map(bundle.root.notices.map((n) => [n.code, n]));
  assert.equal(noticeCodes.get('opencode.runtime-messages-skipped')?.severity, 'info');
  assert.equal(noticeCodes.get('opencode.runtime-messages-skipped')?.count, 2);
  assert.equal(noticeCodes.get('opencode.synthetic-message')?.severity, 'info');
  assert.equal(noticeCodes.get('opencode.synthetic-message')?.count, 2);
  assert.equal(noticeCodes.get('opencode.assistant-error-skipped')?.severity, 'info');
  assert.equal(noticeCodes.get('opencode.file-parts-skipped')?.severity, 'warning');
});

function makeMockCli(dir: string, name: string, scriptBody: string): string {
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n' + scriptBody + '\n', 'utf8');
  chmodSync(file, 0o755);
  return file;
}

test('exportOpencodeSession：探测 2.x CLI 走 session export --standalone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-oc-cli-v2-'));
  try {
    const argsLog = join(dir, 'args.log');
    const payloadFile = join(dir, 'v2.json');
    writeFileSync(payloadFile, JSON.stringify(sampleV2Export()), 'utf8');
    const bin = makeMockCli(
      dir,
      'opencode-v2',
      [
        'if [ "$1" = "--version" ]; then echo "opencode v2.2.7"; exit 0; fi',
        `printf '%s\n' "$*" >> "${argsLog}"`,
        'if [ "$1" = "session" ] && [ "$2" = "export" ] && [ "$3" = "--standalone" ]; then',
        `  cat "${payloadFile}"`,
        '  exit 0',
        'fi',
        'echo "unexpected args: $*" >&2',
        'exit 1',
      ].join('\n'),
    );
    const exported = await exportOpencodeSession('ses_v2test00000000000000001', { binary: bin });
    assert.equal(detectOpencodeExportFormat(exported), 'v2');
    assert.equal(exported.info?.id, 'ses_v2test00000000000000001');
    assert.equal(readFileSync(argsLog, 'utf8').trim(), 'session export --standalone ses_v2test00000000000000001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exportOpencodeSession：探测 1.x CLI 走旧 export --pure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-oc-cli-v1-'));
  try {
    const argsLog = join(dir, 'args.log');
    const payloadFile = join(dir, 'v1.json');
    writeFileSync(payloadFile, JSON.stringify(sampleExport()), 'utf8');
    const bin = makeMockCli(
      dir,
      'opencode-v1',
      [
        'if [ "$1" = "--version" ]; then echo "1.19.5"; exit 0; fi',
        `printf '%s\n' "$*" >> "${argsLog}"`,
        'if [ "$1" = "export" ] && [ "$3" = "--pure" ]; then',
        `  cat "${payloadFile}"`,
        '  exit 0',
        'fi',
        'echo "unexpected args: $*" >&2',
        'exit 1',
      ].join('\n'),
    );
    const exported = await exportOpencodeSession('ses_test000000000000000000001', { binary: bin });
    assert.equal(detectOpencodeExportFormat(exported), 'v1');
    assert.equal(readFileSync(argsLog, 'utf8').trim(), 'export ses_test000000000000000000001 --pure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exportOpencodeSession：--version 不可用时先试 2.x 失败回退 1.x', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-oc-cli-fb-'));
  try {
    const argsLog = join(dir, 'args.log');
    const payloadFile = join(dir, 'v1.json');
    writeFileSync(payloadFile, JSON.stringify(sampleExport()), 'utf8');
    const bin = makeMockCli(
      dir,
      'opencode-fb',
      [
        'if [ "$1" = "--version" ]; then exit 1; fi',
        `printf '%s\n' "$*" >> "${argsLog}"`,
        'if [ "$1" = "export" ] && [ "$3" = "--pure" ]; then',
        `  cat "${payloadFile}"`,
        '  exit 0',
        'fi',
        'echo "unknown command: $1" >&2',
        'exit 1',
      ].join('\n'),
    );
    const exported = await exportOpencodeSession('ses_test000000000000000000001', { binary: bin });
    assert.equal(exported.info?.id, 'ses_test000000000000000000001');
    assert.deepEqual(readFileSync(argsLog, 'utf8').trim().split('\n'), [
      'session export --standalone ses_test000000000000000000001',
      'export ses_test000000000000000000001 --pure',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
