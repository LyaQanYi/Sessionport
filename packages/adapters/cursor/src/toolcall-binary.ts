/**
 * Cursor 的 `toolFormerData.toolCallBinary` = base64(agent.v1.ToolCall)。
 *
 * 真实 Cursor 气泡里这个字段永远存在；app 读 DB 时用 `ToolCall.fromBinary` 解它，
 * 之后编辑卡片、diff 渲染、文件跳转都依赖解码出来的 `toolCall`。缺这个字段时
 * Cursor 会退化成纯文本摘要（"Edited README.md"），不会出现可展开的 diff 卡片。
 *
 * 这里只实现写回需要的 edit 分支（ToolCall field 12）：
 *   ToolCall { edit_tool_call: EditToolCall { args: EditArgs { path }, result: EditResult { success: EditSuccess {
 *     path, lines_added, lines_removed, diff_string } } } }
 *
 * 字段号来自 Cursor 3.25.9 bundle 内的 protobuf schema（agent.v1.*）。
 */

export interface EditToolBinaryInput {
  /** 仓库相对路径（Cursor 的 relativeWorkspacePath） */
  path: string;
  linesAdded: number;
  linesRemoved: number;
  /** 统一 diff 文本；Cursor 的 EditSuccess.diff_string */
  diffText: string;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function lengthDelimited(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function stringField(field: number, text: string): number[] {
  return lengthDelimited(field, Array.from(Buffer.from(text, 'utf8')));
}

function numberField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

/** 生成 base64(agent.v1.ToolCall{edit_tool_call}) */
export function encodeEditToolCallBinary(input: EditToolBinaryInput): string {
  const success = [
    ...stringField(1, input.path),
    ...numberField(3, Math.max(0, input.linesAdded)),
    ...numberField(4, Math.max(0, input.linesRemoved)),
    ...stringField(5, input.diffText),
  ];
  const result = lengthDelimited(1, success); // EditResult.success
  const args = stringField(1, input.path); // EditArgs.path
  const editToolCall = [...lengthDelimited(1, args), ...lengthDelimited(2, result)];
  return Buffer.from(lengthDelimited(12, editToolCall)).toString('base64');
}

// ---------------------------------------------------------------------------
// 解码（测试 / verify 用；只支持 edit 分支）
// ---------------------------------------------------------------------------

interface WireField {
  field: number;
  wire: number;
  bytes?: number[];
  number?: number;
}

function readVarint(data: number[], offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    const byte = data[index];
    if (byte === undefined) throw new Error('truncated varint');
    value |= (byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  }
  return { value: value >>> 0, next: index };
}

function parseFields(data: number[]): WireField[] {
  const fields: WireField[] = [];
  let index = 0;
  while (index < data.length) {
    const header = readVarint(data, index);
    index = header.next;
    const field = header.value >>> 3;
    const wire = header.value & 0x07;
    if (wire === 0) {
      const { value, next } = readVarint(data, index);
      fields.push({ field, wire, number: value });
      index = next;
    } else if (wire === 2) {
      const length = readVarint(data, index);
      index = length.next;
      fields.push({ field, wire, bytes: data.slice(index, index + length.value) });
      index += length.value;
    } else if (wire === 5) {
      index += 4;
    } else if (wire === 1) {
      index += 8;
    } else {
      throw new Error('unsupported wire type ' + String(wire));
    }
  }
  return fields;
}

function firstBytes(fields: WireField[], field: number): number[] | undefined {
  return fields.find((item) => item.field === field && item.wire === 2)?.bytes;
}

function firstNumber(fields: WireField[], field: number): number | undefined {
  return fields.find((item) => item.field === field && item.wire === 0)?.number;
}

function textOfBytes(bytes: number[] | undefined): string | undefined {
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
}

export interface DecodedEditToolCall {
  path?: string;
  linesAdded?: number;
  linesRemoved?: number;
  diffString?: string;
}

/** 解析 base64(agent.v1.ToolCall) 的 edit 分支；不是 edit 调用或解析失败时返回 undefined */
export function decodeEditToolCallBinary(base64: string): DecodedEditToolCall | undefined {
  try {
    const toolCall = parseFields(Array.from(Buffer.from(base64, 'base64')));
    const editToolCall = firstBytes(toolCall, 12);
    if (editToolCall === undefined) return undefined;
    const editFields = parseFields(editToolCall);
    const args = parseFields(firstBytes(editFields, 1) ?? []);
    const result = parseFields(firstBytes(editFields, 2) ?? []);
    const success = firstBytes(result, 1);
    const decoded: DecodedEditToolCall = {};
    const argsPath = textOfBytes(firstBytes(args, 1));
    if (argsPath !== undefined) decoded.path = argsPath;
    if (success !== undefined) {
      const successFields = parseFields(success);
      const successPath = textOfBytes(firstBytes(successFields, 1));
      if (decoded.path === undefined && successPath !== undefined) decoded.path = successPath;
      const added = firstNumber(successFields, 3);
      const removed = firstNumber(successFields, 4);
      const diff = textOfBytes(firstBytes(successFields, 5));
      if (added !== undefined) decoded.linesAdded = added;
      if (removed !== undefined) decoded.linesRemoved = removed;
      if (diff !== undefined) decoded.diffString = diff;
    }
    return decoded;
  } catch {
    return undefined;
  }
}
