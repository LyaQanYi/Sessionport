import assert from 'node:assert/strict';
import test from 'node:test';

import type { IrEventInput } from '@sessionport/core';

import { readCursorSession, verifyCursorSession, writeCursorSession } from '../src/index.ts';
import { closeCursorDb, openCursorDb, readDiskKvValue } from '../src/wire.ts';
import {
  assistantMessage,
  createCursorFixture,
  makeIrBundle,
  reasoningEvent,
  toolCallEvent,
  toolResultEvent,
  userMessage,
} from './helpers.ts';

const HEADER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE_MS = 1789214508000;

function at(offset: number): string {
  return new Date(BASE_MS + offset).toISOString();
}

const DIFF_TEXT = [
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' export { a, b };',
].join('\n');

function diffResultEvent(callId: string, text: string, atIso: string): IrEventInput {
  return {
    kind: 'tool_result',
    callId,
    content: [{ type: 'diff', text }],
    at: atIso,
  } as unknown as IrEventInput;
}

function headerBundle(cwd: string) {
  return makeIrBundle(
    [
      userMessage('读取并修改文件', at(0)),
      assistantMessage('先看文件。', at(1000)),
      reasoningEvent('检查结构', at(1500)),
      toolCallEvent('h-read', 'Read', { file_path: '/tmp/work/a.ts', offset: 2, limit: 10 }, at(2000)),
      toolResultEvent('h-read', 'line1\nline2', at(2100)),
      toolCallEvent('h-grep', 'Grep', { pattern: 'foo', path: '/tmp/work' }, at(3000)),
      toolResultEvent('h-grep', 'a.ts:1:foo', at(3100)),
      toolCallEvent('h-glob', 'Glob', { pattern: '**/*.ts', path: '/tmp/work' }, at(4000)),
      toolResultEvent('h-glob', './a.ts', at(4100)),
      toolCallEvent('h-ls', 'LS', { path: '/tmp/work' }, at(5000)),
      toolResultEvent('h-ls', 'a.ts', at(5100)),
      toolCallEvent('h-shell', 'Bash', { command: 'echo hi' }, at(6000)),
      toolResultEvent('h-shell', 'hi', at(6100)),
      toolCallEvent(
        'h-edit',
        'Edit',
        { file_path: '/tmp/work/a.ts', old_string: 'const b = 2;', new_string: 'const b = 3;' },
        at(7000),
      ),
      diffResultEvent('h-edit', DIFF_TEXT, at(7100)),
    ],
    { cwd, title: 'header 形状' },
  );
}

interface HeaderLike {
  bubbleId: string;
  type: number;
  createdAt?: string;
  grouping?: Record<string, unknown>;
  startedAtMs?: number;
  completedAtMs?: number;
}

function readComposer(fixture: { dbPath: string }): {
  headers: HeaderLike[];
  bubbles: Map<string, Record<string, unknown>>;
} {
  const db = openCursorDb(fixture.dbPath, { readOnly: true });
  try {
    const raw = readDiskKvValue(db, 'composerData:' + HEADER_ID);
    assert.ok(raw !== undefined);
    const headers = (JSON.parse(raw) as { fullConversationHeadersOnly: HeaderLike[] }).fullConversationHeadersOnly;
    const bubbles = new Map<string, Record<string, unknown>>();
    for (const header of headers) {
      const bubbleRaw = readDiskKvValue(db, 'bubbleId:' + HEADER_ID + ':' + header.bubbleId);
      assert.ok(bubbleRaw !== undefined);
      bubbles.set(header.bubbleId, JSON.parse(bubbleRaw) as Record<string, unknown>);
    }
    return { headers, bubbles };
  } finally {
    closeCursorDb(db);
  }
}

function toolHeader(headers: HeaderLike[], tool: number): HeaderLike {
  const found = headers.find((header) => header.grouping !== undefined && header.grouping.toolFormerTool === tool);
  assert.ok(found !== undefined, '缺 toolFormerTool=' + String(tool) + ' 的 header');
  return found;
}

test('composerData.fullConversationHeadersOnly 与气泡一一对应，grouping 按原生形状写', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const bundle = headerBundle(fixture.cwd);
    const result = await writeCursorSession(bundle, {
      home: fixture.home,
      composerId: HEADER_ID,
      backupDir: fixture.home + '/backup',
    });

    const { headers, bubbles } = readComposer(fixture);
    assert.equal(headers.length, 9);
    assert.equal(result.rows.filter((row) => row.kind === 'bubble').length, 9);
    // header 顺序 = 写入顺序；bubbleId/type/createdAt 与气泡一致
    const expectedTypes = [1, 2, 2, 2, 2, 2, 2, 2, 2];
    headers.forEach((header, index) => {
      assert.equal(header.type, expectedTypes[index]);
      const bubble = bubbles.get(header.bubbleId);
      assert.ok(bubble !== undefined);
      assert.equal(header.createdAt, bubble.createdAt);
      assert.equal(header.type, bubble.type);
    });

    const [human, ai, thinking] = headers as [HeaderLike, HeaderLike, HeaderLike];
    assert.deepEqual(human.grouping, {
      isRenderable: true,
      hasText: true,
      isShortPlainText: true,
      textPreview: '读取并修改文件',
      toolDisplayComputed: true,
    });
    assert.equal(human.startedAtMs, BASE_MS);
    assert.equal(human.completedAtMs, BASE_MS);

    assert.equal(ai.grouping?.isRenderable, true);
    assert.equal(ai.grouping?.hasText, true);
    assert.equal(ai.grouping?.isShortPlainText, true);
    assert.equal(ai.grouping?.textPreview, '先看文件。');
    assert.equal(ai.grouping?.isKeptFinalAiVisibleOutsideWorkedForGroup, true);
    assert.equal(ai.grouping?.toolDisplayComputed, true);
    assert.equal(ai.grouping?.toolFormerTool, undefined);

    assert.deepEqual(thinking.grouping, {
      isRenderable: true,
      capabilityType: 30,
      hasThinking: true,
      toolDisplayComputed: true,
    });
    assert.equal((thinking.grouping as Record<string, unknown>).hasText, undefined);

    const read = toolHeader(headers, 40);
    assert.deepEqual(read.grouping, {
      isRenderable: true,
      capabilityType: 15,
      toolFormerTool: 40,
      toolFormerStatus: 'completed',
      toolCallId: 'h-read',
      isToolGroupable: true,
      toolCallCase: 'readToolCall',
      toolDisplayPath: '/tmp/work/a.ts',
      toolDisplayComputed: true,
    });

    const grep = toolHeader(headers, 41);
    assert.equal(grep.grouping?.toolCallCase, 'grepToolCall');
    assert.equal(grep.grouping?.toolDisplayPath, '/tmp/work');
    assert.equal(grep.grouping?.isToolGroupable, true);

    const glob = toolHeader(headers, 42);
    assert.equal(glob.grouping?.toolCallCase, 'globToolCall');
    assert.equal(glob.grouping?.toolDisplayPath, undefined);
    assert.equal(glob.grouping?.isToolGroupable, true);

    const ls = toolHeader(headers, 39);
    assert.equal(ls.grouping?.toolCallCase, 'lsToolCall');
    assert.equal(ls.grouping?.toolDisplayPath, '/tmp/work');
    assert.equal(ls.grouping?.isToolGroupable, true);

    const shell = toolHeader(headers, 15);
    assert.equal(shell.grouping?.toolCallCase, 'shellToolCall');
    assert.equal(shell.grouping?.shellStatus, 'success');
    assert.equal(shell.grouping?.toolDisplayPath, undefined);
    assert.equal(shell.grouping?.isToolGroupable, undefined);

    const edit = toolHeader(headers, 38);
    assert.equal(edit.grouping?.toolCallCase, 'editToolCall');
    assert.equal(edit.grouping?.toolDisplayPath, '/tmp/work/a.ts');
    assert.equal(edit.grouping?.editLinesAdded, 1);
    assert.equal(edit.grouping?.editLinesRemoved, 1);
    assert.equal(edit.grouping?.isToolGroupable, undefined);

    const report = await verifyCursorSession({
      home: fixture.home,
      sessionId: HEADER_ID,
      skipReadback: true,
    });
    assert.deepEqual(report.checks.filter((check) => !check.ok), []);
    const names = new Set(report.checks.map((check) => check.name));
    for (const name of ['headers-count', 'headers-bubble-timestamps', 'headers-text-grouping', 'headers-tool-grouping']) {
      assert.ok(names.has(name), name);
    }

    // 读回不依赖这些 header 字段，但写出来的结构必须能被覆盖
    const readback = await readCursorSession(HEADER_ID, { home: fixture.home, includeChildren: false });
    assert.equal(readback.root.events.filter((event) => event.kind === 'tool_call').length, 6);
  } finally {
    fixture.cleanup();
  }
});

test('verify 能发现 tool header 缺少 toolCallCase / toolDisplayPath', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    await writeCursorSession(headerBundle(fixture.cwd), {
      home: fixture.home,
      composerId: HEADER_ID,
      backupDir: fixture.home + '/backup',
    });
    const db = openCursorDb(fixture.dbPath);
    try {
      const raw = readDiskKvValue(db, 'composerData:' + HEADER_ID);
      assert.ok(raw !== undefined);
      const data = JSON.parse(raw) as { fullConversationHeadersOnly: HeaderLike[] };
      const read = data.fullConversationHeadersOnly.find((entry) => entry.grouping?.toolFormerTool === 40);
      assert.ok(read !== undefined);
      if (read.grouping !== undefined) {
        delete read.grouping.toolCallCase;
        delete read.grouping.toolDisplayPath;
      }
      db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
        JSON.stringify(data),
        'composerData:' + HEADER_ID,
      );
    } finally {
      closeCursorDb(db);
    }
    const report = await verifyCursorSession({ home: fixture.home, sessionId: HEADER_ID, skipReadback: true });
    assert.equal(report.ok, false);
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    assert.ok(failed.includes('headers-tool-grouping'), failed.join(','));
  } finally {
    fixture.cleanup();
  }
});

test('verify 能发现 human/AI 文本 header 形状退化', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    await writeCursorSession(headerBundle(fixture.cwd), {
      home: fixture.home,
      composerId: HEADER_ID,
      backupDir: fixture.home + '/backup',
    });
    const db = openCursorDb(fixture.dbPath);
    try {
      const raw = readDiskKvValue(db, 'composerData:' + HEADER_ID);
      assert.ok(raw !== undefined);
      const data = JSON.parse(raw) as { fullConversationHeadersOnly: HeaderLike[] };
      const human = data.fullConversationHeadersOnly[0];
      assert.ok(human?.grouping !== undefined);
      human.grouping.hasText = false;
      const ai = data.fullConversationHeadersOnly[1];
      assert.ok(ai?.grouping !== undefined);
      delete ai.grouping.isKeptFinalAiVisibleOutsideWorkedForGroup;
      db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
        JSON.stringify(data),
        'composerData:' + HEADER_ID,
      );
    } finally {
      closeCursorDb(db);
    }
    const report = await verifyCursorSession({ home: fixture.home, sessionId: HEADER_ID, skipReadback: true });
    assert.equal(report.ok, false);
    const textCheck = report.checks.find((check) => check.name === 'headers-text-grouping');
    assert.ok(textCheck !== undefined && !textCheck.ok);
  } finally {
    fixture.cleanup();
  }
});

test('Cursor 3.27 迁移到 composerConvHeaders 分块的 header 仍能通过 verify 与读回', async () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    await writeCursorSession(headerBundle(fixture.cwd), {
      home: fixture.home,
      composerId: HEADER_ID,
      backupDir: fixture.home + '/backup',
    });
    const db = openCursorDb(fixture.dbPath);
    try {
      const raw = readDiskKvValue(db, 'composerData:' + HEADER_ID);
      assert.ok(raw !== undefined);
      const data = JSON.parse(raw) as { fullConversationHeadersOnly: HeaderLike[]; headerLog?: unknown };
      const headers = data.fullConversationHeadersOnly;
      assert.equal(headers.length, 9);
      // 模拟 3.27 首次打开：legacy 数组清空，header 搬到 composerConvHeaders:<id>:<6 位序号>
      const chunkSize = 4;
      const chunks: HeaderLike[][] = [];
      for (let index = 0; index < headers.length; index += chunkSize) {
        chunks.push(headers.slice(index, index + chunkSize));
      }
      chunks.forEach((chunk, index) => {
        db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
          'composerConvHeaders:' + HEADER_ID + ':' + String(index).padStart(6, '0'),
          JSON.stringify(chunk),
        );
      });
      data.fullConversationHeadersOnly = [];
      data.headerLog = { chunkSize, chunkCount: chunks.length, count: headers.length, generation: 'test' };
      db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
        JSON.stringify(data),
        'composerData:' + HEADER_ID,
      );
    } finally {
      closeCursorDb(db);
    }

    const report = await verifyCursorSession({ home: fixture.home, sessionId: HEADER_ID, skipReadback: true });
    assert.equal(
      report.ok,
      true,
      report.checks
        .filter((check) => !check.ok)
        .map((check) => check.name)
        .join(','),
    );
    const headerCheck = report.checks.find((check) => check.name === 'conversation-headers');
    assert.ok(headerCheck !== undefined && headerCheck.ok);
    assert.ok(headerCheck.detail?.includes('3.27'), headerCheck.detail);
    const countCheck = report.checks.find((check) => check.name === 'headers-count');
    assert.ok(countCheck?.ok, countCheck?.detail);

    // 读回也要走迁移后的 header，而不是退回 createdAt 排序
    const readback = await readCursorSession(HEADER_ID, { home: fixture.home, includeChildren: false });
    assert.equal(readback.root.events.filter((event) => event.kind === 'tool_call').length, 6);
  } finally {
    fixture.cleanup();
  }
});
