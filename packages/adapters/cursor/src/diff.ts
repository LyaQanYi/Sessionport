/**
 * Cursor `edit_file_v2` 的 diff 表示：`additionalData.precomputedDiff`。
 *
 * 真实样本（Cursor 3.25.9 / state.vscdb）里的形状：
 *
 *   precomputedDiff = {
 *     lines: [
 *       { type: "added",     content, modifiedLineNumber },              // originalLineNumber 省略
 *       { type: "removed",   content, originalLineNumber },              // modifiedLineNumber 省略
 *       { type: "unchanged", content, originalLineNumber, modifiedLineNumber },
 *       // 跨 hunk 的空隙由 app 用空 content + isSyntheticUnchanged:true 补齐
 *     ],
 *     hasChanges: boolean,
 *   }
 *
 * app 自己没有 before/after 全文时，会从 `diffString` 走
 * `editToolDiffFallback.js`（bFo / rZ_ / iZ_ / bGh）生成这个对象，UI 直接按
 * precomputedDiff 渲染 diff 卡片，不需要 beforeContentId/afterContentId。
 *
 * 本文件实现同一套解析规则（hunk 起止行号、跨 hunk 空隙补齐、无 hunk 的裸
 * +/- diff），以及读取方向的反向生成（precomputedDiff → 统一 diff 文本）。
 * 零依赖。
 */
import { isRecord } from './wire.ts';

export type CursorDiffLineType = 'added' | 'removed' | 'unchanged';

export interface CursorDiffLine {
  type: CursorDiffLineType;
  content: string;
  /** removed / unchanged 在原文件中的行号 */
  originalLineNumber?: number;
  /** added / unchanged 在新文件中的行号 */
  modifiedLineNumber?: number;
  /** 跨 hunk 空隙补出来的空行（app 的 nZ_ 行为），不参与 hasChanges */
  isSyntheticUnchanged?: boolean;
  /** 原生样本里可能还有 inlineChanges / *TokenLineNumber 等 UI 字段，读取时保留 */
  [key: string]: unknown;
}

export interface CursorPrecomputedDiff {
  lines: CursorDiffLine[];
  hasChanges: boolean;
  [key: string]: unknown;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkStart(start: number, count: number | undefined): number {
  // 与 app 的 tZ_ 一致：长度为 0 的区间表示“插入点”，起始行 +1。
  return count === 0 ? start + 1 : start;
}

function isDiffMetaLine(line: string): boolean {
  return (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  );
}

function pushSyntheticGap(
  lines: CursorDiffLine[],
  lastOriginal: number | undefined,
  lastModified: number | undefined,
  nextOriginal: number,
  nextModified: number,
): { lastOriginal: number | undefined; lastModified: number | undefined } {
  // 与 app 的 nZ_ 一致：只有前后 hunk 的空隙行数相等且 > 0 才补；
  // 不相等时只把游标推进到下一 hunk 前一行，避免生成错的空行。
  if (lastOriginal === undefined || lastModified === undefined) {
    return { lastOriginal, lastModified };
  }
  const originalGap = nextOriginal - lastOriginal - 1;
  const modifiedGap = nextModified - lastModified - 1;
  if (originalGap <= 0 || originalGap !== modifiedGap) {
    return {
      lastOriginal: Math.max(lastOriginal, nextOriginal - 1),
      lastModified: Math.max(lastModified, nextModified - 1),
    };
  }
  for (let offset = 1; offset <= originalGap; offset += 1) {
    lines.push({
      type: 'unchanged',
      content: '',
      originalLineNumber: lastOriginal + offset,
      modifiedLineNumber: lastModified + offset,
      isSyntheticUnchanged: true,
    });
  }
  return { lastOriginal: nextOriginal - 1, lastModified: nextModified - 1 };
}

function parseHunkDiff(rawLines: string[]): CursorDiffLine[] {
  const lines: CursorDiffLine[] = [];
  let inHunk = false;
  let sawHunk = false;
  let originalLine = 1;
  let modifiedLine = 1;
  let lastOriginal: number | undefined;
  let lastModified: number | undefined;

  for (const rawLine of rawLines) {
    if (rawLine.startsWith('@@')) {
      const match = HUNK_HEADER.exec(rawLine);
      if (match === null) {
        inHunk = false;
        continue;
      }
      sawHunk = true;
      inHunk = true;
      const originalStart = hunkStart(Number(match[1]), match[2] === undefined ? 1 : Number(match[2]));
      const modifiedStart = hunkStart(Number(match[3]), match[4] === undefined ? 1 : Number(match[4]));
      const gap = pushSyntheticGap(lines, lastOriginal, lastModified, originalStart, modifiedStart);
      lastOriginal = gap.lastOriginal;
      lastModified = gap.lastModified;
      originalLine = originalStart;
      modifiedLine = modifiedStart;
      continue;
    }

    // 一个 diff 文本里出现多个文件时，app 的 rZ_ 会在 diff/index 行退出 hunk；
    // 我们只解析第一个文件（上层会提示多文件 diff 只映射第一段）。
    if (inHunk && (rawLine.startsWith('diff ') || rawLine.startsWith('index '))) {
      inHunk = false;
    }
    if (!inHunk || rawLine.startsWith('\\ No newline at end of file')) continue;

    const marker = rawLine.length > 0 ? rawLine.charAt(0) : ' ';
    const content = rawLine.length > 0 ? rawLine.slice(1) : '';
    switch (marker) {
      case '+':
        lines.push({ type: 'added', content, modifiedLineNumber: modifiedLine });
        lastModified = modifiedLine;
        modifiedLine += 1;
        break;
      case '-':
        lines.push({ type: 'removed', content, originalLineNumber: originalLine });
        lastOriginal = originalLine;
        originalLine += 1;
        break;
      case ' ':
        lines.push({
          type: 'unchanged',
          content,
          originalLineNumber: originalLine,
          modifiedLineNumber: modifiedLine,
        });
        lastOriginal = originalLine;
        lastModified = modifiedLine;
        originalLine += 1;
        modifiedLine += 1;
        break;
      default:
        // app 的 rZ_ 对不带 +/-/空格前缀的行按 unchanged 处理（content 保留整行）。
        lines.push({
          type: 'unchanged',
          content: rawLine,
          originalLineNumber: originalLine,
          modifiedLineNumber: modifiedLine,
        });
        lastOriginal = originalLine;
        lastModified = modifiedLine;
        originalLine += 1;
        modifiedLine += 1;
        break;
    }
  }

  return sawHunk ? lines : [];
}

function parseBareDiff(rawLines: string[]): CursorDiffLine[] {
  // 与 app 的 iZ_ 一致：没有 @@ 时从第 1 行开始，按 +/-/空格 逐行解析。
  const lines: CursorDiffLine[] = [];
  let originalLine = 1;
  let modifiedLine = 1;
  for (const rawLine of rawLines) {
    if (
      rawLine.startsWith('\\ No newline at end of file') ||
      rawLine.startsWith('@@') ||
      isDiffMetaLine(rawLine)
    ) {
      continue;
    }
    const marker = rawLine.length > 0 ? rawLine.charAt(0) : ' ';
    const content = rawLine.length > 0 ? rawLine.slice(1) : '';
    switch (marker) {
      case '+':
        lines.push({ type: 'added', content, modifiedLineNumber: modifiedLine });
        modifiedLine += 1;
        break;
      case '-':
        lines.push({ type: 'removed', content, originalLineNumber: originalLine });
        originalLine += 1;
        break;
      case ' ':
        lines.push({
          type: 'unchanged',
          content,
          originalLineNumber: originalLine,
          modifiedLineNumber: modifiedLine,
        });
        originalLine += 1;
        modifiedLine += 1;
        break;
      default:
        lines.push({
          type: 'unchanged',
          content: rawLine,
          originalLineNumber: originalLine,
          modifiedLineNumber: modifiedLine,
        });
        originalLine += 1;
        modifiedLine += 1;
        break;
    }
  }
  return lines;
}

/** 多文件 diff（diff --git）只取第一段；上层会记录多文件降级。 */
function firstDiffFile(text: string): string {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith('diff --git ')) starts.push(index);
  }
  if (starts.length <= 1) return text;
  return lines.slice(starts[0], starts[1]).join('\n');
}

/**
 * 解析统一 diff 文本 → Cursor precomputedDiff。
 *
 * - 标准 `@@ -a,b +c,d @@` hunk；
 * - 无 hunk 的裸 +/- diff（app 的 iZ_ 兜底）；
 * - 跨 hunk 空隙按 app 的 nZ_ 补 `isSyntheticUnchanged` 空行；
 * - 空文本 / 没有可解析行 → undefined。
 */
export function parseUnifiedDiff(text: string): CursorPrecomputedDiff | undefined {
  if (text.trim().length === 0) return undefined;
  const rawLines = firstDiffFile(text).split(/\r?\n/);
  let lines = parseHunkDiff(rawLines);
  if (lines.length === 0) lines = parseBareDiff(rawLines);
  if (lines.length === 0) return undefined;
  return {
    lines,
    hasChanges: lines.some((line) => line.type !== 'unchanged'),
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 校验 precomputedDiff 形状；返回错误列表（空 = 合法）。
 * 只校验 UI 渲染必需字段，额外字段（inlineChanges 等）原样允许。
 */
export function validateCursorPrecomputedDiff(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['precomputedDiff 不是对象'];
  if (!Array.isArray(value.lines)) return ['precomputedDiff.lines 不是数组'];
  if (typeof value.hasChanges !== 'boolean') errors.push('precomputedDiff.hasChanges 不是布尔值');

  let changed = false;
  value.lines.forEach((line, index) => {
    const label = 'lines[' + String(index) + ']';
    if (!isRecord(line)) {
      errors.push(label + ' 不是对象');
      return;
    }
    if (line.type !== 'added' && line.type !== 'removed' && line.type !== 'unchanged') {
      errors.push(label + '.type 非法: ' + String(line.type));
      return;
    }
    if (typeof line.content !== 'string') errors.push(label + '.content 不是字符串');
    if (line.type === 'added') {
      changed = true;
      if (!positiveInteger(line.modifiedLineNumber)) errors.push(label + '.modifiedLineNumber 缺失');
      if (line.originalLineNumber !== undefined) errors.push(label + ' 是 added 但有 originalLineNumber');
    } else if (line.type === 'removed') {
      changed = true;
      if (!positiveInteger(line.originalLineNumber)) errors.push(label + '.originalLineNumber 缺失');
      if (line.modifiedLineNumber !== undefined) errors.push(label + ' 是 removed 但有 modifiedLineNumber');
    } else {
      if (!positiveInteger(line.originalLineNumber)) errors.push(label + '.originalLineNumber 缺失');
      if (!positiveInteger(line.modifiedLineNumber)) errors.push(label + '.modifiedLineNumber 缺失');
    }
  });

  if (typeof value.hasChanges === 'boolean' && value.hasChanges !== changed) {
    errors.push('hasChanges=' + String(value.hasChanges) + ' 与实际增删行不一致');
  }
  return errors;
}

export function isCursorPrecomputedDiff(value: unknown): value is CursorPrecomputedDiff {
  return validateCursorPrecomputedDiff(value).length === 0;
}

const UNIFIED_CONTEXT_LINES = 3;

interface PositionedDiffLine {
  line: CursorDiffLine;
  oldLine: number | undefined;
  newLine: number | undefined;
  changed: boolean;
  synthetic: boolean;
  usableContext: boolean;
}

function positionLines(lines: CursorDiffLine[]): PositionedDiffLine[] {
  return lines.map((line) => {
    const oldLine = positiveInteger(line.originalLineNumber) ? line.originalLineNumber : undefined;
    const newLine = positiveInteger(line.modifiedLineNumber) ? line.modifiedLineNumber : undefined;
    const synthetic = line.isSyntheticUnchanged === true;
    return {
      line,
      oldLine,
      newLine,
      changed: line.type !== 'unchanged',
      synthetic,
      usableContext: line.type === 'unchanged' && !synthetic && oldLine !== undefined && newLine !== undefined,
    };
  });
}

function lastNumberBefore(
  entries: PositionedDiffLine[],
  index: number,
  key: 'oldLine' | 'newLine',
): number | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = entries[cursor]?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * precomputedDiff → 统一 diff 文本（读取方向）。
 *
 * 每个连续变更块保留最多 3 行真实 context；`isSyntheticUnchanged` 的空隙
 * 不写进文本（它本来就是为了压缩显示补出来的空行），因此多个变更块会拆成
 * 多个 hunk。没有变更行时返回 undefined。
 */
export function precomputedDiffToUnifiedDiff(diff: CursorPrecomputedDiff): string | undefined {
  const entries = positionLines(diff.lines);
  if (!entries.some((entry) => entry.changed)) return undefined;

  const clusters: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (!entries[index]?.changed) continue;
    const previous = clusters[clusters.length - 1];
    if (previous !== undefined) {
      const gapStart = previous.end + 1;
      let mergeable = true;
      for (let cursor = gapStart; cursor < index; cursor += 1) {
        if (entries[cursor]?.synthetic === true) {
          mergeable = false;
          break;
        }
      }
      if (mergeable && index - previous.end - 1 <= UNIFIED_CONTEXT_LINES * 2) {
        previous.end = index;
        continue;
      }
    }
    clusters.push({ start: index, end: index });
  }

  const hunks: string[] = [];
  for (const cluster of clusters) {
    let start = cluster.start;
    let end = cluster.end;
    for (let count = 0; count < UNIFIED_CONTEXT_LINES && start > 0; count += 1) {
      if (!entries[start - 1]?.usableContext) break;
      start -= 1;
    }
    for (let count = 0; count < UNIFIED_CONTEXT_LINES && end + 1 < entries.length; count += 1) {
      if (!entries[end + 1]?.usableContext) break;
      end += 1;
    }

    const range = entries.slice(start, end + 1);
    const firstOld = range.find((entry) => entry.oldLine !== undefined)?.oldLine;
    const firstNew = range.find((entry) => entry.newLine !== undefined)?.newLine;
    const oldStart = firstOld ?? lastNumberBefore(entries, start, 'oldLine') ?? 0;
    const newStart = firstNew ?? lastNumberBefore(entries, start, 'newLine') ?? 0;
    const oldCount = range.filter((entry) => entry.line.type !== 'added').length;
    const newCount = range.filter((entry) => entry.line.type !== 'removed').length;

    const body: string[] = [];
    for (const entry of range) {
      if (entry.synthetic) continue;
      const prefix = entry.line.type === 'added' ? '+' : entry.line.type === 'removed' ? '-' : ' ';
      body.push(prefix + entry.line.content);
    }
    hunks.push(
      '@@ -' + String(oldStart) + ',' + String(oldCount) + ' +' + String(newStart) + ',' + String(newCount) + ' @@',
    );
    hunks.push(...body);
  }
  return hunks.join('\n');
}
