/**
 * toolFormerData：IR 的 tool_call / tool_result → Cursor 气泡里的工具调用数据。
 *
 * 重要事实（与任务描述里的“bubble 是 protobuf”不同，见 research/cursor-toolformer.md）：
 * - state.vscdb 里的 bubble value 是 **JSON**；toolFormerData 也是 JSON 对象。
 * - 只有 toolFormerData.toolCallBinary 是 base64(protobuf agent.v1.ToolCall)。
 * - params / result 是 **JSON 字符串**，内容是 aiserver.v1.* 消息的 protobuf JSON 形态；
 *   app 用 wQd() 里的 Xxx.fromJsonString(e.params / e.result) 解码。
 *
 * 本文件把常见工具的 IR 参数/结果编码成这些 JSON 结构。字段名来自
 * Cursor 3.25.9 workbench.desktop.main.js 的 protobuf-es 定义（makeMessageType）
 * 和真实库样本；证据与边界写在 research/cursor-toolformer.md。
 */
import type { IrContent } from '@sessionport/core';

import { isRecord, tryParseJson } from './wire.ts';
import type { CursorToolFormerData } from './wire.ts';

/** app 里 COMPOSER_CAPABILITY_TYPE_TOOL_FORMER = 15 */
export const CAPABILITY_TOOL_FORMER = 15;

export const CURSOR_TOOL_STATUSES = ['completed', 'error', 'cancelled', 'loading'] as const;
export type CursorToolStatus = (typeof CURSOR_TOOL_STATUSES)[number];

/** aiserver.v1.ClientSideToolV2 的实测数值（Cursor 3.25.9 bundle） */
export const CURSOR_TOOL = {
  UNSPECIFIED: 0,
  READ_SEMSEARCH_FILES: 1,
  RIPGREP_SEARCH: 3,
  READ_FILE: 5,
  LIST_DIR: 6,
  EDIT_FILE: 7,
  FILE_SEARCH: 8,
  SEMANTIC_SEARCH_FULL: 9,
  DELETE_FILE: 11,
  REAPPLY: 12,
  RUN_TERMINAL_COMMAND_V2: 15,
  FETCH_RULES: 16,
  WEB_SEARCH: 18,
  MCP: 19,
  SEARCH_SYMBOLS: 23,
  BACKGROUND_COMPOSER_FOLLOWUP: 24,
  KNOWLEDGE_BASE: 25,
  FETCH_PULL_REQUEST: 26,
  DEEP_SEARCH: 27,
  CREATE_DIAGRAM: 28,
  FIX_LINTS: 29,
  READ_LINTS: 30,
  GO_TO_DEFINITION: 31,
  TASK: 32,
  AWAIT_TASK: 33,
  TODO_READ: 34,
  TODO_WRITE: 35,
  EDIT_FILE_V2: 38,
  LIST_DIR_V2: 39,
  READ_FILE_V2: 40,
  RIPGREP_RAW_SEARCH: 41,
  GLOB_FILE_SEARCH: 42,
  CREATE_PLAN: 43,
  LIST_MCP_RESOURCES: 44,
  READ_MCP_RESOURCE: 45,
  READ_PROJECT: 46,
  UPDATE_PROJECT: 47,
  TASK_V2: 48,
  CALL_MCP_TOOL: 49,
  APPLY_AGENT_DIFF: 50,
  ASK_QUESTION: 51,
  SWITCH_MODE: 52,
  GENERATE_IMAGE: 53,
  COMPUTER_USE: 54,
  WRITE_SHELL_STDIN: 55,
  RECORD_SCREEN: 56,
  WEB_FETCH: 57,
  REPORT_BUGFIX_RESULTS: 58,
  AI_ATTRIBUTION: 59,
  MCP_AUTH: 60,
  REFLECT: 61,
  AWAIT: 62,
  GET_MCP_TOOLS: 63,
  SEND_TO_USER: 65,
  CONNECT_SCM: 66,
} as const;

export type CursorToolKind = 'shell' | 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'list' | 'delete' | 'todo';

interface CursorToolDefinition {
  kind: CursorToolKind;
  /** 写进 toolFormerData.name 的 Cursor 规范名 */
  cursorName: string;
  tool: number;
  aliases: string[];
}

const TOOL_DEFINITIONS: CursorToolDefinition[] = [
  {
    kind: 'shell',
    cursorName: 'run_terminal_command_v2',
    tool: CURSOR_TOOL.RUN_TERMINAL_COMMAND_V2,
    aliases: ['run_terminal_command', 'bash', 'shell', 'shell_command', 'exec_command', 'terminal', 'run_command'],
  },
  {
    kind: 'read',
    cursorName: 'read_file_v2',
    tool: CURSOR_TOOL.READ_FILE_V2,
    aliases: ['read_file', 'read', 'view', 'readfile', 'open_file'],
  },
  {
    kind: 'edit',
    cursorName: 'edit_file_v2',
    tool: CURSOR_TOOL.EDIT_FILE_V2,
    aliases: ['edit_file', 'edit', 'str_replace', 'str_replace_editor'],
  },
  {
    kind: 'write',
    cursorName: 'edit_file_v2',
    tool: CURSOR_TOOL.EDIT_FILE_V2,
    aliases: ['write', 'write_file', 'create_file', 'create', 'save_file'],
  },
  {
    kind: 'grep',
    cursorName: 'ripgrep_raw_search',
    tool: CURSOR_TOOL.RIPGREP_RAW_SEARCH,
    aliases: ['grep', 'ripgrep_search', 'ripgrep', 'grep_search', 'search', 'rg'],
  },
  {
    kind: 'glob',
    cursorName: 'glob_file_search',
    tool: CURSOR_TOOL.GLOB_FILE_SEARCH,
    aliases: ['glob', 'file_search', 'search_files', 'glob_search'],
  },
  {
    kind: 'list',
    cursorName: 'list_dir_v2',
    tool: CURSOR_TOOL.LIST_DIR_V2,
    aliases: ['list_dir', 'ls', 'list', 'list_directory', 'listdir', 'dir'],
  },
  {
    kind: 'delete',
    cursorName: 'delete_file',
    tool: CURSOR_TOOL.DELETE_FILE,
    aliases: ['delete', 'remove_file', 'rm', 'delete_path'],
  },
  {
    kind: 'todo',
    cursorName: 'todo_write',
    tool: CURSOR_TOOL.TODO_WRITE,
    aliases: ['todos', 'update_plan', 'update_todos', 'todowrite'],
  },
];

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

const TOOL_BY_NAME = new Map<string, CursorToolDefinition>();
for (const definition of TOOL_DEFINITIONS) {
  for (const alias of [definition.cursorName, ...definition.aliases]) {
    TOOL_BY_NAME.set(normalizeToolName(alias), definition);
  }
}

/** 只给读取侧用：枚举数值 → Cursor 规范名（不认识的返回 undefined） */
const TOOL_NAME_BY_NUMBER = new Map<number, string>();
for (const definition of TOOL_DEFINITIONS) TOOL_NAME_BY_NUMBER.set(definition.tool, definition.cursorName);
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.READ_SEMSEARCH_FILES, 'read_semsearch_files');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.RIPGREP_SEARCH, 'ripgrep_search');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.READ_FILE, 'read_file');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.LIST_DIR, 'list_dir');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.EDIT_FILE, 'edit_file');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.FILE_SEARCH, 'file_search');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.SEMANTIC_SEARCH_FULL, 'semantic_search_full');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.REAPPLY, 'reapply');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.FETCH_RULES, 'fetch_rules');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.WEB_SEARCH, 'web_search');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.MCP, 'mcp');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.SEARCH_SYMBOLS, 'search_symbols');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.READ_LINTS, 'read_lints');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.TASK, 'task');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.AWAIT_TASK, 'await_task');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.TODO_READ, 'todo_read');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.CREATE_PLAN, 'create_plan');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.TASK_V2, 'task_v2');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.ASK_QUESTION, 'ask_question');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.SWITCH_MODE, 'switch_mode');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.WEB_FETCH, 'web_fetch');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.AWAIT, 'await');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.GET_MCP_TOOLS, 'get_mcp_tools');
TOOL_NAME_BY_NUMBER.set(CURSOR_TOOL.SEND_TO_USER, 'send_to_user');

export function resolveCursorTool(name: string): CursorToolDefinition | undefined {
  return TOOL_BY_NAME.get(normalizeToolName(name));
}

export function cursorToolName(tool: number): string | undefined {
  return TOOL_NAME_BY_NUMBER.get(tool);
}

export function isCursorToolStatus(value: unknown): value is CursorToolStatus {
  return typeof value === 'string' && (CURSOR_TOOL_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 输入/结果的小工具
// ---------------------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    const parsed = tryParseJson(value.trim());
    if (isRecord(parsed)) return parsed;
  }
  return undefined;
}

/** 有些 agent 的 tool_call.input 直接是字符串（命令/路径/pattern），按工具语义兜底 */
function stringInput(kind: CursorToolKind, value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  switch (kind) {
    case 'shell':
      return { command: value };
    case 'read':
    case 'edit':
    case 'delete':
      return { path: value };
    case 'list':
      return { path: value };
    case 'grep':
      return { pattern: value };
    case 'glob':
      return { pattern: value };
    default:
      return undefined;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function boolOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringOf(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberOf(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = boolOf(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return out.length > 0 ? out : undefined;
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? '{}' : text;
  } catch {
    return '{}';
  }
}

function contentJson(content: IrContent[] | undefined): unknown {
  if (content === undefined || content.length !== 1) return undefined;
  const only = content[0];
  return only !== undefined && only.type === 'json' ? only.value : undefined;
}

/** IR content 拍平成文本（和 core 的 contentToText 语义一致） */
export function irContentText(content: IrContent[] | undefined): string {
  if (content === undefined || content.length === 0) return '';
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
        case 'diff':
        case 'terminal':
          return part.text;
        case 'image':
          return '[image: ' + part.ref + ']';
        case 'json':
          return safeStringify(part.value);
        default:
          return '';
      }
    })
    .join('\n');
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function extensionOf(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

export interface CursorToolCallSpec {
  callId: string;
  name: string;
  input: unknown;
  /** 工具调用发生时间（毫秒） */
  atMs: number;
}

export interface CursorToolResultSpec {
  content: IrContent[];
  isError?: boolean;
  /** 工具结果发生时间（毫秒），用于 completedAtMs */
  atMs?: number;
}

export interface ToolFormerWarning {
  code: string;
  message: string;
  severity?: 'info' | 'warning';
}

export interface BuiltToolFormer {
  ok: true;
  data: CursorToolFormerData;
  canonicalName: string;
  tool: number;
  status: CursorToolStatus;
  warnings: ToolFormerWarning[];
}

export interface RejectedToolFormer {
  ok: false;
  reason: 'unsupported' | 'unusable-input';
  detail: string;
  warnings: ToolFormerWarning[];
}

export type BuildToolFormerResult = BuiltToolFormer | RejectedToolFormer;

interface MappedToolInput {
  params: Record<string, unknown>;
  /** 路径（read/edit/delete/list 等） */
  path?: string;
  command?: string;
  /** 完整的新文件内容（edit/write） */
  content?: string;
  /** 替换片段（edit 的 new_string） */
  patchText?: string;
  todos?: Array<Record<string, unknown>>;
  outputMode?: string;
  isWrite?: boolean;
}

interface MappedToolResult {
  result?: unknown;
  additionalData?: Record<string, unknown>;
  warnings: ToolFormerWarning[];
}

// ---------------------------------------------------------------------------
// 参数映射
// ---------------------------------------------------------------------------

function mapShellInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const raw = input.command ?? input.cmd ?? input.script ?? input.shell_command;
  let command: string | undefined;
  if (typeof raw === 'string') command = raw;
  else if (Array.isArray(raw)) {
    command = raw
      .map((part) => (typeof part === 'string' ? part : safeStringify(part)))
      .join(' ');
  } else if (isRecord(raw)) command = stringOf(raw.command);
  if (command === undefined || command.trim().length === 0) return undefined;
  const params: Record<string, unknown> = { command };
  const cwd = firstString(input, ['cwd', 'workdir', 'working_directory', 'workingDirectory']);
  if (cwd !== undefined) params.cwd = cwd;
  const isBackground = firstBoolean(input, ['is_background', 'isBackground', 'background']);
  if (isBackground === true) params.isBackground = true;
  const timeout = firstNumber(input, ['timeout', 'timeout_ms', 'timeoutMs', 'yield_time_ms', 'command_timeout_ms']);
  if (timeout !== undefined) params.options = { timeout };
  const description = firstString(input, ['description', 'command_description', 'commandDescription', 'explanation']);
  if (description !== undefined) params.commandDescription = description;
  return { params, command };
}

function mapReadInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const path = firstString(input, ['targetFile', 'target_file', 'file_path', 'filePath', 'path', 'absolute_path', 'file']);
  if (path === undefined) return undefined;
  const params: Record<string, unknown> = {
    targetFile: path,
    charsLimit: firstNumber(input, ['charsLimit', 'chars_limit']) ?? 1000000,
    effectiveUri: firstString(input, ['effectiveUri', 'effective_uri']) ?? path,
  };
  const offset = firstNumber(input, ['offset', 'start_line', 'startLine', 'start']);
  // 与 app 的 protobuf JSON 一致：0/false 这类默认值省略（fromJsonString 仍按默认值解释）
  if (offset !== undefined && offset > 0) params.offset = offset;
  const limit = firstNumber(input, ['limit', 'line_count', 'lineCount', 'lines', 'end_line']);
  if (limit !== undefined && limit > 0) params.limit = limit;
  const enableLineNumbers = firstBoolean(input, ['enableLineNumbers', 'enable_line_numbers']);
  if (enableLineNumbers === true) params.enableLineNumbers = true;
  return { params, path };
}

function mapEditInput(input: Record<string, unknown>, isWrite: boolean): MappedToolInput | undefined {
  const path = firstString(input, [
    'relativeWorkspacePath',
    'relative_workspace_path',
    'file_path',
    'filePath',
    'path',
    'targetFile',
    'target_file',
  ]);
  if (path === undefined) return undefined;
  const fullContent = firstString(input, [
    'contentsAfterEdit',
    'contents_after_edit',
    'content',
    'contents',
    'new_content',
    'newContent',
    'file_text',
    'text',
  ]);
  const patchText = firstString(input, ['new_string', 'newString', 'new_text', 'newText', 'new_str', 'replacement', 'new_code']);
  const params: Record<string, unknown> = { relativeWorkspacePath: path, noCodeblock: true, cloudAgentEdit: false };
  if (fullContent !== undefined) params.contentsAfterEdit = fullContent;
  else if (patchText !== undefined) params.streamingContent = patchText;
  const resultForModel = firstString(input, ['result_for_model', 'resultForModel']);
  if (resultForModel !== undefined) params.resultForModel = resultForModel;
  if (isWrite && fullContent === undefined) return undefined;
  return { params, path, content: fullContent, patchText, isWrite };
}

function mapGrepInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const rawPattern = input.pattern ?? input.query ?? input.regex ?? input.search_term;
  let pattern: string | undefined;
  if (typeof rawPattern === 'string') pattern = rawPattern;
  else if (Array.isArray(rawPattern)) pattern = rawPattern.map((item) => String(item)).join('|');
  if (pattern === undefined || pattern.length === 0) return undefined;
  const params: Record<string, unknown> = { pattern };
  const path = firstString(input, ['path', 'directory', 'target_directory', 'targetDirectory', 'cwd']);
  if (path !== undefined) params.path = path;
  const glob = firstString(input, ['glob', 'include', 'include_pattern', 'file_pattern', 'filePattern']);
  if (glob !== undefined) params.glob = glob;
  const outputMode = firstString(input, ['output_mode', 'outputMode', 'mode']);
  const normalizedMode =
    outputMode === 'files_with_matches' || outputMode === 'files' || outputMode === 'content' || outputMode === 'count'
      ? outputMode === 'files'
        ? 'files_with_matches'
        : outputMode
      : undefined;
  if (normalizedMode !== undefined) params.outputMode = normalizedMode;
  const contextBefore = firstNumber(input, ['context_before', 'contextBefore', '-B', 'before']);
  const contextAfter = firstNumber(input, ['context_after', 'contextAfter', '-A', 'after']);
  const context = firstNumber(input, ['context', '-C']);
  if (contextBefore !== undefined && contextBefore > 0) params.contextBefore = contextBefore;
  if (contextAfter !== undefined && contextAfter > 0) params.contextAfter = contextAfter;
  if (context !== undefined && context > 0) params.context = context;
  const caseInsensitive = firstBoolean(input, ['case_insensitive', 'caseInsensitive', '-i', 'ignore_case']);
  if (caseInsensitive === true) params.caseInsensitive = true;
  const type = firstString(input, ['type', 'file_type']);
  if (type !== undefined) params.type = type;
  const headLimit = firstNumber(input, ['head_limit', 'headLimit', 'limit']);
  if (headLimit !== undefined && headLimit > 0) params.headLimit = headLimit;
  const multiline = firstBoolean(input, ['multiline', 'multi_line']);
  if (multiline === true) params.multiline = true;
  const offset = firstNumber(input, ['offset']);
  if (offset !== undefined && offset > 0) params.offset = offset;
  const ignoreGlobs = stringArrayOf(input.ignore_globs ?? input.ignoreGlobs);
  if (ignoreGlobs !== undefined) params.ignoreGlobs = ignoreGlobs;
  return { params, path, outputMode: normalizedMode ?? 'content' };
}

function mapGlobInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const pattern = firstString(input, ['globPattern', 'glob_pattern', 'pattern', 'glob', 'query']);
  if (pattern === undefined) return undefined;
  const targetDirectory =
    firstString(input, ['targetDirectory', 'target_directory', 'path', 'cwd', 'directory', 'root']) ?? '.';
  return { params: { targetDirectory, globPattern: pattern }, path: targetDirectory };
}

function mapListInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const targetDirectory =
    firstString(input, ['targetDirectory', 'target_directory', 'path', 'directory', 'dir', 'cwd']) ?? '.';
  const params: Record<string, unknown> = { targetDirectory };
  const ignoreGlobs = stringArrayOf(input.ignore_globs ?? input.ignoreGlobs);
  if (ignoreGlobs !== undefined) params.ignoreGlobs = ignoreGlobs;
  return { params, path: targetDirectory };
}

function mapDeleteInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const path = firstString(input, [
    'relativeWorkspacePath',
    'relative_workspace_path',
    'file_path',
    'filePath',
    'path',
    'targetFile',
    'target_file',
  ]);
  if (path === undefined) return undefined;
  return { params: { relativeWorkspacePath: path }, path };
}

function normalizeTodoStatus(value: unknown): string {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'in_progress' || text === 'in-progress' || text === 'running' || text === 'active') return 'in_progress';
  if (text === 'completed' || text === 'done' || text === 'complete') return 'completed';
  if (text === 'cancelled' || text === 'canceled' || text === 'blocked') return 'cancelled';
  return 'pending';
}

function mapTodoInput(input: Record<string, unknown>): MappedToolInput | undefined {
  const rawTodos = input.todos ?? input.items ?? input.plan;
  if (!Array.isArray(rawTodos)) return undefined;
  const todos: Array<Record<string, unknown>> = [];
  rawTodos.forEach((item, index) => {
    if (isRecord(item)) {
      const content = stringOf(item.content) ?? stringOf(item.step) ?? stringOf(item.title) ?? stringOf(item.text);
      if (content === undefined) return;
      todos.push({
        id: stringOf(item.id) ?? 'todo-' + String(index + 1),
        content,
        status: normalizeTodoStatus(item.status),
      });
      return;
    }
    if (typeof item === 'string' && item.trim().length > 0) {
      todos.push({ id: 'todo-' + String(index + 1), content: item, status: 'pending' });
    }
  });
  const merge = firstBoolean(input, ['merge']) ?? false;
  return { params: { todos, merge }, todos };
}

function mapInput(kind: CursorToolKind, input: Record<string, unknown> | undefined): MappedToolInput | undefined {
  if (input === undefined) {
    if (kind === 'list') return mapListInput({});
    return undefined;
  }
  switch (kind) {
    case 'shell':
      return mapShellInput(input);
    case 'read':
      return mapReadInput(input);
    case 'edit':
      return mapEditInput(input, false);
    case 'write':
      return mapEditInput(input, true);
    case 'grep':
      return mapGrepInput(input);
    case 'glob':
      return mapGlobInput(input);
    case 'list':
      return mapListInput(input);
    case 'delete':
      return mapDeleteInput(input);
    case 'todo':
      return mapTodoInput(input);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 结果映射
// ---------------------------------------------------------------------------

function shellResult(text: string, isError: boolean): Record<string, unknown> {
  return {
    output: text,
    exitCode: isError ? 1 : 0,
    rejected: false,
    notInterrupted: true,
    outputRaw: text,
  };
}

function buildGrepSummary(
  text: string,
  params: Record<string, unknown>,
  outputMode: string | undefined,
): Record<string, unknown> {
  const pattern = typeof params.pattern === 'string' ? params.pattern : '';
  const path = typeof params.path === 'string' ? params.path : undefined;
  const mode = outputMode ?? 'content';
  const lines = splitLines(text);
  const counts = new Map<string, number>();
  let totalMatches = 0;
  if (mode === 'count') {
    for (const line of lines) {
      const match = /^(.*?):(\d+)$/.exec(line);
      if (match !== null) {
        const file = match[1] as string;
        const count = Number(match[2]);
        counts.set(file, (counts.get(file) ?? 0) + (Number.isFinite(count) ? count : 0));
        totalMatches += Number.isFinite(count) ? count : 0;
      }
    }
  } else if (mode === 'files_with_matches') {
    for (const line of lines) {
      const file = stripDotSlash(line);
      counts.set(file, 1);
      totalMatches += 1;
    }
  } else {
    for (const line of lines) {
      const match = /^(.*?):(\d+):/.exec(line);
      if (match !== null) {
        const file = match[1] as string;
        counts.set(file, (counts.get(file) ?? 0) + 1);
      } else {
        const file = stripDotSlash(line);
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      totalMatches += 1;
    }
  }
  const topFiles = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([uri, matchCount]) => ({ uri, matchCount }));
  const summary: Record<string, unknown> = {
    isPruned: true,
    pattern,
    outputMode: mode,
    totalFiles: counts.size,
    totalMatches,
    topFiles,
  };
  if (path !== undefined && path.length > 0) summary.path = path;
  return summary;
}

function buildGlobDirectories(text: string, json: unknown, targetDirectory: string): Array<Record<string, unknown>> {
  if (isRecord(json) && Array.isArray(json.directories)) {
    const out: Array<Record<string, unknown>> = [];
    for (const directory of json.directories) {
      if (!isRecord(directory)) continue;
      const absPath = typeof directory.absPath === 'string' ? directory.absPath : targetDirectory;
      const files: Array<Record<string, unknown>> = [];
      if (Array.isArray(directory.files)) {
        for (const file of directory.files) {
          if (isRecord(file) && typeof file.relPath === 'string') files.push({ relPath: file.relPath });
          else if (typeof file === 'string') files.push({ relPath: file });
        }
      }
      const entry: Record<string, unknown> = { absPath, files };
      if (typeof directory.totalFiles === 'number') entry.totalFiles = directory.totalFiles;
      else entry.totalFiles = files.length;
      if (directory.ripgrepTruncated === true) entry.ripgrepTruncated = true;
      out.push(entry);
    }
    return out;
  }
  const relPaths: string[] = [];
  if (isRecord(json) && Array.isArray(json.files)) {
    for (const file of json.files) {
      if (typeof file === 'string') relPaths.push(stripDotSlash(file));
      else if (isRecord(file) && typeof file.relPath === 'string') relPaths.push(file.relPath);
      else if (isRecord(file) && typeof file.path === 'string') relPaths.push(file.path);
    }
  }
  if (relPaths.length === 0) {
    for (const line of splitLines(text)) relPaths.push(stripDotSlash(line));
  }
  return [
    {
      absPath: targetDirectory,
      files: relPaths.map((relPath) => ({ relPath })),
      totalFiles: relPaths.length,
    },
  ];
}

function buildListSummary(
  text: string,
  json: unknown,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const rootPath = typeof params.targetDirectory === 'string' ? params.targetDirectory : '.';
  const topEntries: Array<Record<string, unknown>> = [];
  const extensionCounts: Record<string, number> = {};
  let totalDirs = 0;
  let totalFiles = 0;

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    const childrenDirs = Array.isArray(node.childrenDirs) ? node.childrenDirs : [];
    const childrenFiles = Array.isArray(node.childrenFiles) ? node.childrenFiles : [];
    for (const dir of childrenDirs) {
      if (!isRecord(dir)) continue;
      totalDirs += 1;
      const absPath = typeof dir.absPath === 'string' ? dir.absPath : prefix;
      if (topEntries.length < 100) topEntries.push({ path: absPath, isDir: true });
      walk(dir, absPath);
    }
    for (const file of childrenFiles) {
      if (!isRecord(file) || typeof file.name !== 'string') continue;
      totalFiles += 1;
      const filePath = prefix.endsWith('/') ? prefix + file.name : prefix + '/' + file.name;
      if (topEntries.length < 100) topEntries.push({ path: filePath, isDir: false });
      const ext = extensionOf(file.name);
      if (ext !== undefined) extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
    }
  };

  if (isRecord(json) && isRecord(json.directoryTreeRoot)) {
    const root = json.directoryTreeRoot;
    walk(root, typeof root.absPath === 'string' ? root.absPath : rootPath);
  } else {
    for (const line of splitLines(text)) {
      const raw = line.replace(/\s+$/, '');
      if (raw.length === 0) continue;
      const isDir = raw.endsWith('/') || raw.endsWith('/.');
      const cleaned = isDir ? raw.replace(/\/+$/, '') : raw;
      if (isDir) totalDirs += 1;
      else {
        totalFiles += 1;
        const ext = extensionOf(cleaned);
        if (ext !== undefined) extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
      }
      const fullPath =
        cleaned.startsWith('/') || rootPath === '.' || rootPath === ''
          ? cleaned
          : rootPath.replace(/\/+$/, '') + '/' + cleaned;
      if (topEntries.length < 100) topEntries.push({ path: fullPath, isDir });
    }
  }

  return {
    isPruned: true,
    rootPath,
    totalDirs,
    totalFiles,
    topEntries,
    extensionCounts,
  };
}

function mapResult(
  kind: CursorToolKind,
  mapped: MappedToolInput,
  result: CursorToolResultSpec | undefined,
  call: CursorToolCallSpec,
): MappedToolResult {
  const warnings: ToolFormerWarning[] = [];
  const text = result === undefined ? '' : irContentText(result.content);
  const json = result === undefined ? undefined : contentJson(result.content);
  const isError = result?.isError === true;

  if (result === undefined) {
    if (kind === 'shell') return { additionalData: { status: 'cancelled' }, warnings };
    return { warnings };
  }

  switch (kind) {
    case 'shell': {
      const additionalData: Record<string, unknown> = {
        status: isError ? 'error' : 'success',
        startedAtMs: call.atMs,
      };
      return { result: shellResult(text, isError), additionalData, warnings };
    }
    case 'read': {
      let contents = text;
      if (isRecord(json) && typeof json.contents === 'string') contents = json.contents;
      const resultObj: Record<string, unknown> = { contents };
      if (isRecord(json) && typeof json.totalLinesInFile === 'number') resultObj.totalLinesInFile = json.totalLinesInFile;
      return { result: resultObj, warnings };
    }
    case 'edit':
    case 'write': {
      const resultObj: Record<string, unknown> = {
        rejected: false,
        resultForModel: text,
      };
      if (mapped.content !== undefined) {
        resultObj.contentsAfterEdit = mapped.content;
        if (mapped.isWrite === true) resultObj.fileWasCreated = true;
      }
      if (isRecord(json)) {
        if (typeof json.fileWasCreated === 'boolean') resultObj.fileWasCreated = json.fileWasCreated;
        if (typeof json.contentsAfterEdit === 'string') {
          resultObj.contentsAfterEdit = json.contentsAfterEdit;
          if (mapped.isWrite === true) resultObj.fileWasCreated = true;
        }
        if (typeof json.detectedLanguage === 'string') resultObj.detectedLanguage = json.detectedLanguage;
      }
      warnings.push({
        code: 'cursor.edit-diff-unavailable',
        message:
          'IR 里没有源端文件的 before/after 全文，Cursor 的 edit 气泡只能显示路径/结果，无法生成可展开的 diff',
        severity: 'warning',
      });
      if (mapped.isWrite === true) {
        warnings.push({
          code: 'cursor.write-mapped-to-edit',
          message: 'Write 工具按 Cursor 的 edit_file_v2 + fileWasCreated 近似写入（内容保留，diff 不可用）',
          severity: 'info',
        });
      }
      return { result: resultObj, warnings };
    }
    case 'grep': {
      // 错误文本不是 grep 结果，别把它解析成 totalFiles/topFiles；错误信息在 error 字段里。
      if (isError) return { warnings };
      return { additionalData: buildGrepSummary(text, mapped.params, mapped.outputMode), warnings };
    }
    case 'glob': {
      if (isError) return { warnings };
      const targetDirectory =
        typeof mapped.params.targetDirectory === 'string' ? mapped.params.targetDirectory : '.';
      return { result: { directories: buildGlobDirectories(text, json, targetDirectory) }, warnings };
    }
    case 'list': {
      if (isError) return { warnings };
      return { additionalData: buildListSummary(text, json, mapped.params), warnings };
    }
    case 'delete': {
      let fileNonExistent = false;
      if (isError) fileNonExistent = /not\s*found|no such file|does not exist/i.test(text);
      return {
        result: { rejected: false, fileNonExistent, fileDeletedSuccessfully: !isError },
        warnings,
      };
    }
    case 'todo': {
      let todos = mapped.todos ?? [];
      if (isRecord(json) && Array.isArray(json.finalTodos)) {
        const finalTodos: Array<Record<string, unknown>> = [];
        for (const item of json.finalTodos) {
          if (!isRecord(item)) continue;
          const content = stringOf(item.content) ?? stringOf(item.step) ?? stringOf(item.title);
          if (content === undefined) continue;
          finalTodos.push({
            id: stringOf(item.id) ?? 'todo-' + String(finalTodos.length + 1),
            content,
            status: normalizeTodoStatus(item.status),
          });
        }
        if (finalTodos.length > 0) todos = finalTodos;
      }
      const resultObj: Record<string, unknown> = {
        success: !isError,
        finalTodos: todos,
        initialTodos: todos,
        wasMerge: false,
      };
      if (isRecord(json) && typeof json.success === 'boolean') resultObj.success = json.success;
      return { result: resultObj, warnings };
    }
    default:
      return { warnings };
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function emptyToUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

function toolExtension(
  call: CursorToolCallSpec,
  result: CursorToolResultSpec | undefined,
): Record<string, unknown> {
  const extension: Record<string, unknown> = { v: 1, name: call.name };
  if (call.input !== undefined) extension.input = call.input;
  if (result !== undefined) {
    extension.content = result.content;
    extension.isError = result.isError === true;
  }
  return extension;
}

export function buildCursorToolFormerData(
  call: CursorToolCallSpec,
  result: CursorToolResultSpec | undefined,
): BuildToolFormerResult {
  const definition = resolveCursorTool(call.name);
  if (definition === undefined) {
    return {
      ok: false,
      reason: 'unsupported',
      detail: call.name,
      warnings: [
        {
          code: 'cursor.tool-call-unsupported',
          message: '该工具在 Cursor 3.25.9 里没有已确认的 toolFormerData 编码，调用与结果已显式丢弃',
          severity: 'warning',
        },
      ],
    };
  }
  let input = call.input === undefined ? undefined : recordOf(call.input);
  if (input === undefined && typeof call.input === 'string') {
    input = stringInput(definition.kind, call.input);
  }
  let mapped = mapInput(definition.kind, input);
  if (mapped === undefined && definition.kind === 'write') {
    // Write 至少要拿到路径和内容；mapEditInput 已经检查 content。
    mapped = mapEditInput(input ?? {}, true);
  }
  if (mapped === undefined) {
    return {
      ok: false,
      reason: 'unusable-input',
      detail: definition.cursorName,
      warnings: [
        {
          code: 'cursor.tool-input-unusable',
          message: '工具参数缺少可编码字段（如 command/path/pattern），调用已显式丢弃',
          severity: 'warning',
        },
      ],
    };
  }

  const mappedResult = mapResult(definition.kind, mapped, result, call);
  const status: CursorToolStatus = result === undefined ? 'cancelled' : result.isError === true ? 'error' : 'completed';
  const errorText = result?.isError === true ? irContentText(result.content) : '';
  const data: CursorToolFormerData = {
    toolCallId: call.callId,
    toolIndex: 0,
    modelCallId: call.callId,
    status,
    name: definition.cursorName,
    rawArgs: call.input === undefined ? '{}' : typeof call.input === 'string' ? call.input : safeStringify(call.input),
    tool: definition.tool,
    params: safeStringify(mapped.params),
    ...(mappedResult.result !== undefined ? { result: safeStringify(mappedResult.result) } : {}),
    ...(result?.isError === true
      ? {
          error: safeStringify({
            clientVisibleErrorMessage: errorText,
            modelVisibleErrorMessage: errorText,
          }),
        }
      : {}),
    ...(mappedResult.additionalData !== undefined
      ? { additionalData: emptyToUndefined(mappedResult.additionalData) }
      : {}),
    _sessionport: toolExtension(call, result),
  };
  const additional = data.additionalData;
  if (additional === undefined) delete data.additionalData;

  return {
    ok: true,
    data,
    canonicalName: definition.cursorName,
    tool: definition.tool,
    status,
    warnings: mappedResult.warnings,
  };
}
