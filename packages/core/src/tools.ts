export type CanonicalTool =
  | { kind: 'shell'; command: string; cwd?: string; timeoutMs?: number; description?: string }
  | { kind: 'read'; path: string; offset?: number; limit?: number }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; oldText: string; newText: string; replaceAll?: boolean }
  | { kind: 'patch'; patch: string }
  | {
      kind: 'grep';
      pattern: string;
      path?: string;
      glob?: string;
      caseInsensitive?: boolean;
      outputMode?: 'content' | 'files_with_matches' | 'count';
    }
  | { kind: 'glob'; pattern: string; path?: string }
  | { kind: 'list'; path: string }
  | { kind: 'todo'; todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> };

export type ToolRenderTarget = 'claude-code' | 'codex' | 'opencode' | 'command-code' | 'qoder' | 'generic';

export interface RenderedTool {
  name: string;
  input: unknown;
  custom?: boolean;
}

export interface NormalizeResult {
  name: string;
  input: unknown;
  custom?: boolean;
  status: 'native' | 'normalized' | 'unmapped' | 'skipped';
}

export function normalizeToolKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const SHELL_ALIASES = new Set([
  'bash',
  'shell',
  'shellcommand',
  'execcommand',
  'runterminalcommand',
  'runterminalcommandv2',
  'terminal',
  'runcommand',
  'localshell',
]);

const READ_ALIASES = new Set(['read', 'readfile', 'readfilev2', 'view', 'openfile']);
const WRITE_ALIASES = new Set(['write', 'writefile', 'createfile', 'savefile']);
const EDIT_ALIASES = new Set(['edit', 'editfile', 'editfilev2', 'strreplace', 'strreplaceeditor']);
const PATCH_ALIASES = new Set(['applypatch']);
const GREP_ALIASES = new Set(['grep', 'ripgrep', 'ripgrepsearch', 'ripgreprawsearch', 'grepsearch', 'rg']);
const GLOB_ALIASES = new Set(['glob', 'globfilesearch', 'filesearch', 'globsearch']);
const LIST_ALIASES = new Set(['ls', 'list', 'listdir', 'listdirv2', 'listdirectory', 'readdirectory']);
const TODO_ALIASES = new Set(['todowrite', 'updateplan', 'todos', 'updatetodos']);

const CLAUDE_STYLE_NATIVE_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Grep',
  'Glob',
  'TodoWrite',
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
]);

const NATIVE_TOOL_NAMES: Record<ToolRenderTarget, ReadonlySet<string>> = {
  'claude-code': CLAUDE_STYLE_NATIVE_TOOLS,
  qoder: CLAUDE_STYLE_NATIVE_TOOLS,
  codex: new Set(['exec_command', 'shell', 'apply_patch', 'update_plan', 'write_stdin', 'view_image']),
  opencode: new Set(['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list', 'todowrite', 'todoread', 'task', 'webfetch', 'patch']),
  'command-code': new Set([
    'shell_command',
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'grep',
    'read_directory',
    'todo_write',
    'run_code',
    'agent',
    'web_fetch',
    'ask_user_question',
    'exit_plan_mode',
    'plugin_manager',
  ]),
  generic: new Set(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
  }
}

function firstNonEmptyString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstStringValue(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function firstFiniteNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstBoolValue(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function parseInput(input: unknown): { record?: Record<string, unknown>; rawString?: string } {
  if (isRecord(input)) return { record: input };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRecord(parsed)) return { record: parsed };
      } catch {
        // 保持原始字符串
      }
    }
    return { rawString: input };
  }
  return {};
}

function extractShellCommand(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0) {
    if (
      raw.length === 3 &&
      typeof raw[0] === 'string' &&
      ['bash', 'sh', 'zsh'].includes((raw[0].split('/').pop() ?? '').toLowerCase()) &&
      (raw[1] === '-c' || raw[1] === '-lc') &&
      typeof raw[2] === 'string'
    ) {
      return raw[2];
    }
    return raw.map((part) => (typeof part === 'string' ? part : safeStringify(part))).join(' ');
  }
  return undefined;
}

function normalizeTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'in_progress' || text === 'in-progress' || text === 'running' || text === 'active') return 'in_progress';
  if (text === 'completed' || text === 'done' || text === 'complete') return 'completed';
  return 'pending';
}

function normalizeGrepOutputMode(value: string | undefined): 'content' | 'files_with_matches' | 'count' | undefined {
  if (value === 'content' || value === 'files_with_matches' || value === 'count') return value;
  if (value === 'files') return 'files_with_matches';
  return undefined;
}

export function classifyTool(name: string, input: unknown): CanonicalTool | undefined {
  const key = normalizeToolKey(name);
  const { record, rawString } = parseInput(input);

  if (SHELL_ALIASES.has(key)) {
    const command =
      rawString !== undefined
        ? rawString
        : record !== undefined
          ? extractShellCommand(record.command ?? record.cmd ?? record.script)
          : undefined;
    if (command === undefined || command.trim().length === 0) return undefined;
    const cwd = record ? firstNonEmptyString(record, ['cwd', 'workdir', 'working_directory']) : undefined;
    const timeoutMs = record ? firstFiniteNumber(record, ['timeout', 'timeout_ms', 'timeoutMs']) : undefined;
    const description = record ? firstNonEmptyString(record, ['description']) : undefined;
    return {
      kind: 'shell',
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }

  if (READ_ALIASES.has(key)) {
    if (!record) return undefined;
    const path = firstNonEmptyString(record, ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'absolute_path']);
    if (path === undefined) return undefined;
    const offset = firstFiniteNumber(record, ['offset', 'start_line', 'startLine']);
    const limit = firstFiniteNumber(record, ['limit', 'line_count', 'lineCount']);
    return {
      kind: 'read',
      path,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  if (WRITE_ALIASES.has(key)) {
    if (!record) return undefined;
    const path = firstNonEmptyString(record, ['file_path', 'filePath', 'path', 'target_file', 'targetFile']);
    const content = firstStringValue(record, ['content', 'contents', 'file_text', 'new_content', 'newContent', 'text']);
    if (path === undefined || content === undefined) return undefined;
    return { kind: 'write', path, content };
  }

  if (EDIT_ALIASES.has(key)) {
    if (!record) return undefined;
    const path = firstNonEmptyString(record, [
      'file_path',
      'filePath',
      'path',
      'target_file',
      'targetFile',
      'relativeWorkspacePath',
      'relative_workspace_path',
    ]);
    if (path === undefined) return undefined;
    const oldText = firstStringValue(record, ['old_string', 'oldString', 'old_str', 'old_text', 'oldText']);
    const newText = firstStringValue(record, ['new_string', 'newString', 'new_str', 'new_text', 'newText']);
    if (oldText !== undefined && newText !== undefined) {
      const replaceAll = firstBoolValue(record, ['replace_all', 'replaceAll']);
      return {
        kind: 'edit',
        path,
        oldText,
        newText,
        ...(replaceAll === true ? { replaceAll: true } : {}),
      };
    }
    if (oldText === undefined) {
      const content = firstStringValue(record, [
        'content',
        'contents',
        'contentsAfterEdit',
        'contents_after_edit',
        'file_text',
        'new_content',
        'newContent',
      ]);
      if (content !== undefined) return { kind: 'write', path, content };
    }
    return undefined;
  }

  if (PATCH_ALIASES.has(key)) {
    const patch = rawString ?? (record ? firstStringValue(record, ['input', 'patch', 'patchText']) : undefined);
    if (patch === undefined || !patch.includes('*** Begin Patch')) return undefined;
    return { kind: 'patch', patch };
  }

  if (GREP_ALIASES.has(key)) {
    if (!record) return undefined;
    const pattern = firstNonEmptyString(record, ['pattern', 'query', 'regex']);
    if (pattern === undefined) return undefined;
    const path = firstNonEmptyString(record, ['path', 'directory', 'target_directory', 'targetDirectory']);
    const glob = firstNonEmptyString(record, ['glob', 'include']);
    const caseInsensitive = firstBoolValue(record, ['-i', 'case_insensitive', 'caseInsensitive']);
    const outputMode = normalizeGrepOutputMode(firstNonEmptyString(record, ['output_mode', 'outputMode']));
    return {
      kind: 'grep',
      pattern,
      ...(path !== undefined ? { path } : {}),
      ...(glob !== undefined ? { glob } : {}),
      ...(caseInsensitive === true ? { caseInsensitive: true } : {}),
      ...(outputMode !== undefined ? { outputMode } : {}),
    };
  }

  if (GLOB_ALIASES.has(key)) {
    if (!record) return undefined;
    const pattern = firstNonEmptyString(record, ['pattern', 'glob_pattern', 'globPattern']);
    if (pattern === undefined) return undefined;
    const path = firstNonEmptyString(record, ['path', 'target_directory', 'targetDirectory']);
    return {
      kind: 'glob',
      pattern,
      ...(path !== undefined ? { path } : {}),
    };
  }

  if (LIST_ALIASES.has(key)) {
    const path = (record ? firstNonEmptyString(record, ['path', 'target_directory', 'targetDirectory', 'directory', 'dir']) : undefined) ?? '.';
    return { kind: 'list', path };
  }

  if (TODO_ALIASES.has(key)) {
    if (!record) return undefined;
    const rawTodos = record.todos ?? record.items ?? record.plan;
    if (!Array.isArray(rawTodos)) return undefined;
    const todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> = [];
    for (const item of rawTodos) {
      if (isRecord(item)) {
        const content = firstNonEmptyString(item, ['content', 'step', 'title', 'text']);
        if (content === undefined) continue;
        todos.push({ content, status: normalizeTodoStatus(item.status) });
      } else if (typeof item === 'string' && item.trim().length > 0) {
        todos.push({ content: item, status: 'pending' });
      }
    }
    if (rawTodos.length > 0 && todos.length === 0) return undefined;
    return { kind: 'todo', todos };
  }

  return undefined;
}

function codexReadCommand(path: string, offset?: number, limit?: number): string {
  const quoted = shellQuote(path);
  if (offset === undefined && limit === undefined) return 'cat ' + quoted;
  const start = offset !== undefined && offset >= 1 ? Math.trunc(offset) : 1;
  if (limit !== undefined && limit >= 1) {
    const end = start + Math.trunc(limit) - 1;
    return `sed -n '${start},${end}p' ` + quoted;
  }
  return `sed -n '${start},$p' ` + quoted;
}

function renderPatchLines(text: string, prefix: '+' | '-'): string[] {
  return text.split(/\r?\n/).map((line) => prefix + line);
}

function grepInputFields(tool: Extract<CanonicalTool, { kind: 'grep' }>): Record<string, unknown> {
  return {
    pattern: tool.pattern,
    ...(tool.path !== undefined ? { path: tool.path } : {}),
    ...(tool.glob !== undefined ? { glob: tool.glob } : {}),
    ...(tool.outputMode !== undefined ? { output_mode: tool.outputMode } : {}),
    ...(tool.caseInsensitive === true ? { '-i': true } : {}),
  };
}

export function renderTool(target: ToolRenderTarget, tool: CanonicalTool): RenderedTool | undefined {
  switch (target) {
    case 'claude-code':
    case 'qoder':
      switch (tool.kind) {
        case 'shell':
          return {
            name: 'Bash',
            input: {
              command: tool.command,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              ...(tool.timeoutMs !== undefined ? { timeout: tool.timeoutMs } : {}),
            },
          };
        case 'read':
          return {
            name: 'Read',
            input: {
              file_path: tool.path,
              ...(tool.offset !== undefined ? { offset: tool.offset } : {}),
              ...(tool.limit !== undefined ? { limit: tool.limit } : {}),
            },
          };
        case 'write':
          return { name: 'Write', input: { file_path: tool.path, content: tool.content } };
        case 'edit':
          return {
            name: 'Edit',
            input: {
              file_path: tool.path,
              old_string: tool.oldText,
              new_string: tool.newText,
              ...(tool.replaceAll === true ? { replace_all: true } : {}),
            },
          };
        case 'grep':
          return { name: 'Grep', input: grepInputFields(tool) };
        case 'glob':
          return {
            name: 'Glob',
            input: {
              pattern: tool.pattern,
              ...(tool.path !== undefined ? { path: tool.path } : {}),
            },
          };
        case 'list':
          return { name: 'Bash', input: { command: 'ls -la ' + shellQuote(tool.path) } };
        case 'todo':
          return {
            name: 'TodoWrite',
            input: { todos: tool.todos.map((item) => ({ content: item.content, status: item.status, activeForm: item.content })) },
          };
        case 'patch':
          return undefined;
      }

    case 'command-code':
      switch (tool.kind) {
        case 'shell':
          return {
            name: 'shell_command',
            input: {
              command: tool.command,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              ...(tool.timeoutMs !== undefined ? { timeout: tool.timeoutMs } : {}),
            },
          };
        case 'read':
          return {
            name: 'read_file',
            input: {
              file_path: tool.path,
              ...(tool.offset !== undefined ? { offset: tool.offset } : {}),
              ...(tool.limit !== undefined ? { limit: tool.limit } : {}),
            },
          };
        case 'write':
          return { name: 'write_file', input: { file_path: tool.path, content: tool.content } };
        case 'edit':
          return {
            name: 'edit_file',
            input: {
              file_path: tool.path,
              old_string: tool.oldText,
              new_string: tool.newText,
              ...(tool.replaceAll === true ? { replace_all: true } : {}),
            },
          };
        case 'grep':
          return { name: 'grep', input: grepInputFields(tool) };
        case 'list':
          return { name: 'read_directory', input: { path: tool.path } };
        case 'todo':
          return { name: 'todo_write', input: { todos: tool.todos } };
        case 'glob':
        case 'patch':
          return undefined;
      }

    case 'codex':
      switch (tool.kind) {
        case 'shell':
          return {
            name: 'exec_command',
            input: {
              cmd: tool.command,
              ...(tool.cwd !== undefined ? { workdir: tool.cwd } : {}),
            },
          };
        case 'read':
          return { name: 'exec_command', input: { cmd: codexReadCommand(tool.path, tool.offset, tool.limit) } };
        case 'grep':
          return {
            name: 'exec_command',
            input: {
              cmd:
                'rg -n' +
                (tool.caseInsensitive === true ? ' -i' : '') +
                (tool.glob !== undefined ? ' -g ' + shellQuote(tool.glob) : '') +
                ' ' +
                shellQuote(tool.pattern) +
                (tool.path !== undefined ? ' ' + shellQuote(tool.path) : ''),
            },
          };
        case 'glob':
          return {
            name: 'exec_command',
            input: {
              cmd:
                'rg --files' +
                (tool.path !== undefined ? ' ' + shellQuote(tool.path) : '') +
                ' -g ' +
                shellQuote(tool.pattern),
            },
          };
        case 'list':
          return { name: 'exec_command', input: { cmd: 'ls -la ' + shellQuote(tool.path) } };
        case 'write': {
          const added = tool.content.length === 0 ? [] : renderPatchLines(tool.content, '+');
          return {
            name: 'apply_patch',
            custom: true,
            input: ['*** Begin Patch', '*** Add File: ' + tool.path, ...added, '*** End Patch'].join('\n'),
          };
        }
        case 'edit':
          return {
            name: 'apply_patch',
            custom: true,
            input: [
              '*** Begin Patch',
              '*** Update File: ' + tool.path,
              '@@',
              ...renderPatchLines(tool.oldText, '-'),
              ...renderPatchLines(tool.newText, '+'),
              '*** End Patch',
            ].join('\n'),
          };
        case 'patch':
          return { name: 'apply_patch', custom: true, input: tool.patch };
        case 'todo':
          return {
            name: 'update_plan',
            input: { plan: tool.todos.map((item) => ({ step: item.content, status: item.status })) },
          };
      }

    case 'opencode':
      switch (tool.kind) {
        case 'shell':
          return {
            name: 'bash',
            input: {
              command: tool.command,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              ...(tool.timeoutMs !== undefined ? { timeout: tool.timeoutMs } : {}),
            },
          };
        case 'read':
          return {
            name: 'read',
            input: {
              filePath: tool.path,
              ...(tool.offset !== undefined ? { offset: tool.offset } : {}),
              ...(tool.limit !== undefined ? { limit: tool.limit } : {}),
            },
          };
        case 'write':
          return { name: 'write', input: { filePath: tool.path, content: tool.content } };
        case 'edit':
          return {
            name: 'edit',
            input: {
              filePath: tool.path,
              oldString: tool.oldText,
              newString: tool.newText,
              ...(tool.replaceAll === true ? { replaceAll: true } : {}),
            },
          };
        case 'grep':
          return {
            name: 'grep',
            input: {
              pattern: tool.pattern,
              ...(tool.path !== undefined ? { path: tool.path } : {}),
              ...(tool.glob !== undefined ? { include: tool.glob } : {}),
            },
          };
        case 'glob':
          return {
            name: 'glob',
            input: {
              pattern: tool.pattern,
              ...(tool.path !== undefined ? { path: tool.path } : {}),
            },
          };
        case 'list':
          return { name: 'list', input: { path: tool.path } };
        case 'todo':
          return {
            name: 'todowrite',
            input: {
              todos: tool.todos.map((item, index) => ({
                id: 'todo-' + String(index + 1),
                content: item.content,
                status: item.status,
                priority: 'medium',
              })),
            },
          };
        case 'patch':
          return undefined;
      }

    case 'generic':
      switch (tool.kind) {
        case 'shell':
          return {
            name: 'shell',
            input: {
              command: tool.command,
              ...(tool.cwd !== undefined ? { cwd: tool.cwd } : {}),
              ...(tool.timeoutMs !== undefined ? { timeout: tool.timeoutMs } : {}),
              ...(tool.description !== undefined ? { description: tool.description } : {}),
            },
          };
        case 'read':
          return {
            name: 'read',
            input: {
              file_path: tool.path,
              ...(tool.offset !== undefined ? { offset: tool.offset } : {}),
              ...(tool.limit !== undefined ? { limit: tool.limit } : {}),
            },
          };
        case 'write':
          return { name: 'write', input: { file_path: tool.path, content: tool.content } };
        case 'edit':
          return {
            name: 'edit',
            input: {
              file_path: tool.path,
              old_string: tool.oldText,
              new_string: tool.newText,
              ...(tool.replaceAll === true ? { replace_all: true } : {}),
            },
          };
        case 'grep':
          return {
            name: 'grep',
            input: {
              pattern: tool.pattern,
              ...(tool.path !== undefined ? { path: tool.path } : {}),
              ...(tool.glob !== undefined ? { glob: tool.glob } : {}),
              ...(tool.caseInsensitive === true ? { '-i': true } : {}),
              ...(tool.outputMode !== undefined ? { output_mode: tool.outputMode } : {}),
            },
          };
        case 'glob':
          return {
            name: 'glob',
            input: {
              pattern: tool.pattern,
              ...(tool.path !== undefined ? { path: tool.path } : {}),
            },
          };
        case 'list':
          return { name: 'list', input: { path: tool.path } };
        case 'todo':
          return { name: 'todo', input: { todos: tool.todos } };
        case 'patch':
          return undefined;
      }
  }
}

export function isNativeToolName(target: ToolRenderTarget, name: string): boolean {
  return NATIVE_TOOL_NAMES[target].has(name);
}

export function normalizeToolCall(args: {
  target: ToolRenderTarget;
  sourceAgent: string;
  name: string;
  input: unknown;
  enabled?: boolean;
}): NormalizeResult {
  const { target, sourceAgent, name, input, enabled } = args;
  if (enabled === false || sourceAgent === target) {
    return { name, input, status: 'skipped' };
  }
  if (isNativeToolName(target, name)) {
    return { name, input, status: 'native' };
  }
  const canonical = classifyTool(name, input);
  const rendered = canonical === undefined ? undefined : renderTool(target, canonical);
  if (rendered !== undefined) {
    return {
      name: rendered.name,
      input: rendered.input,
      ...(rendered.custom === true ? { custom: true } : {}),
      status: 'normalized',
    };
  }
  return { name, input, status: 'unmapped' };
}
