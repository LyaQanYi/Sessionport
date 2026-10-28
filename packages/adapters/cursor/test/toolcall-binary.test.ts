import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeEditToolCallBinary, encodeEditToolCallBinary } from '../src/toolcall-binary.ts';

const DIFF = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'].join('\n');

test('encodeEditToolCallBinary → decodeEditToolCallBinary 往返（edit_tool_call 字段 12）', () => {
  const base64 = encodeEditToolCallBinary({
    path: 'src/app.ts',
    linesAdded: 2,
    linesRemoved: 1,
    diffText: DIFF,
  });
  const raw = Buffer.from(base64, 'base64');
  // ToolCall.edit_tool_call 是 field 12 / wire type 2 → tag byte 0x62
  assert.equal(raw[0], 0x62);
  const decoded = decodeEditToolCallBinary(base64);
  assert.ok(decoded !== undefined);
  assert.equal(decoded.path, 'src/app.ts');
  assert.equal(decoded.linesAdded, 2);
  assert.equal(decoded.linesRemoved, 1);
  assert.equal(decoded.diffString, DIFF);
});

test('decodeEditToolCallBinary 拒绝非 edit 调用 / 非法 base64', () => {
  // ToolCall.shell_tool_call 是 field 1；这里放一个只有 field 1 的 message
  const shell = Buffer.from([0x0a, 0x02, 0x08, 0x01]).toString('base64');
  assert.equal(decodeEditToolCallBinary(shell), undefined);
  assert.equal(decodeEditToolCallBinary('not base64 !!!'), undefined);
});
