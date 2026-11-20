import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION, validateIrBundle } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';
import { detectOpencodeExportFormat, exportToBundle, verifyOpencodeExport, writeOpencodeSession } from '../src/index.ts';

const TEST_CWD = '/tmp/sessionport-opencode-test';

function chain(events: Array<IrEventDraft>): IrEvent[] {
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
  ] as Array<IrEventDraft>);

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
  ] as Array<IrEventDraft>);
  const report = await writeOpencodeSession(makeBundle(events), { cwd: TEST_CWD, dryRun: true, apply: false, id: 'ses_000000000000000000000002' });
  const tool = report.exportData.messages![1]!.parts![0]!;
  assert.equal(tool.state!.status, 'running');
  assert.ok(report.losses.some((loss) => loss.code === 'opencode.tool-without-result'));
});

test('synthetic 消息默认丢弃', async () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'Current runtime context' }], synthetic: true },
    { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'user', parts: [{ type: 'text', text: '真实消息' }] },
  ] as Array<IrEventDraft>);
  const report = await writeOpencodeSession(makeBundle(events), { cwd: TEST_CWD, dryRun: true, apply: false, id: 'ses_000000000000000000000003' });
  assert.equal(report.exportData.messages!.length, 1);
  assert.ok(report.losses.some((loss) => loss.code === 'opencode.injected-message-dropped'));
});

test('IR -> opencode v2 导出 JSON：location/content/tool(completed+error+非对象input) 并能 round-trip', async () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '你好' }] },
    { kind: 'reasoning', id: 'e2', at: '2026-01-01T00:00:01Z', reasoning: { kind: 'plain', text: '想一想' } },
    { kind: 'message', id: 'e3', at: '2026-01-01T00:00:02Z', role: 'assistant', parts: [{ type: 'text', text: '先看看' }] },
    { kind: 'tool_call', id: 'e4', at: '2026-01-01T00:00:03Z', callId: 'call_1', name: 'bash', input: { command: 'ls' } },
    { kind: 'tool_result', id: 'e5', at: '2026-01-01T00:00:04Z', callId: 'call_1', content: [{ type: 'text', text: 'README.md' }] },
    { kind: 'tool_call', id: 'e6', at: '2026-01-01T00:00:05Z', callId: 'call_2', name: 'bash', input: 'raw-string-input' },
    { kind: 'tool_result', id: 'e7', at: '2026-01-01T00:00:06Z', callId: 'call_2', content: [{ type: 'text', text: 'boom' }], isError: true },
    { kind: 'message', id: 'e8', at: '2026-01-01T00:00:07Z', role: 'assistant', parts: [{ type: 'text', text: '完成' }] },
  ] as Array<IrEventDraft>);
  const bundle = makeBundle(events);
  bundle.root.meta.model = 'claude-opus-5-5';

  const report = await writeOpencodeSession(bundle, {
    cwd: TEST_CWD,
    format: 'v2',
    dryRun: true,
    apply: false,
    id: 'ses_v20000000000000000000001',
  });
  assert.equal(report.format, 'v2');
  const data = report.exportData;
  assert.equal(detectOpencodeExportFormat(data), 'v2');
  assert.equal(data.info!.id, 'ses_v20000000000000000000001');
  assert.equal(data.info!.location?.directory, TEST_CWD);
  assert.equal(data.info!.model, undefined, '未显式指定模型时不锁定 info.model');
  assert.ok(report.losses.some((loss) => loss.code === 'opencode.model-not-migrated' && loss.severity === 'info'));

  assert.equal(data.messages!.length, 2);
  assert.equal(data.messages![0]!.type, 'user');
  assert.equal(data.messages![0]!.text, '你好');
  assert.equal(data.messages![1]!.type, 'assistant');
  const content = data.messages![1]!.content!;
  assert.deepEqual(content.map((b) => b.type), ['reasoning', 'text', 'tool', 'tool', 'text']);
  assert.equal(content[2]!.state!.status, 'completed');
  assert.deepEqual(content[2]!.state!.content, [{ type: 'text', text: 'README.md' }]);
  assert.equal(content[3]!.state!.status, 'error');
  assert.deepEqual(content[3]!.state!.input, { value: 'raw-string-input' });
  assert.equal(content[3]!.state!.error?.message, 'boom');

  const checks = verifyOpencodeExport(data);
  assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks));

  const roundTripped = exportToBundle(data);
  assert.deepEqual(validateIrBundle(roundTripped), []);
  assert.equal(roundTripped.root.events.length, events.length);
});

test('v2 缺失工具结果时导出为 aborted 错误态（不发 running/pending）并记 warning 损失', async () => {
  const events = chain([
    { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
    { kind: 'tool_call', id: 'e2', at: '2026-01-01T00:00:01Z', callId: 'call_missing', name: 'bash', input: { command: 'sleep 1' } },
  ] as Array<IrEventDraft>);
  const report = await writeOpencodeSession(makeBundle(events), {
    cwd: TEST_CWD,
    format: 'v2',
    dryRun: true,
    apply: false,
    id: 'ses_v20000000000000000000002',
  });
  const tool = report.exportData.messages![1]!.content![0]!;
  assert.equal(tool.state!.status, 'error');
  assert.equal(tool.state!.error?.type, 'aborted');
  assert.ok(report.losses.some((loss) => loss.code === 'opencode.tool-without-result' && loss.severity === 'warning'));
  const checks = verifyOpencodeExport(report.exportData);
  assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks));
});

function makeMockCli(dir: string, name: string, scriptBody: string): string {
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n' + scriptBody + '\n', 'utf8');
  chmodSync(file, 0o755);
  return file;
}

test('writeOpencodeSession：探测 2.x CLI 写 v2 JSON 并调用 session import --standalone --directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-oc-write-v2-'));
  try {
    const argsLog = join(dir, 'args.log');
    const capturedJson = join(dir, 'captured.json');
    const bin = makeMockCli(
      dir,
      'opencode-v2',
      [
        'if [ "$1" = "--version" ]; then echo "opencode v2.2.7"; exit 0; fi',
        `printf '%s\n' "$*" >> "${argsLog}"`,
        'if [ "$1" = "session" ] && [ "$2" = "import" ] && [ "$3" = "--standalone" ] && [ "$4" = "--directory" ]; then',
        `  cp "$6" "${capturedJson}"`,
        '  echo "Imported session: ses_mock_v2"',
        '  exit 0',
        'fi',
        'echo "unexpected args: $*" >&2',
        'exit 1',
      ].join('\n'),
    );
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hello v2' }] },
    ] as Array<IrEventDraft>);
    const report = await writeOpencodeSession(makeBundle(events), {
      cwd: dir,
      binary: bin,
      id: 'ses_v2mock00000000000000001',
    });
    assert.equal(report.imported, true);
    assert.equal(report.format, 'v2');
    const written = JSON.parse(readFileSync(capturedJson, 'utf8'));
    assert.equal(detectOpencodeExportFormat(written), 'v2');
    assert.equal(written.info.location.directory, dir);
    const logged = readFileSync(argsLog, 'utf8').trim();
    assert.match(logged, /^session import --standalone --directory /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOpencodeSession：探测 1.x CLI 写 v1 JSON 并调用 import --pure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-oc-write-v1-'));
  try {
    const argsLog = join(dir, 'args.log');
    const capturedJson = join(dir, 'captured.json');
    const bin = makeMockCli(
      dir,
      'opencode-v1',
      [
        'if [ "$1" = "--version" ]; then echo "1.19.5"; exit 0; fi',
        `printf '%s\n' "$*" >> "${argsLog}"`,
        'if [ "$1" = "import" ] && [ "$3" = "--pure" ]; then',
        `  cp "$2" "${capturedJson}"`,
        '  echo "Imported session: ses_mock_v1"',
        '  exit 0',
        'fi',
        'echo "unexpected args: $*" >&2',
        'exit 1',
      ].join('\n'),
    );
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hello v1' }] },
    ] as Array<IrEventDraft>);
    const report = await writeOpencodeSession(makeBundle(events), {
      cwd: dir,
      binary: bin,
      id: 'ses_v1mock00000000000000001',
    });
    assert.equal(report.imported, true);
    assert.equal(report.format, 'v1');
    const written = JSON.parse(readFileSync(capturedJson, 'utf8'));
    assert.equal(detectOpencodeExportFormat(written), 'v1');
    assert.equal(written.info.directory, dir);
    const logged = readFileSync(argsLog, 'utf8').trim();
    assert.match(logged, /^import .* --pure$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOpencodeSession：--version 不可用时先试 2.x 失败回退 1.x 并重写 v1 JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-oc-write-fb-'));
  try {
    const argsLog = join(dir, 'args.log');
    const capturedJson = join(dir, 'captured.json');
    const bin = makeMockCli(
      dir,
      'opencode-fb',
      [
        'if [ "$1" = "--version" ]; then exit 1; fi',
        `printf '%s\n' "$*" >> "${argsLog}"`,
        'if [ "$1" = "import" ] && [ "$3" = "--pure" ]; then',
        `  cp "$2" "${capturedJson}"`,
        '  echo "Imported session: ses_mock_fb"',
        '  exit 0',
        'fi',
        'echo "unknown command: $1" >&2',
        'exit 1',
      ].join('\n'),
    );
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: 'hello fb' }] },
    ] as Array<IrEventDraft>);
    const report = await writeOpencodeSession(makeBundle(events), {
      cwd: dir,
      binary: bin,
      id: 'ses_fbmock00000000000000001',
    });
    assert.equal(report.imported, true);
    assert.equal(report.format, 'v1');
    const written = JSON.parse(readFileSync(capturedJson, 'utf8'));
    assert.equal(detectOpencodeExportFormat(written), 'v1');
    const lines = readFileSync(argsLog, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^session import --standalone --directory /);
    assert.match(lines[1]!, /^import .* --pure$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
