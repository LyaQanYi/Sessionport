import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCursorPrecomputedDiff,
  parseUnifiedDiff,
  precomputedDiffToUnifiedDiff,
  validateCursorPrecomputedDiff,
} from '../src/index.ts';
import type { CursorPrecomputedDiff } from '../src/index.ts';

const MULTI_HUNK = [
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  ' a',
  '-b',
  '+c',
  '@@ -10,2 +10,3 @@',
  ' j',
  '+k',
  ' l',
].join('\n');

test('parseUnifiedDiff：hunk 行号、跨 hunk 空隙补 isSyntheticUnchanged', () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK);
  assert.ok(parsed !== undefined);
  assert.equal(parsed.hasChanges, true);
  // 3 行 hunk1 + 7 行空隙 + 3 行 hunk2
  assert.equal(parsed.lines.length, 13);
  assert.deepEqual(parsed.lines[0], {
    type: 'unchanged',
    content: 'a',
    originalLineNumber: 1,
    modifiedLineNumber: 1,
  });
  assert.deepEqual(parsed.lines[1], { type: 'removed', content: 'b', originalLineNumber: 2 });
  assert.deepEqual(parsed.lines[2], { type: 'added', content: 'c', modifiedLineNumber: 2 });
  assert.deepEqual(parsed.lines[3], {
    type: 'unchanged',
    content: '',
    originalLineNumber: 3,
    modifiedLineNumber: 3,
    isSyntheticUnchanged: true,
  });
  assert.equal(parsed.lines[9]?.isSyntheticUnchanged, true);
  assert.deepEqual(parsed.lines[10], {
    type: 'unchanged',
    content: 'j',
    originalLineNumber: 10,
    modifiedLineNumber: 10,
  });
  assert.deepEqual(parsed.lines[11], { type: 'added', content: 'k', modifiedLineNumber: 11 });
  assert.deepEqual(parsed.lines[12], {
    type: 'unchanged',
    content: 'l',
    originalLineNumber: 11,
    modifiedLineNumber: 12,
  });
});

test('parseUnifiedDiff：没有 @@ 的裸 +/- diff 也能解析；空文本返回 undefined', () => {
  const parsed = parseUnifiedDiff('+one\n two\n-three');
  assert.ok(parsed !== undefined);
  assert.deepEqual(parsed.lines, [
    { type: 'added', content: 'one', modifiedLineNumber: 1 },
    { type: 'unchanged', content: 'two', originalLineNumber: 1, modifiedLineNumber: 2 },
    { type: 'removed', content: 'three', originalLineNumber: 2 },
  ]);
  assert.equal(parseUnifiedDiff(''), undefined);
  assert.equal(parseUnifiedDiff('   '), undefined);
  assert.equal(parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts'), undefined);
});

test('validateCursorPrecomputedDiff：必需行号 / hasChanges 一致性', () => {
  const valid: CursorPrecomputedDiff = {
    lines: [
      { type: 'unchanged', content: 'a', originalLineNumber: 1, modifiedLineNumber: 1 },
      { type: 'removed', content: 'b', originalLineNumber: 2 },
      { type: 'added', content: 'c', modifiedLineNumber: 2 },
    ],
    hasChanges: true,
  };
  assert.deepEqual(validateCursorPrecomputedDiff(valid), []);
  assert.equal(isCursorPrecomputedDiff(valid), true);
  assert.equal(isCursorPrecomputedDiff({ lines: [], hasChanges: false }), true);

  const missingModified = {
    lines: [{ type: 'added', content: 'x' }],
    hasChanges: true,
  };
  assert.ok(validateCursorPrecomputedDiff(missingModified).some((error) => error.includes('modifiedLineNumber')));

  const wrongHasChanges = {
    lines: [{ type: 'unchanged', content: 'a', originalLineNumber: 1, modifiedLineNumber: 1 }],
    hasChanges: true,
  };
  assert.ok(validateCursorPrecomputedDiff(wrongHasChanges).some((error) => error.includes('hasChanges')));
});

test('precomputedDiffToUnifiedDiff：变更块 + context 往返一致', () => {
  const diff: CursorPrecomputedDiff = {
    lines: [
      { type: 'unchanged', content: 'a', originalLineNumber: 1, modifiedLineNumber: 1 },
      { type: 'removed', content: 'b', originalLineNumber: 2 },
      { type: 'added', content: 'c', modifiedLineNumber: 2 },
      { type: 'unchanged', content: 'd', originalLineNumber: 3, modifiedLineNumber: 3 },
    ],
    hasChanges: true,
  };
  const text = precomputedDiffToUnifiedDiff(diff);
  assert.equal(text, ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', ' d'].join('\n'));
  assert.deepEqual(parseUnifiedDiff(text ?? ''), diff);
});

test('precomputedDiffToUnifiedDiff：synthetic 空隙拆成多个 hunk，不输出空 context 行', () => {
  const diff: CursorPrecomputedDiff = {
    lines: [
      { type: 'unchanged', content: 'a', originalLineNumber: 1, modifiedLineNumber: 1 },
      { type: 'added', content: 'b', modifiedLineNumber: 2 },
      {
        type: 'unchanged',
        content: '',
        originalLineNumber: 5,
        modifiedLineNumber: 5,
        isSyntheticUnchanged: true,
      },
      { type: 'removed', content: 'c', originalLineNumber: 6 },
      { type: 'unchanged', content: 'd', originalLineNumber: 7, modifiedLineNumber: 7 },
    ],
    hasChanges: true,
  };
  const text = precomputedDiffToUnifiedDiff(diff);
  assert.ok(text !== undefined);
  assert.match(text, /^@@ -1,1 \+1,2 @@$/m);
  assert.match(text, /^@@ -6,2 \+7,1 @@$/m);
  assert.ok(!text.split('\n').some((line) => line === ' '), text);

  const reparsed = parseUnifiedDiff(text);
  assert.ok(reparsed !== undefined);
  assert.deepEqual(
    reparsed.lines.filter((line) => line.type !== 'unchanged'),
    diff.lines.filter((line) => line.type !== 'unchanged'),
  );
});
