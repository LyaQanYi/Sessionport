import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IrContent, IrEvent, IrToolResultEvent } from '@sessionport/core';
import { readClaudeSession } from '../src/index.ts';

const SESSION_ID = 'dddddddd-1111-4111-8111-111111111111';
const TEST_CWD = '/tmp/sessionport-claude-diff';

type FixtureRow = Record<string, unknown> | string;

function jsonl(values: FixtureRow[]): string {
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') + '\n';
}

async function writeSession(root: string, rows: FixtureRow[]): Promise<string> {
  const dir = join(root, 'projects', '-tmp-sessionport-claude-diff');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, SESSION_ID + '.jsonl');
  await writeFile(filePath, jsonl(rows), 'utf8');
  return filePath;
}

function baseRows(toolUseResult: Record<string, unknown> | undefined): FixtureRow[] {
  return [
    {
      type: 'user',
      uuid: 'u1',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      version: '2.1.312',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: '改一下 app.ts' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: 'tool_edit_1', name: 'Edit', input: { file_path: TEST_CWD + '/src/app.ts' } }],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:02.000Z',
      ...(toolUseResult !== undefined ? { toolUseResult } : {}),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_edit_1', content: 'The file has been updated.' }],
      },
    },
  ];
}

function diffTexts(events: IrEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    for (const block of (event as IrToolResultEvent).content) {
      if ((block as IrContent).type === 'diff') out.push((block as { text: string }).text);
    }
  }
  return out;
}

test('Claude reader：Edit 的 toolUseResult.structuredPatch → IR diff block（仓库相对路径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-diff-'));
  try {
    const filePath = await writeSession(dir, baseRows({
      type: 'update',
      filePath: TEST_CWD + '/src/app.ts',
      oldString: 'const b = 2;',
      newString: 'const b = 3;\nconst c = 4;',
      originalFile: null,
      userModified: false,
      structuredPatch: [
        {
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 3,
          lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'],
        },
      ],
    }));
    const bundle = await readClaudeSession(filePath, { configDir: dir });
    const diffs = diffTexts(bundle.root.events);
    assert.equal(diffs.length, 1);
    assert.equal(
      diffs[0],
      ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -10,2 +10,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'].join('\n'),
    );
    // 原 tool_result 文本仍保留
    const result = bundle.root.events.find((event) => event.kind === 'tool_result') as IrToolResultEvent;
    assert.ok(result.content.some((block) => block.type === 'text' && block.text.includes('The file has been updated')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Claude reader：没有 structuredPatch 时不会凭空生成 diff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-diff-'));
  try {
    const filePath = await writeSession(dir, baseRows(undefined));
    const bundle = await readClaudeSession(filePath, { configDir: dir });
    assert.equal(diffTexts(bundle.root.events).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Claude reader：空 structuredPatch（Write 新建文件）不生成 diff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-diff-'));
  try {
    const filePath = await writeSession(dir, baseRows({
      type: 'create',
      filePath: TEST_CWD + '/src/new.ts',
      content: 'export const x = 1;',
      originalFile: null,
      structuredPatch: [],
    }));
    const bundle = await readClaudeSession(filePath, { configDir: dir });
    assert.equal(diffTexts(bundle.root.events).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
