/**
 * Cursor 的 `toolFormerData.toolCallBinary` = base64(agent.v1.ToolCall)。
 *
 * 真实 Cursor 气泡里这个字段永远存在；app 读 DB 时用 `ToolCall.fromBinary` 解它，
 * 之后工具卡片（shell/read/grep/glob/ls/delete/edit）都由解码出的 `toolCall`
 * 驱动。缺这个字段时 Cursor 只能退化成纯文本摘要（"Edited README.md" / "Ran tool"）。
 *
 * `agent.v1.ToolCall` 是 oneof，本文件按 Cursor 3.25.9 bundle 里的 protobuf schema
 * 生成各工具的最小但结构合法的子消息（字段号/类型见 research/cursor-toolformer.md §3.1）：
 *
 *   field 1  shell_tool_call   ShellToolCall  { args: ShellArgs,   result: ShellResult, description }
 *   field 3  delete_tool_call  DeleteToolCall { args: DeleteArgs,  result: DeleteResult }
 *   field 4  glob_tool_call    GlobToolCall   { args: GlobToolArgs,result: GlobToolResult }
 *   field 5  grep_tool_call    GrepToolCall   { args: GrepArgs,    result: GrepResult }
 *   field 8  read_tool_call    ReadToolCall   { args: ReadToolArgs,result: ReadToolResult }
 *   field 12 edit_tool_call    EditToolCall   { args: EditArgs,    result: EditResult }
 *   field 13 ls_tool_call      LsToolCall     { args: LsArgs,      result: LsResult }
 *
 * 写的是「结构」而不是全文：不塞 before/after 文件全文，也不塞 read 的文件内容
 * （真实 Cursor 落库前同样会把 ReadToolSuccess.content 清空、把 EditSuccess 的
 * before/after 全文清掉，只留 path/行数/diff 这类 UI 真正读的字段）。没有的字段
 * 直接省略，让 protobuf 用默认值。
 */

/** agent.v1.ToolCall 的 oneof 字段号（Cursor 3.25.9 bundle） */
export const TOOL_CALL_FIELD = {
  shell: 1,
  delete: 3,
  glob: 4,
  grep: 5,
  read: 8,
  edit: 12,
  ls: 13,
} as const;

export type ToolCallBinaryKind = keyof typeof TOOL_CALL_FIELD;

const KIND_BY_FIELD = new Map<number, ToolCallBinaryKind>();
for (const [kind, field] of Object.entries(TOOL_CALL_FIELD)) {
  KIND_BY_FIELD.set(field, kind as ToolCallBinaryKind);
}

/** toolCallBinary 里 oneof 分支对应的工具种类（字段号 → kind） */
export function toolCallKindForField(field: number): ToolCallBinaryKind | undefined {
  return KIND_BY_FIELD.get(field);
}

export function toolCallFieldForKind(kind: ToolCallBinaryKind): number {
  return TOOL_CALL_FIELD[kind];
}

// ---------------------------------------------------------------------------
// protobuf 原语
// ---------------------------------------------------------------------------

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

/** bool 默认 false，只写 true（protobuf 的默认值省略语义） */
function trueField(field: number): number[] {
  return [...tag(field, 0), 1];
}

function optionalString(field: number, value: string | undefined): number[] {
  return value === undefined || value.length === 0 ? [] : stringField(field, value);
}

function optionalNumber(field: number, value: number | undefined): number[] {
  return value === undefined || !Number.isFinite(value) ? [] : numberField(field, Math.max(0, Math.round(value)));
}

// ---------------------------------------------------------------------------
// 写：各工具的最小 ToolCall
// ---------------------------------------------------------------------------

export interface ShellToolOutcome {
  /** true → ShellResult.success；false → ShellResult.failure（非零退出/错误） */
  ok: boolean;
  /** 合并后的输出（IR 的 tool_result 文本） */
  output?: string;
  exitCode?: number;
  /** 单独的错误文本（错误态时写进 stderr） */
  stderr?: string;
}

export interface ShellToolBinaryInput {
  command: string;
  workingDirectory?: string;
  /** 模型给的人类可读描述（ShellToolCall.description / ShellArgs.description） */
  description?: string;
  timeoutMs?: number;
  isBackground?: boolean;
  outcome?: ShellToolOutcome;
}

export interface ReadToolOutcome {
  ok: boolean;
  /** 文件真实总行数（只有工具结果明确给出时才写） */
  totalLines?: number;
  /** 文件真实字节数（只有工具结果明确给出时才写） */
  fileSize?: number;
  errorMessage?: string;
}

export interface ReadToolBinaryInput {
  path: string;
  offset?: number;
  limit?: number;
  includeLineNumbers?: boolean;
  outcome?: ReadToolOutcome;
}

export interface GrepFileCountInput {
  file: string;
  count: number;
}

export interface GrepToolBinaryInput {
  pattern: string;
  path?: string;
  glob?: string;
  outputMode?: string;
  caseInsensitive?: boolean;
  headLimit?: number;
  multiline?: boolean;
  /** 每个文件的命中数（真实计数；不含命中行正文） */
  fileCounts?: GrepFileCountInput[];
  totalFiles?: number;
  totalMatches?: number;
  errorMessage?: string;
}

export interface GlobToolBinaryInput {
  pattern: string;
  targetDirectory: string;
  /** 仓库相对路径列表 */
  files?: string[];
  totalFiles?: number;
  /** 是否因为写入上限被截断（GlobToolSuccess.client_truncated） */
  clientTruncated?: boolean;
  /** 错误态（GlobToolResult.error） */
  errorMessage?: string;
}

export interface LsTreeNodeInput {
  absPath: string;
  files?: string[];
  dirs?: LsTreeNodeInput[];
}

export interface LsToolBinaryInput {
  path: string;
  ignore?: string[];
  root?: LsTreeNodeInput;
  /** 错误态（LsResult.error） */
  errorMessage?: string;
}

export interface DeleteToolBinaryInput {
  path: string;
  outcome?: {
    ok: boolean;
    /** 文件本来就不存在（DeleteFileNotFound） */
    notFound?: boolean;
    errorMessage?: string;
  };
}

export interface EditToolBinaryInput {
  /** 仓库相对路径（Cursor 的 relativeWorkspacePath） */
  path: string;
  linesAdded: number;
  linesRemoved: number;
  /** 统一 diff 文本；Cursor 的 EditSuccess.diff_string */
  diffText: string;
}

export type ToolCallBinaryInput =
  | ({ kind: 'shell' } & ShellToolBinaryInput)
  | ({ kind: 'read' } & ReadToolBinaryInput)
  | ({ kind: 'grep' } & GrepToolBinaryInput)
  | ({ kind: 'glob' } & GlobToolBinaryInput)
  | ({ kind: 'ls' } & LsToolBinaryInput)
  | ({ kind: 'delete' } & DeleteToolBinaryInput)
  | ({ kind: 'edit' } & EditToolBinaryInput);

/** 生成 base64(agent.v1.ToolCall{shell_tool_call}) */
export function encodeShellToolCallBinary(input: ShellToolBinaryInput): string {
  const args: number[] = [
    ...stringField(1, input.command),
    ...optionalString(2, input.workingDirectory),
    ...optionalNumber(3, input.timeoutMs),
    ...(input.isBackground === true ? trueField(11) : []),
    ...optionalString(15, input.description),
  ];
  const toolCall: number[] = [...lengthDelimited(1, args)];
  if (input.outcome !== undefined) {
    const shellResult = shellOutcomeFields(input, input.outcome);
    toolCall.push(...lengthDelimited(2, shellResult));
  }
  // ShellToolCall.description（field 3）与 ShellArgs.description 同值
  const withDescription =
    input.description === undefined || input.description.length === 0
      ? toolCall
      : [...toolCall, ...stringField(3, input.description)];
  return base64(lengthDelimited(TOOL_CALL_FIELD.shell, withDescription));
}

function shellOutcomeFields(input: ShellToolBinaryInput, outcome: ShellToolOutcome): number[] {
  const fields: number[] = [
    ...stringField(1, input.command),
    ...optionalString(2, input.workingDirectory),
    ...numberField(3, Math.max(0, Math.round(outcome.exitCode ?? (outcome.ok ? 0 : 1)))),
    ...optionalString(5, outcome.output),
    ...optionalString(6, outcome.stderr),
  ];
  // ShellResult 是 oneof：success=1 / failure=2
  return lengthDelimited(outcome.ok ? 1 : 2, fields);
}

/** 生成 base64(agent.v1.ToolCall{read_tool_call}) */
export function encodeReadToolCallBinary(input: ReadToolBinaryInput): string {
  const args: number[] = [
    ...stringField(1, input.path),
    ...optionalNumber(2, input.offset),
    ...optionalNumber(3, input.limit),
    ...(input.includeLineNumbers === true ? trueField(5) : []),
  ];
  const toolCall: number[] = [...lengthDelimited(1, args)];
  const outcome = input.outcome;
  if (outcome !== undefined) {
    if (outcome.ok) {
      // 与原生一致：content 留空（app 落库前也会清掉），只带行数/字节数/路径。
      const success: number[] = [
        ...stringField(1, ''),
        ...optionalNumber(4, outcome.totalLines),
        ...optionalNumber(5, outcome.fileSize),
        ...stringField(7, input.path),
      ];
      toolCall.push(...lengthDelimited(2, lengthDelimited(1, success)));
    } else {
      const error: number[] = [...optionalString(1, outcome.errorMessage)];
      toolCall.push(...lengthDelimited(2, lengthDelimited(2, error)));
    }
  }
  return base64(lengthDelimited(TOOL_CALL_FIELD.read, toolCall));
}

/** 生成 base64(agent.v1.ToolCall{grep_tool_call}) */
export function encodeGrepToolCallBinary(input: GrepToolBinaryInput): string {
  const args: number[] = [
    ...stringField(1, input.pattern),
    ...optionalString(2, input.path),
    ...optionalString(3, input.glob),
    ...optionalString(4, input.outputMode),
    ...(input.caseInsensitive === true ? trueField(8) : []),
    ...optionalNumber(10, input.headLimit),
    ...(input.multiline === true ? trueField(11) : []),
  ];
  const toolCall: number[] = [...lengthDelimited(1, args)];
  if (input.errorMessage !== undefined && input.errorMessage.length > 0) {
    toolCall.push(...lengthDelimited(2, lengthDelimited(2, [...stringField(1, input.errorMessage)])));
  } else {
    const success: number[] = [
      ...stringField(1, input.pattern),
      ...optionalString(2, input.path),
      ...optionalString(3, input.outputMode),
    ];
    // workspace_results：key = 搜索根目录（绝对路径才写，否则 "."），value = GrepUnionResult.count
    if (input.fileCounts !== undefined && input.fileCounts.length > 0) {
      const counts = input.fileCounts.map((item) => lengthDelimited(1, [
        ...stringField(1, item.file),
        ...numberField(2, Math.max(0, Math.round(item.count))),
      ]));
      const countResult = [
        ...counts.flat(),
        ...numberField(2, Math.max(0, input.totalFiles ?? input.fileCounts.length)),
        ...numberField(3, Math.max(0, input.totalMatches ?? input.fileCounts.reduce((sum, item) => sum + item.count, 0))),
      ];
      const union = lengthDelimited(1, countResult); // GrepUnionResult.count
      const root = input.path !== undefined && input.path.startsWith('/') ? input.path : '.';
      const entry = [...stringField(1, root), ...lengthDelimited(2, union)];
      success.push(...lengthDelimited(4, entry));
    }
    toolCall.push(...lengthDelimited(2, lengthDelimited(1, success)));
  }
  return base64(lengthDelimited(TOOL_CALL_FIELD.grep, toolCall));
}

/** 生成 base64(agent.v1.ToolCall{glob_tool_call}) */
export function encodeGlobToolCallBinary(input: GlobToolBinaryInput): string {
  const args: number[] = [
    ...stringField(1, input.targetDirectory),
    ...stringField(2, input.pattern),
  ];
  const toolCall: number[] = [...lengthDelimited(1, args)];
  if (input.errorMessage !== undefined && input.errorMessage.length > 0) {
    toolCall.push(...lengthDelimited(2, lengthDelimited(2, stringField(1, input.errorMessage))));
  } else {
    const files = input.files ?? [];
    const success: number[] = [
      ...stringField(1, input.pattern),
      ...stringField(2, input.targetDirectory),
      ...files.flatMap((file) => stringField(3, file)),
      ...numberField(4, Math.max(0, input.totalFiles ?? files.length)),
      ...(input.clientTruncated === true ? trueField(5) : []),
    ];
    toolCall.push(...lengthDelimited(2, lengthDelimited(1, success)));
  }
  return base64(lengthDelimited(TOOL_CALL_FIELD.glob, toolCall));
}

/** 生成 base64(agent.v1.ToolCall{ls_tool_call}) */
export function encodeLsToolCallBinary(input: LsToolBinaryInput): string {
  const args: number[] = [
    ...stringField(1, input.path),
    ...(input.ignore ?? []).flatMap((pattern) => stringField(2, pattern)),
  ];
  const toolCall: number[] = [...lengthDelimited(1, args)];
  if (input.errorMessage !== undefined && input.errorMessage.length > 0) {
    const error = [...stringField(1, input.path), ...stringField(2, input.errorMessage)];
    toolCall.push(...lengthDelimited(2, lengthDelimited(2, error)));
  } else if (input.root !== undefined) {
    const success = lengthDelimited(1, encodeLsTreeNode(input.root));
    toolCall.push(...lengthDelimited(2, lengthDelimited(1, success)));
  }
  return base64(lengthDelimited(TOOL_CALL_FIELD.ls, toolCall));
}

function encodeLsTreeNode(node: LsTreeNodeInput): number[] {
  return [
    ...stringField(1, node.absPath),
    ...(node.dirs ?? []).flatMap((dir) => lengthDelimited(2, encodeLsTreeNode(dir))),
    ...(node.files ?? []).flatMap((name) => lengthDelimited(3, [...stringField(1, name)])),
  ];
}

/** 生成 base64(agent.v1.ToolCall{delete_tool_call}) */
export function encodeDeleteToolCallBinary(input: DeleteToolBinaryInput): string {
  const args = stringField(1, input.path);
  const toolCall: number[] = [...lengthDelimited(1, args)];
  const outcome = input.outcome;
  if (outcome !== undefined) {
    if (outcome.ok) {
      const success = [...stringField(1, input.path), ...stringField(2, input.path)];
      toolCall.push(...lengthDelimited(2, lengthDelimited(1, success)));
    } else if (outcome.notFound === true) {
      toolCall.push(...lengthDelimited(2, lengthDelimited(2, stringField(1, input.path))));
    } else {
      const error = [
        ...stringField(1, input.path),
        ...stringField(2, outcome.errorMessage !== undefined && outcome.errorMessage.length > 0 ? outcome.errorMessage : 'Failed to delete file'),
      ];
      toolCall.push(...lengthDelimited(2, lengthDelimited(7, error)));
    }
  }
  return base64(lengthDelimited(TOOL_CALL_FIELD.delete, toolCall));
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
  return base64(lengthDelimited(TOOL_CALL_FIELD.edit, editToolCall));
}

/** 按 kind 分派；toolformer 只调这个 */
export function encodeToolCallBinary(input: ToolCallBinaryInput): string {
  switch (input.kind) {
    case 'shell':
      return encodeShellToolCallBinary(input);
    case 'read':
      return encodeReadToolCallBinary(input);
    case 'grep':
      return encodeGrepToolCallBinary(input);
    case 'glob':
      return encodeGlobToolCallBinary(input);
    case 'ls':
      return encodeLsToolCallBinary(input);
    case 'delete':
      return encodeDeleteToolCallBinary(input);
    case 'edit':
      return encodeEditToolCallBinary(input);
  }
}

function base64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// 读：解码（测试 / verify 用）
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
      if (index + length.value > data.length) throw new Error('truncated length-delimited field');
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

function allBytes(fields: WireField[], field: number): number[][] {
  return fields.filter((item) => item.field === field && item.wire === 2).map((item) => item.bytes as number[]);
}

function firstNumber(fields: WireField[], field: number): number | undefined {
  return fields.find((item) => item.field === field && item.wire === 0)?.number;
}

function textOfBytes(bytes: number[] | undefined): string | undefined {
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
}

function text(fields: WireField[], field: number): string | undefined {
  return textOfBytes(firstBytes(fields, field));
}

/** 某个 oneof 分支的 case 名（字段号映射） */
const SHELL_RESULT_CASES: Record<number, string> = {
  1: 'success',
  2: 'failure',
  3: 'timeout',
  4: 'rejected',
  5: 'spawnError',
  7: 'permissionDenied',
};
const DELETE_RESULT_CASES: Record<number, string> = {
  1: 'success',
  2: 'fileNotFound',
  3: 'notFile',
  4: 'permissionDenied',
  5: 'fileBusy',
  6: 'rejected',
  7: 'error',
};
const GENERIC_RESULT_CASES: Record<number, string> = { 1: 'success', 2: 'error', 3: 'rejected', 4: 'timeout' };

function oneofCase(fields: WireField[], cases: Record<number, string>): string | undefined {
  const first = fields[0];
  return first === undefined ? undefined : cases[first.field];
}

function oneofBytes(fields: WireField[]): number[] | undefined {
  const first = fields[0];
  return first === undefined ? undefined : first.bytes;
}

export interface DecodedShellToolCall {
  tool: 'shell';
  command?: string;
  workingDirectory?: string;
  description?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  resultCase?: string;
}

export interface DecodedReadToolCall {
  tool: 'read';
  path?: string;
  offset?: number;
  limit?: number;
  totalLines?: number;
  fileSize?: number;
  /** success.output 的 case：content / data / dataBlobId / contentBlobId / undefined */
  outputCase?: string;
  resultCase?: string;
  errorMessage?: string;
}

export interface DecodedGrepToolCall {
  tool: 'grep';
  pattern?: string;
  path?: string;
  outputMode?: string;
  totalFiles?: number;
  totalMatches?: number;
  fileCounts?: GrepFileCountInput[];
  resultCase?: string;
}

export interface DecodedGlobToolCall {
  tool: 'glob';
  pattern?: string;
  targetDirectory?: string;
  files?: string[];
  totalFiles?: number;
  clientTruncated?: boolean;
  resultCase?: string;
  errorMessage?: string;
}

export interface DecodedLsToolCall {
  tool: 'ls';
  path?: string;
  rootPath?: string;
  fileCount?: number;
  dirCount?: number;
  resultCase?: string;
  errorMessage?: string;
}

export interface DecodedDeleteToolCall {
  tool: 'delete';
  path?: string;
  resultCase?: string;
}

export interface DecodedEditToolCall {
  path?: string;
  linesAdded?: number;
  linesRemoved?: number;
  diffString?: string;
}

export interface DecodedEditToolCallBinary extends DecodedEditToolCall {
  tool: 'edit';
}

export type DecodedToolCallBinary =
  | DecodedShellToolCall
  | DecodedReadToolCall
  | DecodedGrepToolCall
  | DecodedGlobToolCall
  | DecodedLsToolCall
  | DecodedDeleteToolCall
  | DecodedEditToolCallBinary;

function decodeShell(fields: number[]): DecodedShellToolCall {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const decoded: DecodedShellToolCall = { tool: 'shell' };
  const command = text(args, 1);
  if (command !== undefined) decoded.command = command;
  const workingDirectory = text(args, 2);
  if (workingDirectory !== undefined) decoded.workingDirectory = workingDirectory;
  const description = text(body, 3) ?? text(args, 15);
  if (description !== undefined) decoded.description = description;
  const resultFields = parseFields(firstBytes(body, 2) ?? []);
  const resultCase = oneofCase(resultFields, SHELL_RESULT_CASES);
  if (resultCase !== undefined) decoded.resultCase = resultCase;
  const resultBody = oneofBytes(resultFields);
  if (resultBody !== undefined) {
    const outcome = parseFields(resultBody);
    const exitCode = firstNumber(outcome, 3);
    if (exitCode !== undefined) decoded.exitCode = exitCode;
    const stdout = text(outcome, 5);
    if (stdout !== undefined) decoded.stdout = stdout;
    const stderr = text(outcome, 6);
    if (stderr !== undefined) decoded.stderr = stderr;
  }
  return decoded;
}

function decodeRead(fields: number[]): DecodedReadToolCall {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const decoded: DecodedReadToolCall = { tool: 'read' };
  const path = text(args, 1);
  if (path !== undefined) decoded.path = path;
  const offset = firstNumber(args, 2);
  if (offset !== undefined) decoded.offset = offset;
  const limit = firstNumber(args, 3);
  if (limit !== undefined) decoded.limit = limit;
  const resultFields = parseFields(firstBytes(body, 2) ?? []);
  const resultCase = oneofCase(resultFields, GENERIC_RESULT_CASES);
  if (resultCase !== undefined) decoded.resultCase = resultCase;
  const resultBody = oneofBytes(resultFields);
  if (resultBody !== undefined) {
    const inner = parseFields(resultBody);
    if (resultCase === 'success') {
      const output = inner.find((item) => item.wire === 2 && (item.field === 1 || item.field === 6 || item.field === 9 || item.field === 10));
      decoded.outputCase = output === undefined ? undefined : { 1: 'content', 6: 'data', 9: 'dataBlobId', 10: 'contentBlobId' }[output.field];
      const totalLines = firstNumber(inner, 4);
      if (totalLines !== undefined) decoded.totalLines = totalLines;
      const fileSize = firstNumber(inner, 5);
      if (fileSize !== undefined) decoded.fileSize = fileSize;
      const resultPath = text(inner, 7);
      if (resultPath !== undefined) decoded.path = resultPath;
    } else {
      const message = text(inner, 1);
      if (message !== undefined) decoded.errorMessage = message;
    }
  }
  return decoded;
}

function decodeGrep(fields: number[]): DecodedGrepToolCall {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const decoded: DecodedGrepToolCall = { tool: 'grep' };
  const pattern = text(args, 1);
  if (pattern !== undefined) decoded.pattern = pattern;
  const path = text(args, 2);
  if (path !== undefined) decoded.path = path;
  const outputMode = text(args, 4);
  if (outputMode !== undefined) decoded.outputMode = outputMode;
  const resultFields = parseFields(firstBytes(body, 2) ?? []);
  const resultCase = oneofCase(resultFields, GENERIC_RESULT_CASES);
  if (resultCase !== undefined) decoded.resultCase = resultCase;
  const resultBody = oneofBytes(resultFields);
  if (resultBody !== undefined && resultCase === 'success') {
    const success = parseFields(resultBody);
    const successPattern = text(success, 1);
    if (successPattern !== undefined) decoded.pattern = successPattern;
    const successPath = text(success, 2);
    if (successPath !== undefined) decoded.path = successPath;
    const successMode = text(success, 3);
    if (successMode !== undefined) decoded.outputMode = successMode;
    const counts: GrepFileCountInput[] = [];
    for (const entryBytes of allBytes(success, 4)) {
      const entry = parseFields(entryBytes);
      const value = firstBytes(entry, 2);
      if (value === undefined) continue;
      const union = parseFields(value);
      const countBytes = firstBytes(union, 1);
      if (countBytes === undefined) continue;
      const countResult = parseFields(countBytes);
      for (const countEntry of allBytes(countResult, 1)) {
        const item = parseFields(countEntry);
        const file = text(item, 1);
        const count = firstNumber(item, 2);
        if (file !== undefined && count !== undefined) counts.push({ file, count });
      }
      const totalFiles = firstNumber(countResult, 2);
      const totalMatches = firstNumber(countResult, 3);
      if (totalFiles !== undefined) decoded.totalFiles = totalFiles;
      if (totalMatches !== undefined) decoded.totalMatches = totalMatches;
    }
    if (counts.length > 0) decoded.fileCounts = counts;
  }
  return decoded;
}

function decodeGlob(fields: number[]): DecodedGlobToolCall {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const decoded: DecodedGlobToolCall = { tool: 'glob' };
  const targetDirectory = text(args, 1);
  if (targetDirectory !== undefined) decoded.targetDirectory = targetDirectory;
  const globPattern = text(args, 2);
  if (globPattern !== undefined) decoded.pattern = globPattern;
  const resultFields = parseFields(firstBytes(body, 2) ?? []);
  const resultCase = oneofCase(resultFields, GENERIC_RESULT_CASES);
  if (resultCase !== undefined) decoded.resultCase = resultCase;
  const resultBody = oneofBytes(resultFields);
  if (resultBody !== undefined && resultCase === 'error') {
    const message = text(parseFields(resultBody), 1);
    if (message !== undefined) decoded.errorMessage = message;
  }
  if (resultBody !== undefined && resultCase === 'success') {
    const success = parseFields(resultBody);
    const successPattern = text(success, 1);
    if (successPattern !== undefined) decoded.pattern = successPattern;
    const successPath = text(success, 2);
    if (successPath !== undefined) decoded.targetDirectory = successPath;
    const files = allBytes(success, 3).map((item) => Buffer.from(item).toString('utf8'));
    decoded.files = files;
    const totalFiles = firstNumber(success, 4);
    if (totalFiles !== undefined) decoded.totalFiles = totalFiles;
    decoded.clientTruncated = firstNumber(success, 5) === 1;
  }
  return decoded;
}

interface LsNodeCount {
  files: number;
  dirs: number;
  rootPath?: string;
}

function countLsNode(bytes: number[], acc: LsNodeCount): void {
  const node = parseFields(bytes);
  const absPath = text(node, 1);
  if (acc.rootPath === undefined && absPath !== undefined) acc.rootPath = absPath;
  for (const child of allBytes(node, 2)) {
    acc.dirs += 1;
    countLsNode(child, acc);
  }
  acc.files += allBytes(node, 3).length;
}

function decodeLs(fields: number[]): DecodedLsToolCall {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const decoded: DecodedLsToolCall = { tool: 'ls' };
  const path = text(args, 1);
  if (path !== undefined) decoded.path = path;
  const resultFields = parseFields(firstBytes(body, 2) ?? []);
  const resultCase = oneofCase(resultFields, GENERIC_RESULT_CASES);
  if (resultCase !== undefined) decoded.resultCase = resultCase;
  const resultBody = oneofBytes(resultFields);
  if (resultBody !== undefined && resultCase === 'error') {
    const message = text(parseFields(resultBody), 2);
    if (message !== undefined) decoded.errorMessage = message;
  }
  if (resultBody !== undefined && (resultCase === 'success' || resultCase === 'timeout')) {
    const inner = parseFields(resultBody);
    const root = firstBytes(inner, 1);
    if (root !== undefined) {
      const acc: LsNodeCount = { files: 0, dirs: 0 };
      countLsNode(root, acc);
      decoded.fileCount = acc.files;
      decoded.dirCount = acc.dirs;
      if (acc.rootPath !== undefined) decoded.rootPath = acc.rootPath;
    }
  }
  return decoded;
}

function decodeDelete(fields: number[]): DecodedDeleteToolCall {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const decoded: DecodedDeleteToolCall = { tool: 'delete' };
  const path = text(args, 1);
  if (path !== undefined) decoded.path = path;
  const resultFields = parseFields(firstBytes(body, 2) ?? []);
  const resultCase = oneofCase(resultFields, DELETE_RESULT_CASES);
  if (resultCase !== undefined) decoded.resultCase = resultCase;
  const resultBody = oneofBytes(resultFields);
  if (resultBody !== undefined) {
    const inner = parseFields(resultBody);
    const resultPath = text(inner, 1);
    if (resultPath !== undefined) decoded.path = resultPath;
  }
  return decoded;
}

function decodeEdit(fields: number[]): DecodedEditToolCallBinary {
  const body = parseFields(fields);
  const args = parseFields(firstBytes(body, 1) ?? []);
  const result = parseFields(firstBytes(body, 2) ?? []);
  const success = firstBytes(result, 1);
  const decoded: DecodedEditToolCallBinary = { tool: 'edit' };
  const argsPath = text(args, 1);
  if (argsPath !== undefined) decoded.path = argsPath;
  if (success !== undefined) {
    const successFields = parseFields(success);
    const successPath = text(successFields, 1);
    if (decoded.path === undefined && successPath !== undefined) decoded.path = successPath;
    const added = firstNumber(successFields, 3);
    const removed = firstNumber(successFields, 4);
    const diff = text(successFields, 5);
    if (added !== undefined) decoded.linesAdded = added;
    if (removed !== undefined) decoded.linesRemoved = removed;
    if (diff !== undefined) decoded.diffString = diff;
  }
  return decoded;
}

/** 解析 base64(agent.v1.ToolCall)；不是已知 oneof 分支或解析失败时返回 undefined */
export function decodeToolCallBinary(base64Text: string): DecodedToolCallBinary | undefined {
  try {
    const toolCall = parseFields(Array.from(Buffer.from(base64Text, 'base64')));
    for (const item of toolCall) {
      if (item.wire !== 2 || item.bytes === undefined) continue;
      const kind = toolCallKindForField(item.field);
      if (kind === undefined) continue;
      const payload = Array.from(item.bytes);
      switch (kind) {
        case 'shell':
          return decodeShell(payload);
        case 'read':
          return decodeRead(payload);
        case 'grep':
          return decodeGrep(payload);
        case 'glob':
          return decodeGlob(payload);
        case 'ls':
          return decodeLs(payload);
        case 'delete':
          return decodeDelete(payload);
        case 'edit':
          return decodeEdit(payload);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 解析 base64(agent.v1.ToolCall) 的 edit 分支；不是 edit 调用或解析失败时返回 undefined */
export function decodeEditToolCallBinary(base64Text: string): DecodedEditToolCall | undefined {
  const decoded = decodeToolCallBinary(base64Text);
  if (decoded === undefined || decoded.tool !== 'edit') return undefined;
  return {
    ...(decoded.path !== undefined ? { path: decoded.path } : {}),
    ...(decoded.linesAdded !== undefined ? { linesAdded: decoded.linesAdded } : {}),
    ...(decoded.linesRemoved !== undefined ? { linesRemoved: decoded.linesRemoved } : {}),
    ...(decoded.diffString !== undefined ? { diffString: decoded.diffString } : {}),
  };
}
