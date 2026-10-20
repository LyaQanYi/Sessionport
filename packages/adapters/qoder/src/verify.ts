import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import type { IrBundle, IrPart } from '@sessionport/core';

import { readQoderSession } from './read.ts';
import type { ReadQoderOptions } from './read.ts';
import type { WriteQoderResult } from './write.ts';
import { isQoderSessionId, parseQoderLines, qoderHome, readQoderLines, resolveQoderSessionPath, textOf } from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyQoderReport {
  ok: boolean;
  sessionId?: string;
  path?: string;
  checks: VerifyCheck[];
  bundle?: IrBundle;
}

function partsText(parts: IrPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '[image: ' + part.ref + ']')).join('\n');
}

/** 结构自检：行序列是否自洽、能不能被 Qoder 的 reader 走通 */
export function verifyQoderLines(lines: ReturnType<typeof parseQoderLines>['lines'], expectedSessionId?: string): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const sessionIds = new Set<string>();
  const uuids = new Set<string>();
  const byUuid = new Map<string, (typeof lines)[number]>();
  let duplicateUuids = 0;
  let badUuid = 0;
  let activeLeaf: string | null | undefined;
  let activeLeafLine = false;
  let toolUses = 0;
  let toolResults = 0;
  let orphanResults = 0;
  let workspace = false;
  let runtime = false;
  let user = 0;
  let assistant = 0;
  const calls = new Set<string>();
  const results = new Set<string>();
  const errors: string[] = [];

  for (const line of lines) {
    if (typeof line.sessionId === 'string') sessionIds.add(line.sessionId);
    if (typeof line.uuid === 'string') {
      if (!isQoderSessionId(line.uuid)) badUuid += 1;
      else if (uuids.has(line.uuid)) duplicateUuids += 1;
      else {
        uuids.add(line.uuid);
        byUuid.set(line.uuid, line);
      }
    }
    const type = line.type ?? '';
    if (type === 'workspace-directories') workspace = true;
    if (type === 'runtime-config') runtime = true;
    if (type === 'active-leaf') {
      activeLeafLine = true;
      activeLeaf = typeof line.leafUuid === 'string' ? line.leafUuid : line.leafUuid === null ? null : undefined;
    }
    if (type === 'user') {
      user += 1;
      const content = (line as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
            toolResults += 1;
            const id = (block as { tool_use_id?: string }).tool_use_id;
            if (typeof id === 'string') results.add(id);
          }
        }
      }
    }
    if (type === 'assistant') {
      assistant += 1;
      const content = (line as { message?: { content?: unknown[] } }).message?.content;
      for (const block of content ?? []) {
        if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
          toolUses += 1;
          const id = (block as { id?: string }).id;
          if (typeof id === 'string') calls.add(id);
        }
      }
    }
  }
  for (const id of results) if (!calls.has(id)) orphanResults += 1;

  checks.push({ name: 'workspace-directories', ok: workspace, detail: workspace ? '' : 'missing' });
  checks.push({ name: 'runtime-config', ok: runtime, detail: runtime ? '' : 'missing' });
  checks.push({ name: 'session-id', ok: sessionIds.size === 1 && (expectedSessionId === undefined || sessionIds.has(expectedSessionId)), detail: [...sessionIds].join(',') || 'missing' });
  checks.push({ name: 'uuid-shape', ok: badUuid === 0 && duplicateUuids === 0, detail: 'bad=' + badUuid + ' duplicate=' + duplicateUuids });
  let unresolved = 0;
  for (const line of lines) {
    const parent = line.parentUuid;
    if (typeof parent === 'string' && parent.length > 0 && !byUuid.has(parent)) unresolved += 1;
  }
  checks.push({ name: 'parent-links', ok: unresolved === 0, detail: unresolved + ' unresolved' });
  const leafOk = activeLeafLine && (activeLeaf === null || (typeof activeLeaf === 'string' && byUuid.has(activeLeaf)));
  checks.push({ name: 'active-leaf', ok: leafOk, detail: activeLeafLine ? String(activeLeaf) : 'missing' });
  checks.push({ name: 'has-conversation', ok: user > 0 && assistant > 0, detail: 'user=' + user + ' assistant=' + assistant });
  checks.push({ name: 'tool-pairing', ok: orphanResults === 0, detail: 'tool_use=' + toolUses + ' tool_result=' + toolResults + ' orphan=' + orphanResults });
  let badTime = 0;
  for (const line of lines) {
    if ((line.type === 'user' || line.type === 'assistant') && line.timestamp !== undefined && Number.isNaN(Date.parse(String(line.timestamp)))) badTime += 1;
  }
  checks.push({ name: 'timestamps', ok: badTime === 0, detail: badTime + ' invalid' });
  checks.push({ name: 'row-count', ok: lines.length > 3, detail: lines.length + ' rows' });
  return checks;
}

function canonicalEvents(bundle: IrBundle, options: { fromSource: boolean }): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const event of bundle.root.events) {
    if (event.kind === 'message') {
      if (event.synthetic === true) continue;
      const text = partsText(event.parts).trim();
      if (text.length === 0) continue;
      out.push({ kind: 'message', role: event.role, text });
      continue;
    }
    if (event.kind === 'reasoning') {
      if (event.reasoning.kind !== 'plain' || event.reasoning.text.length === 0) continue;
      out.push({ kind: 'reasoning', text: event.reasoning.text });
      continue;
    }
    if (event.kind === 'tool_call') {
      out.push({ kind: 'tool_call', callId: event.callId, name: event.name });
      continue;
    }
    if (event.kind === 'tool_result') {
      const text = event.content
        .map((block) => {
          if (block.type === 'text' || block.type === 'diff' || block.type === 'terminal') return block.text;
          if (block.type === 'image') return '[image: ' + block.ref + ']';
          return JSON.stringify(block.value) ?? '';
        })
        .join('\n');
      out.push({ kind: 'tool_result', callId: event.callId, text, isError: event.isError === true });
      continue;
    }
    if (event.kind === 'boundary') continue;
  }
  void options;
  return out;
}

/** 真实 transcript 自检（读盘 + 用 reader 重建 IR） */
export async function verifyQoderSession(input: string, options: ReadQoderOptions = {}): Promise<VerifyQoderReport> {
  const home = qoderHome(options.home);
  const path = resolveQoderSessionPath(input, home);
  const checks: VerifyCheck[] = [{ name: 'file-exists', ok: existsSync(path), detail: path }];
  if (!existsSync(path)) return { ok: false, checks };
  const parsed = readQoderLines(path);
  const sessionId = basename(path, '.jsonl');
  checks.push({ name: 'jsonl-parse', ok: parsed.badLines === 0, detail: parsed.totalLines + ' lines, ' + parsed.badLines + ' bad' });
  checks.push(...verifyQoderLines(parsed.lines, sessionId));
  const bundle = await readQoderSession(path, options);
  checks.push({ name: 'ir-structure', ok: validateIrBundle(bundle).length === 0, detail: validateIrBundle(bundle).slice(0, 3).join('; ') });
  checks.push({ name: 'ir-events', ok: bundle.root.events.length > 0, detail: bundle.root.events.length + ' events' });
  checks.push({ name: 'title', ok: textOf(bundle.root.meta.title) !== undefined, detail: bundle.root.meta.title ?? 'missing' });
  return {
    ok: checks.every((check) => check.ok),
    sessionId,
    path,
    checks,
    bundle,
  };
}

/** 写 -> reader 读回 -> 逐事件比对 */
export async function verifyQoderRoundTrip(bundle: IrBundle, write: WriteQoderResult, options: ReadQoderOptions = {}): Promise<{
  ok: boolean;
  checks: VerifyCheck[];
  expected: Array<Record<string, unknown>>;
  actual: Array<Record<string, unknown>>;
  bundle?: IrBundle;
}> {
  const checks: VerifyCheck[] = [];
  checks.push({ name: 'applied', ok: write.applied || write.dryRun, detail: 'applied=' + String(write.applied) + ' dryRun=' + String(write.dryRun) });
  if (!write.applied) {
    return { ok: false, checks: [...checks, { name: 'file-exists', ok: false, detail: 'dryRun 未落盘' }], expected: [], actual: [] };
  }
  const exists = existsSync(write.path);
  checks.push({ name: 'file-exists', ok: exists, detail: write.path });
  if (!exists) return { ok: false, checks, expected: [], actual: [] };
  const readBack = await readQoderSession(write.path, { ...options, home: options.home });
  const expected = canonicalEvents(bundle, { fromSource: true });
  const actual = canonicalEvents(readBack, { fromSource: false });
  const structural = validateIrBundle(readBack);
  checks.push({ name: 'ir-structure', ok: structural.length === 0, detail: structural.slice(0, 3).join('; ') });
  checks.push({ name: 'session-id', ok: readBack.root.source.nativeSessionId === write.sessionId, detail: String(readBack.root.source.nativeSessionId ?? 'missing') });
  checks.push({ name: 'cwd', ok: readBack.root.meta.cwd === write.cwd, detail: String(readBack.root.meta.cwd ?? 'missing') });
  checks.push({ name: 'title', ok: readBack.root.meta.title === write.title, detail: String(readBack.root.meta.title ?? 'missing') });
  checks.push({ name: 'event-count', ok: actual.length === expected.length, detail: 'expected=' + expected.length + ' actual=' + actual.length });
  const mismatch: string[] = [];
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) mismatch.push(String(index) + ': ' + JSON.stringify(expected[index]) + ' != ' + JSON.stringify(actual[index]));
  }
  checks.push({ name: 'event-sequence', ok: mismatch.length === 0, detail: mismatch.slice(0, 3).join(' | ') });
  return {
    ok: checks.every((check) => check.ok),
    checks,
    expected,
    actual,
    bundle: readBack,
  };
}
