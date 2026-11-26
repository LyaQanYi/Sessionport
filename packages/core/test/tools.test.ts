import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTool,
  isNativeToolName,
  normalizeToolCall,
  normalizeToolKey,
  renderTool,
  shellQuote,
} from '../src/index.ts';

test('normalizeToolKey 与 shellQuote', () => {
  assert.equal(normalizeToolKey(' Exec_Command-V2 '), 'execcommandv2');
  assert.equal(shellQuote("it's/a path"), "'it'\\''s/a path'");
});

test('classifyTool：覆盖 9 种 CanonicalTool', () => {
  assert.deepEqual(classifyTool('Bash', { command: 'npm test', description: 'run tests', timeout: 5000 }), {
    kind: 'shell',
    command: 'npm test',
    description: 'run tests',
    timeoutMs: 5000,
  });
  assert.deepEqual(classifyTool('exec_command', { cmd: 'git status', workdir: '/repo' }), {
    kind: 'shell',
    command: 'git status',
    cwd: '/repo',
  });
  assert.deepEqual(classifyTool('shell', { command: ['bash', '-lc', 'ls -la'] }), {
    kind: 'shell',
    command: 'ls -la',
  });
  assert.deepEqual(classifyTool('Read', { file_path: 'src/a.ts', offset: 10, limit: 20 }), {
    kind: 'read',
    path: 'src/a.ts',
    offset: 10,
    limit: 20,
  });
  assert.deepEqual(classifyTool('Write', { file_path: 'new.txt', content: 'hello' }), {
    kind: 'write',
    path: 'new.txt',
    content: 'hello',
  });
  assert.deepEqual(classifyTool('Edit', { file_path: 'a.ts', old_string: 'old', new_string: 'new', replace_all: true }), {
    kind: 'edit',
    path: 'a.ts',
    oldText: 'old',
    newText: 'new',
    replaceAll: true,
  });
  assert.deepEqual(
    classifyTool('edit', { filePath: 'b.ts', oldString: 'x', newString: 'y' }),
    { kind: 'edit', path: 'b.ts', oldText: 'x', newText: 'y' },
  );
  assert.deepEqual(
    classifyTool('edit_file_v2', { relativeWorkspacePath: 'c.ts', contentsAfterEdit: 'full' }),
    { kind: 'write', path: 'c.ts', content: 'full' },
  );
  const patch = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch';
  assert.deepEqual(classifyTool('apply_patch', patch), { kind: 'patch', patch });
  assert.deepEqual(classifyTool('Grep', { pattern: 'TODO', path: 'src', glob: '*.ts', '-i': true, output_mode: 'files_with_matches' }), {
    kind: 'grep',
    pattern: 'TODO',
    path: 'src',
    glob: '*.ts',
    caseInsensitive: true,
    outputMode: 'files_with_matches',
  });
  assert.deepEqual(classifyTool('Glob', { pattern: '**/*.ts', path: 'packages' }), {
    kind: 'glob',
    pattern: '**/*.ts',
    path: 'packages',
  });
  assert.deepEqual(classifyTool('ls', {}), { kind: 'list', path: '.' });
  assert.deepEqual(classifyTool('read_directory', { path: 'packages' }), { kind: 'list', path: 'packages' });
  assert.deepEqual(classifyTool('update_plan', { plan: [{ step: 'step 1', status: 'in_progress' }, { step: 'step 2', status: 'done' }] }), {
    kind: 'todo',
    todos: [
      { content: 'step 1', status: 'in_progress' },
      { content: 'step 2', status: 'completed' },
    ],
  });
});

test('classifyTool：歧义名与缺必填字段返回 undefined', () => {
  assert.equal(classifyTool('search', { pattern: 'x' }), undefined);
  assert.equal(classifyTool('MultiEdit', { file_path: 'a.ts', edits: [] }), undefined);
  assert.equal(classifyTool('Bash', {}), undefined);
  assert.equal(classifyTool('Read', { offset: 1 }), undefined);
  assert.equal(classifyTool('Write', { file_path: 'a.ts' }), undefined);
  assert.equal(classifyTool('Edit', { file_path: 'a.ts', old_string: 'x' }), undefined);
  assert.equal(classifyTool('apply_patch', 'not a patch'), undefined);
});

test('renderTool：三个目标端快照与 codex edit apply_patch 精确断言', () => {
  const editTool = classifyTool('Edit', { file_path: 'src/app.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;\nconst b = 20;' })!;
  assert.deepEqual(renderTool('claude-code', editTool), {
    name: 'Edit',
    input: { file_path: 'src/app.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;\nconst b = 20;' },
  });
  assert.deepEqual(renderTool('opencode', editTool), {
    name: 'edit',
    input: { filePath: 'src/app.ts', oldString: 'const a = 1;\nconst b = 2;', newString: 'const a = 10;\nconst b = 20;' },
  });
  assert.deepEqual(renderTool('codex', editTool), {
    name: 'apply_patch',
    custom: true,
    input: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1;\n-const b = 2;\n+const a = 10;\n+const b = 20;\n*** End Patch',
  });

  const readTool = classifyTool('Read', { file_path: "dir/it's.ts", offset: 10, limit: 5 })!;
  assert.deepEqual(renderTool('codex', readTool), {
    name: 'exec_command',
    input: { cmd: "sed -n '10,14p' 'dir/it'\\''s.ts'" },
  });
  assert.deepEqual(renderTool('opencode', readTool), {
    name: 'read',
    input: { filePath: "dir/it's.ts", offset: 10, limit: 5 },
  });

  const todoTool = classifyTool('update_plan', { plan: [{ step: 'do it', status: 'in_progress' }] })!;
  assert.deepEqual(renderTool('claude-code', todoTool), {
    name: 'TodoWrite',
    input: { todos: [{ content: 'do it', status: 'in_progress', activeForm: 'do it' }] },
  });
  assert.deepEqual(renderTool('opencode', todoTool), {
    name: 'todowrite',
    input: { todos: [{ id: 'todo-1', content: 'do it', status: 'in_progress', priority: 'medium' }] },
  });

  assert.deepEqual(renderTool('command-code', editTool), {
    name: 'edit_file',
    input: { file_path: 'src/app.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;\nconst b = 20;' },
  });
  assert.deepEqual(renderTool('command-code', classifyTool('Bash', { command: 'pwd' })!), {
    name: 'shell_command',
    input: { command: 'pwd' },
  });
  assert.deepEqual(renderTool('command-code', classifyTool('ls', { path: 'src' })!), {
    name: 'read_directory',
    input: { path: 'src' },
  });
  assert.equal(renderTool('command-code', classifyTool('Glob', { pattern: '*.ts' })!), undefined);
  assert.deepEqual(renderTool('qoder', classifyTool('exec_command', { cmd: 'pwd' })!), {
    name: 'Bash',
    input: { command: 'pwd' },
  });
  assert.equal(isNativeToolName('qoder', 'Bash'), true);
  assert.equal(isNativeToolName('command-code', 'shell_command'), true);
});

test('normalizeToolCall：skipped / native / normalized / unmapped 四路径', () => {
  assert.deepEqual(
    normalizeToolCall({ target: 'claude-code', sourceAgent: 'codex', name: 'exec_command', input: { cmd: 'ls' }, enabled: false }),
    { name: 'exec_command', input: { cmd: 'ls' }, status: 'skipped' },
  );
  assert.deepEqual(
    normalizeToolCall({ target: 'claude-code', sourceAgent: 'claude-code', name: 'exec_command', input: { cmd: 'ls' } }),
    { name: 'exec_command', input: { cmd: 'ls' }, status: 'skipped' },
  );
  assert.equal(isNativeToolName('claude-code', 'Bash'), true);
  assert.deepEqual(
    normalizeToolCall({ target: 'claude-code', sourceAgent: 'dsh', name: 'Bash', input: { command: 'ls' } }),
    { name: 'Bash', input: { command: 'ls' }, status: 'native' },
  );
  assert.deepEqual(
    normalizeToolCall({ target: 'claude-code', sourceAgent: 'codex', name: 'exec_command', input: { cmd: 'ls' } }),
    { name: 'Bash', input: { command: 'ls' }, status: 'normalized' },
  );
  assert.deepEqual(
    normalizeToolCall({ target: 'claude-code', sourceAgent: 'codex', name: 'exec', input: 'console.log(1)' }),
    { name: 'exec', input: 'console.log(1)', status: 'unmapped' },
  );
});
