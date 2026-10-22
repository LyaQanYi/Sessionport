import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import type { IrEvent, IrEventInput } from '@sessionport/core';

import { CAPABILITY_TOOL_FORMER, buildCursorToolFormerData, resolveCursorTool } from '../src/index.ts';
import { readCursorSession, verifyCursorSession, writeCursorSession } from '../src/index.ts';
import { closeCursorDb, openCursorDb, readDiskKvEntries, readDiskKvValue } from '../src/wire.ts';
import {
  BASE_MS,
  createCursorFixture,
  makeIrBundle,
  toolCallEvent,
  toolResultEvent,
  userMessage,
} from './helpers.ts';
import type { CursorFixture } from './helpers.ts';

const TOOL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COPY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function at(offset: number): string {
  return new Date(BASE_MS + offset).toISOString();
}

interface ToolCase {
  id: string;
  sourceName: string;
  input: Record<string, unknown>;
  output: string;
  cursorName: string;
  tool: number;
  /** Cursor 落库时会被剪成 additionalData 的工具 */
  pruned?: boolean;
}

const TOOL_CASES: ToolCase[] = [
  {
    id: 'c-shell',
    sourceName: 'Bash',
    input: { command: 'ls -la', cwd: '/tmp/work' },
    output: 'total 0\nfile.txt',
    cursorName: 'run_terminal_command_v2',
    tool: 15,
  },
  {
    id: 'c-read',
    sourceName: 'Read',
    input: { file_path: '/tmp/work/a.ts', offset: 2, limit: 10 },
    output: 'line1\nline2',
    cursorName: 'read_file_v2',
    tool: 40,
  },
  {
    id: 'c-edit',
    sourceName: 'Edit',
    input: { file_path: '/tmp/work/a.ts', old_string: 'a', new_string: 'b' },
    output: 'The file has been updated',
    cursorName: 'edit_file_v2',
    tool: 38,
  },
  {
    id: 'c-grep',
    sourceName: 'Grep',
    input: { pattern: 'foo', path: '/tmp/work', output_mode: 'content' },
    output: 'a.ts:1:foo\nb.ts:2:foo',
    cursorName: 'ripgrep_raw_search',
    tool: 41,
    pruned: true,
  },
  {
    id: 'c-glob',
    sourceName: 'Glob',
    input: { pattern: '**/*.ts', path: '/tmp/work' },
    output: './a.ts\n./b.ts',
    cursorName: 'glob_file_search',
    tool: 42,
  },
  {
    id: 'c-list',
    sourceName: 'LS',
    input: { path: '/tmp/work' },
    output: 'a.ts\nsrc/\n',
    cursorName: 'list_dir_v2',
    tool: 39,
    pruned: true,
  },
  {
    id: 'c-delete',
    sourceName: 'Delete',
    input: { file_path: '/tmp/work/a.ts' },
    output: 'Deleted a.ts',
    cursorName: 'delete_file',
    tool: 11,
  },
  {
    id: 'c-write',
    sourceName: 'Write',
    input: { file_path: '/tmp/work/c.ts', content: 'hello' },
    output: 'Created c.ts',
    cursorName: 'edit_file_v2',
    tool: 38,
  },
  {
    id: 'c-todo',
    sourceName: 'TodoWrite',
    input: { todos: [{ id: 't1', content: 'do', status: 'pending' }] },
    output: 'ok',
    cursorName: 'todo_write',
    tool: 35,
  },
];

function toolEvents(): Array<ReturnType<typeof toolCallEvent> | ReturnType<typeof toolResultEvent>> {
  const events: Array<ReturnType<typeof toolCallEvent> | ReturnType<typeof toolResultEvent>> = [];
  TOOL_CASES.forEach((toolCase, index) => {
    events.push(toolCallEvent(toolCase.id, toolCase.sourceName, toolCase.input, at(1000 + index * 200)));
    events.push(toolResultEvent(toolCase.id, toolCase.output, at(1100 + index * 200)));
  });
  return events;
}

interface StoredBubble {
  key: string;
  bubble: Record<string, unknown>;
}

function storedBubbles(fixture: CursorFixture, composerId: string): StoredBubble[] {
  const db = openCursorDb(fixture.dbPath, { readOnly: true });
  try {
    const out: StoredBubble[] = [];
    for (const [key, value] of readDiskKvEntries(db, 'bubbleId:' + composerId + ':')) {
      out.push({ key, bubble: JSON.parse(value) as Record<string, unknown> });
    }
    return out;
  } finally {
    closeCursorDb(db);
  }
}

function toolFormerOf(bubble: Record<string, unknown>): Record<string, unknown> | undefined {
  const tool = bubble.toolFormerData;
  return tool !== null && typeof tool === 'object' && !Array.isArray(tool) ? (tool as Record<string, unknown>) : undefined;
}

test('常见工具写入 toolFormerData：字段/枚举/params/result 与读回一致', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle([userMessage('跑一遍常见工具'), ...toolEvents()], {
      cwd: fixture.cwd,
      title: '工具写入测试',
    });
    const result = await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
      model: 'gpt-5',
    });
    assert.equal(result.written.toolCalls, TOOL_CASES.length);
    assert.equal(result.written.toolResults, TOOL_CASES.length);
    const lossCodes = new Map(result.losses.map((loss) => [loss.code, loss.count]));
    assert.equal(lossCodes.get('cursor.tool-call-unsupported'), undefined, JSON.stringify(result.losses));
    assert.equal(lossCodes.get('cursor.tool-input-unusable'), undefined, JSON.stringify(result.losses));
    assert.ok((lossCodes.get('cursor.edit-diff-unavailable') ?? 0) >= 2);
    assert.equal(lossCodes.get('cursor.write-mapped-to-edit'), 1);

    const bubbles = storedBubbles(fixture, TOOL_ID);
    assert.equal(bubbles.length, TOOL_CASES.length + 1);
    const byCallId = new Map<string, Record<string, unknown>>();
    for (const { bubble } of bubbles) {
      const tool = toolFormerOf(bubble);
      if (tool === undefined) continue;
      assert.equal(bubble.type, 2);
      assert.equal(bubble.capabilityType, CAPABILITY_TOOL_FORMER);
      assert.equal(bubble.text, '');
      byCallId.set(String(tool.toolCallId), tool);
    }
    assert.equal(byCallId.size, TOOL_CASES.length);

    for (const toolCase of TOOL_CASES) {
      const tool = byCallId.get(toolCase.id);
      assert.ok(tool !== undefined, '缺少工具气泡 ' + toolCase.id);
      assert.equal(tool.name, toolCase.cursorName);
      assert.equal(tool.tool, toolCase.tool);
      assert.equal(tool.status, 'completed');
      assert.equal(tool.modelCallId, toolCase.id);
      const params = JSON.parse(String(tool.params)) as Record<string, unknown>;
      assert.equal(typeof params, 'object');
      const extension = tool._sessionport as Record<string, unknown>;
      assert.equal(extension.v, 1);
      assert.equal(extension.name, toolCase.sourceName);
      assert.deepEqual(extension.input, toolCase.input);
      if (toolCase.pruned === true) {
        assert.equal(tool.result, undefined);
        const additional = tool.additionalData as Record<string, unknown>;
        assert.equal(additional.isPruned, true);
      } else {
        assert.equal(typeof tool.result, 'string');
        assert.equal(typeof JSON.parse(String(tool.result)), 'object');
      }
    }

    // 标题里的 grouping 也要能对到 toolFormerTool / status
    const db = openCursorDb(fixture.dbPath, { readOnly: true });
    let composerRaw: string | undefined;
    try {
      composerRaw = readDiskKvValue(db, 'composerData:' + TOOL_ID);
    } finally {
      closeCursorDb(db);
    }
    assert.ok(composerRaw !== undefined);
    const headers = (JSON.parse(composerRaw) as { fullConversationHeadersOnly: Array<Record<string, unknown>> })
      .fullConversationHeadersOnly;
    const shellHeader = headers.find((entry) => {
      const grouping = entry.grouping as Record<string, unknown> | undefined;
      return grouping?.toolFormerTool === 15;
    });
    assert.ok(shellHeader !== undefined);
    const shellGrouping = shellHeader.grouping as Record<string, unknown>;
    assert.equal(shellGrouping.capabilityType, CAPABILITY_TOOL_FORMER);
    assert.equal(shellGrouping.toolFormerStatus, 'completed');
    assert.equal(shellGrouping.toolCallId, 'c-shell');

    const readback = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    const kinds = readback.root.events.map((event) => event.kind);
    const expectedKinds: string[] = ['message'];
    for (let index = 0; index < TOOL_CASES.length; index += 1) expectedKinds.push('tool_call', 'tool_result');
    assert.deepEqual(kinds, expectedKinds);
    for (let index = 0; index < TOOL_CASES.length; index += 1) {
      const toolCase = TOOL_CASES[index] as ToolCase;
      const call = readback.root.events[1 + index * 2];
      const resultEvent = readback.root.events[2 + index * 2];
      assert.ok(call !== undefined && call.kind === 'tool_call');
      assert.equal(call.callId, toolCase.id);
      assert.equal(call.name, toolCase.sourceName);
      assert.deepEqual(call.input, toolCase.input);
      assert.ok(resultEvent !== undefined && resultEvent.kind === 'tool_result');
      assert.equal(resultEvent.callId, toolCase.id);
      assert.deepEqual(resultEvent.content, [{ type: 'text', text: toolCase.output }]);
      assert.equal(resultEvent.isError, false);
    }

    const report = await verifyCursorSession({
      home: fixture.home,
      sessionId: TOOL_ID,
      expected: {
        bubbles: TOOL_CASES.length + 1,
        eventCount: 1 + TOOL_CASES.length * 2,
        userMessages: 1,
        assistantMessages: 0,
        toolCalls: TOOL_CASES.length,
        toolResults: TOOL_CASES.length,
      },
    });
    assert.deepEqual(
      report.checks.filter((check) => !check.ok),
      [],
    );
    assert.equal(report.readback?.toolCalls, TOOL_CASES.length);
    assert.equal(report.readback?.toolResults, TOOL_CASES.length);
  } finally {
    fixture.cleanup();
  }
});

test('工具结果错误态：status=error、ToolResultError、读回 isError', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [
        userMessage('跑一个失败命令'),
        toolCallEvent('err-1', 'Bash', { command: 'false' }, at(1000)),
        {
          kind: 'tool_result',
          callId: 'err-1',
          content: [{ type: 'text', text: 'command failed' }],
          isError: true,
          at: at(1100),
        } as unknown as IrEventInput,
        toolCallEvent('err-2', 'Grep', { pattern: 'foo' }, at(1200)),
        {
          kind: 'tool_result',
          callId: 'err-2',
          content: [{ type: 'text', text: 'ripgrep: invalid pattern' }],
          isError: true,
          at: at(1300),
        } as unknown as IrEventInput,
      ],
      { cwd: fixture.cwd, title: '错误态' },
    );
    await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const bubbles = storedBubbles(fixture, TOOL_ID);
    const tools = bubbles.map(({ bubble }) => toolFormerOf(bubble)).filter((value) => value !== undefined);
    const tool = tools.find((value) => value.name === 'run_terminal_command_v2');
    assert.ok(tool !== undefined);
    assert.equal(tool.status, 'error');
    assert.equal(tool.name, 'run_terminal_command_v2');
    const error = JSON.parse(String(tool.error)) as Record<string, unknown>;
    assert.equal(error.clientVisibleErrorMessage, 'command failed');
    assert.equal(error.modelVisibleErrorMessage, 'command failed');
    const additional = tool.additionalData as Record<string, unknown>;
    assert.equal(additional.status, 'error');
    const result = JSON.parse(String(tool.result)) as Record<string, unknown>;
    assert.equal(result.exitCode, 1);

    const grepTool = tools.find((value) => value.name === 'ripgrep_raw_search');
    assert.ok(grepTool !== undefined);
    assert.equal(grepTool.status, 'error');
    assert.equal(grepTool.additionalData, undefined);
    assert.equal(grepTool.result, undefined);

    const readback = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    const resultEvents = readback.root.events.filter((event) => event.kind === 'tool_result');
    assert.equal(resultEvents.length, 2);
    const resultEvent = resultEvents[0];
    assert.ok(resultEvent !== undefined && resultEvent.kind === 'tool_result');
    assert.equal(resultEvent.isError, true);
    assert.deepEqual(resultEvent.content, [{ type: 'text', text: 'command failed' }]);
    const report = await verifyCursorSession({ home: fixture.home, sessionId: TOOL_ID });
    assert.deepEqual(
      report.checks.filter((check) => !check.ok),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test('不支持的工具有显式 loss，不会静默丢弃', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [
        userMessage('未知工具'),
        toolCallEvent('unknown-1', 'WebSearch', { query: 'x' }, at(1000)),
        toolResultEvent('unknown-1', 'results', at(1100)),
        toolCallEvent('bad-input', 'Bash', {}, at(1200)),
        toolResultEvent('bad-input', 'no command', at(1300)),
        toolCallEvent('orphan-call', 'Read', { file_path: '/tmp/work/a.ts' }, at(1400)),
        toolResultEvent('never-called', 'orphan result', at(1500)),
      ],
      { cwd: fixture.cwd, title: '降级' },
    );
    const result = await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const counts = new Map(result.losses.map((loss) => [loss.code, loss.count]));
    assert.equal(counts.get('cursor.tool-call-unsupported'), 1);
    assert.equal(counts.get('cursor.tool-input-unusable'), 1);
    assert.equal(counts.get('cursor.orphan-tool-result'), 1);
    const unsupported = result.losses.find((loss) => loss.code === 'cursor.tool-call-unsupported');
    assert.equal(unsupported?.severity, 'warning');
    assert.equal(result.written.toolCalls, 1); // 只有 orphan-call 被写成 cancelled 工具气泡
    const toolBubbles = storedBubbles(fixture, TOOL_ID).filter(({ bubble }) => toolFormerOf(bubble) !== undefined);
    assert.equal(toolBubbles.length, 1);
    const readback = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    const calls = readback.root.events.filter((event) => event.kind === 'tool_call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind === 'tool_call' ? calls[0].name : '', 'Read');
  } finally {
    fixture.cleanup();
  }
});

test('工具调用没有结果：status=cancelled + info loss，读回只有 tool_call', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [userMessage('只调用不返回'), toolCallEvent('c-only', 'Read', { file_path: '/tmp/work/a.ts' }, at(1000))],
      { cwd: fixture.cwd, title: '缺结果' },
    );
    const result = await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const missing = result.losses.find((loss) => loss.code === 'cursor.tool-result-missing');
    assert.equal(missing?.severity, 'info');
    const tool = storedBubbles(fixture, TOOL_ID)
      .map(({ bubble }) => toolFormerOf(bubble))
      .find((value) => value !== undefined);
    assert.ok(tool !== undefined);
    assert.equal(tool.status, 'cancelled');
    assert.equal(tool.result, undefined);
    const readback = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    assert.deepEqual(readback.root.events.map((event) => event.kind), ['message', 'tool_call']);
    const report = await verifyCursorSession({
      home: fixture.home,
      sessionId: TOOL_ID,
      expected: { toolCalls: 1, toolResults: 0 },
    });
    assert.deepEqual(
      report.checks.filter((check) => !check.ok),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test('JSON 结果也按源 IR 精确往返（_sessionport.content）', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [
        userMessage('结构化结果'),
        toolCallEvent('json-1', 'Bash', { command: 'echo ok' }, at(1000)),
        {
          kind: 'tool_result',
          callId: 'json-1',
          content: [{ type: 'json', value: { exit_code: 0, stdout: 'ok' } }],
          at: at(1100),
        } as unknown as IrEventInput,
      ],
      { cwd: fixture.cwd, title: 'JSON 结果' },
    );
    await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const readback = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    const resultEvent = readback.root.events.find((event) => event.kind === 'tool_result');
    assert.ok(resultEvent !== undefined && resultEvent.kind === 'tool_result');
    assert.deepEqual(resultEvent.content, [{ type: 'json', value: { exit_code: 0, stdout: 'ok' } }]);
  } finally {
    fixture.cleanup();
  }
});

test('原生 Cursor 的 grep additionalData 摘要读成 tool_result', async () => {
  const fixture = createCursorFixture({
    composers: [
      {
        composerId: TOOL_ID,
        name: '原生 grep',
        bubbles: [
          { type: 1, text: '搜一下' },
          {
            type: 2,
            tool: {
              name: 'ripgrep_raw_search',
              toolCallId: 'native-grep-1',
              tool: 41,
              params: { pattern: 'foo', path: '/tmp/work' },
              status: 'completed',
              additionalData: {
                isPruned: true,
                pattern: 'foo',
                path: '/tmp/work',
                totalFiles: 1,
                totalMatches: 2,
                topFiles: [{ uri: 'a.ts', matchCount: 2 }],
              },
            },
          },
        ],
      },
    ],
  });
  try {
    const bundle = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    const call = bundle.root.events.find((event) => event.kind === 'tool_call');
    assert.ok(call !== undefined && call.kind === 'tool_call');
    assert.equal(call.name, 'ripgrep_raw_search');
    assert.deepEqual(call.input, { pattern: 'foo', path: '/tmp/work' });
    const resultEvent = bundle.root.events.find((event) => event.kind === 'tool_result');
    assert.ok(resultEvent !== undefined && resultEvent.kind === 'tool_result');
    assert.equal(resultEvent.content[0]?.type, 'json');
    const value = (resultEvent.content[0] as { value: Record<string, unknown> }).value;
    assert.equal(value.isPruned, true);
    assert.equal(value.totalMatches, 2);

    // 再写回 Cursor：additionalData 应复用原生摘要，而不是把 JSON 文本重新 grep 一遍
    await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: COPY_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const copiedTool = storedBubbles(fixture, COPY_ID)
      .map(({ bubble }) => toolFormerOf(bubble))
      .find((tool) => tool !== undefined);
    assert.ok(copiedTool !== undefined);
    assert.deepEqual(copiedTool.additionalData, value);
    const copiedRead = await readCursorSession(COPY_ID, { home: fixture.home, includeChildren: false });
    const copiedResult = copiedRead.root.events.find((event) => event.kind === 'tool_result');
    assert.ok(copiedResult !== undefined && copiedResult.kind === 'tool_result');
    assert.deepEqual(copiedResult.content, resultEvent.content);
  } finally {
    fixture.cleanup();
  }
});

test('verify 能发现坏掉的 toolFormerData.params', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [userMessage('破坏 verify'), toolCallEvent('c-verify', 'Bash', { command: 'ls' }, at(1000)), toolResultEvent('c-verify', 'ok', at(1100))],
      { cwd: fixture.cwd, title: '校验' },
    );
    await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const bubble = storedBubbles(fixture, TOOL_ID).find(({ bubble: value }) => toolFormerOf(value) !== undefined);
    assert.ok(bubble !== undefined);
    const db = openCursorDb(fixture.dbPath);
    try {
      const parsed = bubble.bubble as Record<string, unknown>;
      const tool = toolFormerOf(parsed) as Record<string, unknown>;
      tool.params = '{broken';
      db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(JSON.stringify(parsed), bubble.key);
    } finally {
      closeCursorDb(db);
    }
    const report = await verifyCursorSession({ home: fixture.home, sessionId: TOOL_ID, skipReadback: true });
    assert.equal(report.ok, false);
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.ok(failed.includes('toolformer-params-json'), failed.join(','));
  } finally {
    fixture.cleanup();
  }
});

test('原生 edit_file_v2 名称不会被 Write 映射抢走', () => {
  const edit = resolveCursorTool('edit_file_v2');
  assert.ok(edit !== undefined);
  assert.equal(edit.cursorName, 'edit_file_v2');
  assert.equal(edit.kind, 'edit');
  const write = resolveCursorTool('Write');
  assert.ok(write !== undefined);
  assert.equal(write.kind, 'write');
  const built = buildCursorToolFormerData(
    { callId: 'e-native', name: 'edit_file_v2', input: { relativeWorkspacePath: '/tmp/work/a.ts', new_string: 'b' }, atMs: 0 },
    undefined,
  );
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.data.name, 'edit_file_v2');
    assert.equal(typeof (JSON.parse(String(built.data.params)) as Record<string, unknown>).streamingContent, 'string');
  }
});

test('字符串形式的工具参数也能编码（按工具语义兜底）', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [
        userMessage('字符串参数'),
        toolCallEvent('s-1', 'Bash', 'echo hi', at(1000)),
        toolResultEvent('s-1', 'hi', at(1100)),
        toolCallEvent('s-2', 'Read', '/tmp/work/a.ts', at(1200)),
        toolResultEvent('s-2', 'content', at(1300)),
      ],
      { cwd: fixture.cwd, title: '字符串参数' },
    );
    await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    const tools = storedBubbles(fixture, TOOL_ID)
      .map(({ bubble }) => toolFormerOf(bubble))
      .filter((value) => value !== undefined);
    assert.equal(tools.length, 2);
    const shell = tools.find((value) => value.name === 'run_terminal_command_v2');
    assert.ok(shell !== undefined);
    assert.deepEqual(JSON.parse(String(shell.params)), { command: 'echo hi' });
    const read = tools.find((value) => value.name === 'read_file_v2');
    assert.ok(read !== undefined);
    assert.equal((JSON.parse(String(read.params)) as Record<string, unknown>).targetFile, '/tmp/work/a.ts');
    const readback = await readCursorSession(TOOL_ID, { home: fixture.home, includeChildren: false });
    const calls = readback.root.events.filter((event) => event.kind === 'tool_call');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.kind === 'tool_call' ? calls[0].input : '', 'echo hi');
    assert.equal(calls[1]?.kind === 'tool_call' ? calls[1].input : '', '/tmp/work/a.ts');
  } finally {
    fixture.cleanup();
  }
});

test('Write 映射为 edit_file_v2，内容保留并显式记录近似', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = makeIrBundle(
      [
        userMessage('写文件'),
        toolCallEvent('w-1', 'Write', { file_path: '/tmp/work/new.ts', content: 'export const x = 1;' }, at(1000)),
        toolResultEvent('w-1', 'Created new.ts', at(1100)),
      ],
      { cwd: fixture.cwd, title: '写文件' },
    );
    const result = await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: TOOL_ID,
      backupDir: join(fixture.home, 'backup'),
    });
    assert.ok(result.losses.some((loss) => loss.code === 'cursor.write-mapped-to-edit'));
    const tool = storedBubbles(fixture, TOOL_ID)
      .map(({ bubble }) => toolFormerOf(bubble))
      .find((value) => value !== undefined);
    assert.ok(tool !== undefined);
    assert.equal(tool.name, 'edit_file_v2');
    const params = JSON.parse(String(tool.params)) as Record<string, unknown>;
    assert.equal(params.relativeWorkspacePath, '/tmp/work/new.ts');
    assert.equal(params.contentsAfterEdit, 'export const x = 1;');
    const resultObj = JSON.parse(String(tool.result)) as Record<string, unknown>;
    assert.equal(resultObj.fileWasCreated, true);
    assert.equal(resultObj.contentsAfterEdit, 'export const x = 1;');
  } finally {
    fixture.cleanup();
  }
});
