import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_CALL_FIELD,
  decodeEditToolCallBinary,
  decodeToolCallBinary,
  encodeDeleteToolCallBinary,
  encodeEditToolCallBinary,
  encodeGlobToolCallBinary,
  encodeGrepToolCallBinary,
  encodeLsToolCallBinary,
  encodeReadToolCallBinary,
  encodeShellToolCallBinary,
  encodeToolCallBinary,
  toolCallFieldForKind,
  toolCallKindForField,
} from '../src/toolcall-binary.ts';

const DIFF = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'].join('\n');

function firstByte(base64: string): number {
  return Buffer.from(base64, 'base64')[0] as number;
}

test('encodeEditToolCallBinary → decodeEditToolCallBinary 往返（edit_tool_call 字段 12）', () => {
  const base64 = encodeEditToolCallBinary({
    path: 'src/app.ts',
    linesAdded: 2,
    linesRemoved: 1,
    diffText: DIFF,
  });
  // ToolCall.edit_tool_call 是 field 12 / wire type 2 → tag byte 0x62
  assert.equal(firstByte(base64), 0x62);
  const decoded = decodeEditToolCallBinary(base64);
  assert.ok(decoded !== undefined);
  assert.equal(decoded.path, 'src/app.ts');
  assert.equal(decoded.linesAdded, 2);
  assert.equal(decoded.linesRemoved, 1);
  assert.equal(decoded.diffString, DIFF);
  // 通用解码器也要认出 edit 分支
  const generic = decodeToolCallBinary(base64);
  assert.ok(generic !== undefined);
  assert.equal(generic.tool, 'edit');
});

test('shell_tool_call（字段 1）：args/result 往返', () => {
  const base64 = encodeShellToolCallBinary({
    command: 'ls -la',
    workingDirectory: '/tmp/work',
    description: 'List files',
    timeoutMs: 30000,
    outcome: { ok: true, output: 'total 0', exitCode: 0 },
  });
  // oneof 分支 shell = field 1 → 0x0a
  assert.equal(firstByte(base64), 0x0a);
  const decoded = decodeToolCallBinary(base64);
  assert.ok(decoded !== undefined && decoded.tool === 'shell');
  assert.equal(decoded.command, 'ls -la');
  assert.equal(decoded.workingDirectory, '/tmp/work');
  assert.equal(decoded.description, 'List files');
  assert.equal(decoded.resultCase, 'success');
  assert.equal(decoded.exitCode, 0);
  assert.equal(decoded.stdout, 'total 0');
});

test('shell_tool_call：错误态写 failure（oneof 2）并带 exit_code/stderr', () => {
  const base64 = encodeShellToolCallBinary({
    command: 'false',
    outcome: { ok: false, output: '', exitCode: 1, stderr: 'command failed' },
  });
  const decoded = decodeToolCallBinary(base64);
  assert.ok(decoded !== undefined && decoded.tool === 'shell');
  assert.equal(decoded.resultCase, 'failure');
  assert.equal(decoded.exitCode, 1);
  assert.equal(decoded.stderr, 'command failed');
});

test('read_tool_call（字段 8）：path/offset/limit/行数往返，content 留空', () => {
  const base64 = encodeReadToolCallBinary({
    path: '/tmp/work/a.ts',
    offset: 450,
    limit: 150,
    outcome: { ok: true, totalLines: 845, fileSize: 35257 },
  });
  // read_tool_call = field 8 → 0x42
  assert.equal(firstByte(base64), 0x42);
  const decoded = decodeToolCallBinary(base64);
  assert.ok(decoded !== undefined && decoded.tool === 'read');
  assert.equal(decoded.path, '/tmp/work/a.ts');
  assert.equal(decoded.offset, 450);
  assert.equal(decoded.limit, 150);
  assert.equal(decoded.totalLines, 845);
  assert.equal(decoded.fileSize, 35257);
  assert.equal(decoded.resultCase, 'success');
  // 与原生一致：不把文件正文塞进 binary（app 落库前也会清空）
  assert.equal(decoded.outputCase, 'content');
  assert.ok(!Buffer.from(base64, 'base64').includes(Buffer.from('line1')));
});

test('read_tool_call：错误态走 ReadToolResult.error', () => {
  const decoded = decodeToolCallBinary(
    encodeReadToolCallBinary({ path: '/tmp/work/missing.ts', outcome: { ok: false, errorMessage: 'ENOENT' } }),
  );
  assert.ok(decoded !== undefined && decoded.tool === 'read');
  assert.equal(decoded.resultCase, 'error');
  assert.equal(decoded.errorMessage, 'ENOENT');
});

test('grep_tool_call（字段 5）：pattern/path/outputMode + 每文件命中数', () => {
  const base64 = encodeGrepToolCallBinary({
    pattern: 'foo',
    path: '/tmp/work',
    outputMode: 'content',
    caseInsensitive: true,
    fileCounts: [
      { file: 'a.ts', count: 2 },
      { file: 'b.ts', count: 1 },
    ],
    totalFiles: 2,
    totalMatches: 3,
  });
  // grep_tool_call = field 5 → 0x2a
  assert.equal(firstByte(base64), 0x2a);
  const decoded = decodeToolCallBinary(base64);
  assert.ok(decoded !== undefined && decoded.tool === 'grep');
  assert.equal(decoded.pattern, 'foo');
  assert.equal(decoded.path, '/tmp/work');
  assert.equal(decoded.outputMode, 'content');
  assert.equal(decoded.totalFiles, 2);
  assert.equal(decoded.totalMatches, 3);
  assert.deepEqual(decoded.fileCounts, [
    { file: 'a.ts', count: 2 },
    { file: 'b.ts', count: 1 },
  ]);
});

test('grep_tool_call：错误态不写 workspace_results', () => {
  const decoded = decodeToolCallBinary(
    encodeGrepToolCallBinary({ pattern: '[', errorMessage: 'regex parse error' }),
  );
  assert.ok(decoded !== undefined && decoded.tool === 'grep');
  assert.equal(decoded.resultCase, 'error');
  assert.equal(decoded.fileCounts, undefined);
});

test('glob_tool_call（字段 4）：targetDirectory/pattern/文件列表 + 截断标记', () => {
  const base64 = encodeGlobToolCallBinary({
    pattern: '**/*.ts',
    targetDirectory: '/tmp/work',
    files: ['a.ts', 'src/b.ts'],
    totalFiles: 2,
    clientTruncated: true,
  });
  // glob_tool_call = field 4 → 0x22
  assert.equal(firstByte(base64), 0x22);
  const decoded = decodeToolCallBinary(base64);
  assert.ok(decoded !== undefined && decoded.tool === 'glob');
  assert.equal(decoded.pattern, '**/*.ts');
  assert.equal(decoded.targetDirectory, '/tmp/work');
  assert.deepEqual(decoded.files, ['a.ts', 'src/b.ts']);
  assert.equal(decoded.totalFiles, 2);
  assert.equal(decoded.clientTruncated, true);
});

test('ls_tool_call（字段 13）：目录树往返', () => {
  const base64 = encodeLsToolCallBinary({
    path: '/tmp/work',
    root: {
      absPath: '/tmp/work',
      files: ['a.ts'],
      dirs: [{ absPath: '/tmp/work/src', files: ['b.ts'] }],
    },
  });
  // ls_tool_call = field 13 → 0x6a
  assert.equal(firstByte(base64), 0x6a);
  const decoded = decodeToolCallBinary(base64);
  assert.ok(decoded !== undefined && decoded.tool === 'ls');
  assert.equal(decoded.path, '/tmp/work');
  assert.equal(decoded.rootPath, '/tmp/work');
  assert.equal(decoded.fileCount, 2);
  assert.equal(decoded.dirCount, 1);
});

test('delete_tool_call（字段 3）：success / fileNotFound 往返', () => {
  const ok = encodeDeleteToolCallBinary({ path: 'a.ts', outcome: { ok: true } });
  // delete_tool_call = field 3 → 0x1a
  assert.equal(firstByte(ok), 0x1a);
  const decodedOk = decodeToolCallBinary(ok);
  assert.ok(decodedOk !== undefined && decodedOk.tool === 'delete');
  assert.equal(decodedOk.path, 'a.ts');
  assert.equal(decodedOk.resultCase, 'success');

  const missing = decodeToolCallBinary(
    encodeDeleteToolCallBinary({ path: 'b.ts', outcome: { ok: false, notFound: true } }),
  );
  assert.ok(missing !== undefined && missing.tool === 'delete');
  assert.equal(missing.resultCase, 'fileNotFound');
  assert.equal(missing.path, 'b.ts');
});

test('encodeToolCallBinary 按 kind 分派，与单工具编码器逐字节一致', () => {
  const shell = { command: 'ls' };
  assert.equal(encodeToolCallBinary({ kind: 'shell', ...shell }), encodeShellToolCallBinary(shell));
  assert.equal(
    encodeToolCallBinary({ kind: 'read', path: 'a.ts' }),
    encodeReadToolCallBinary({ path: 'a.ts' }),
  );
  assert.equal(
    encodeToolCallBinary({ kind: 'grep', pattern: 'foo' }),
    encodeGrepToolCallBinary({ pattern: 'foo' }),
  );
  assert.equal(
    encodeToolCallBinary({ kind: 'glob', pattern: '**/*.ts', targetDirectory: '.' }),
    encodeGlobToolCallBinary({ pattern: '**/*.ts', targetDirectory: '.' }),
  );
  assert.equal(
    encodeToolCallBinary({ kind: 'ls', path: '.' }),
    encodeLsToolCallBinary({ path: '.' }),
  );
  assert.equal(
    encodeToolCallBinary({ kind: 'delete', path: 'a.ts' }),
    encodeDeleteToolCallBinary({ path: 'a.ts' }),
  );
  assert.equal(
    encodeToolCallBinary({ kind: 'edit', path: 'a.ts', linesAdded: 1, linesRemoved: 0, diffText: 'x' }),
    encodeEditToolCallBinary({ path: 'a.ts', linesAdded: 1, linesRemoved: 0, diffText: 'x' }),
  );
});

test('ToolCall oneof 字段号与 schema 一致', () => {
  assert.deepEqual(TOOL_CALL_FIELD, { shell: 1, delete: 3, glob: 4, grep: 5, read: 8, edit: 12, ls: 13 });
  assert.equal(toolCallFieldForKind('shell'), 1);
  assert.equal(toolCallFieldForKind('read'), 8);
  assert.equal(toolCallKindForField(3), 'delete');
  assert.equal(toolCallKindForField(12), 'edit');
  assert.equal(toolCallKindForField(13), 'ls');
  // 不在表里的分支（todos=9 / read_lints=14）不认
  assert.equal(toolCallKindForField(9), undefined);
  assert.equal(toolCallKindForField(14), undefined);
});

test('decodeToolCallBinary / decodeEditToolCallBinary 拒绝非本工具调用与非法 base64', () => {
  // ToolCall.shell_tool_call 是 field 1；这里放一个只有 field 1 的 message
  const shell = Buffer.from([0x0a, 0x02, 0x08, 0x01]).toString('base64');
  assert.equal(decodeEditToolCallBinary(shell), undefined);
  assert.equal(decodeToolCallBinary(shell)?.tool, 'shell');

  // todos 分支（field 9）不是本 adapter 写的，解码器不认
  const todos = Buffer.from([0x4a, 0x02, 0x08, 0x01]).toString('base64');
  assert.equal(decodeToolCallBinary(todos), undefined);

  assert.equal(decodeEditToolCallBinary('not base64 !!!'), undefined);
  assert.equal(decodeToolCallBinary('not base64 !!!'), undefined);
  assert.equal(decodeToolCallBinary(''), undefined);
});
