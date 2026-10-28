import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import type { IrBundle, IrPart } from '@sessionport/core';

import { readQoderSession } from './read.ts';
import type { ReadQoderOptions } from './read.ts';
import type { WriteQoderResult } from './write.ts';
import type { QoderLine } from './wire.ts';
import { isQoderSessionId, parseQoderLines, qoderHome, readQoderLines, resolveQoderSessionPath, textOf } from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** 期望存在的子代理（通常来自 writeQoderSession 返回的 children） */
export interface VerifyQoderSubagentExpectation {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

export interface VerifyQoderSubagentReport {
  agentId: string;
  filePath: string;
  metaPath: string;
  rows: number;
  conversationRows: number;
  ok: boolean;
}

export interface VerifyQoderOptions extends ReadQoderOptions {
  /** 传入后额外检查每个 child 都有文件，且 meta.json 字段与 child 对应 */
  expectedChildren?: VerifyQoderSubagentExpectation[];
}

export interface VerifyQoderReport {
  ok: boolean;
  sessionId?: string;
  path?: string;
  checks: VerifyCheck[];
  /** 本次发现并校验的子代理 transcript（没有 subagents 目录时为空） */
  subagents: VerifyQoderSubagentReport[];
  bundle?: IrBundle;
}

interface AnyRow {
  type?: string;
  uuid?: string;
  parentUuid?: unknown;
  sessionId?: string;
  agentId?: string;
  isSidechain?: boolean;
  parent_tool_use_id?: unknown;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
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
      const content = (line as { message?: { content?: unknown } }).message?.content;
      for (const block of Array.isArray(content) ? content : []) {
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

// ---------------------------------------------------------------------------
// 子代理 transcript（<sessionId>/subagents/agent-<agentId>.jsonl）
// ---------------------------------------------------------------------------

/** Qoder 的 agentId 是 <agent- 与 .jsonl 之间的任意文件名（实测 aExplore-<hex16>） */
const SUBAGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/u;
const SUBAGENT_SCAN_MAX_DEPTH = 4;

function subagentsDirOf(sessionPath: string): string {
  return join(dirname(sessionPath), basename(sessionPath, '.jsonl'), 'subagents');
}

function blocksOf(row: AnyRow): ContentBlock[] {
  const content = row.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => block !== null && typeof block === 'object');
}

/** parentUuid 必须指向文件里更早出现的行；根行（第一条对话行）允许为 null */
function parentChainBroken(rows: AnyRow[]): number {
  const seen = new Set<string>();
  let broken = 0;
  for (const row of rows) {
    if (row.type === 'user' || row.type === 'assistant') {
      const parent = typeof row.parentUuid === 'string' && row.parentUuid.length > 0 ? row.parentUuid : undefined;
      if (parent === undefined) {
        if (seen.size > 0) broken += 1;
      } else if (!seen.has(parent)) {
        broken += 1;
      }
    }
    if (typeof row.uuid === 'string') seen.add(row.uuid);
  }
  return broken;
}

interface ToolPairing {
  calls: number;
  results: number;
  orphan: number;
  missing: number;
}

function toolPairingOf(rows: AnyRow[]): ToolPairing {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') calls.add(block.id);
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') results.add(block.tool_use_id);
    }
  }
  let orphan = 0;
  for (const id of results) if (!calls.has(id)) orphan += 1;
  let missing = 0;
  for (const id of calls) if (!results.has(id)) missing += 1;
  return { calls: calls.size, results: results.size, orphan, missing };
}

function collectSubagentFiles(dir: string, depth = 0): string[] {
  if (depth > SUBAGENT_SCAN_MAX_DEPTH) return [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSubagentFiles(full, depth + 1));
    else if (entry.isFile() && SUBAGENT_FILE_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

function readMeta(path: string): { meta?: Record<string, unknown>; error?: string } {
  if (!existsSync(path)) return { error: 'meta.json 不存在' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'meta.json 不是对象' };
    return { meta: parsed as Record<string, unknown> };
  } catch {
    return { error: 'meta.json 解析失败' };
  }
}

/**
 * 子代理文件检查：JSONL 可解析、每行 isSidechain/agentId、parentUuid 链自洽、
 * sessionId 与主会话一致、tool_use/result 配对、meta.json 存在且与行/meta.toolUseId 对应。
 */
function verifyQoderSubagents(
  sessionPath: string,
  mainLines: QoderLine[],
  options: VerifyQoderOptions,
  checks: VerifyCheck[],
): VerifyQoderSubagentReport[] {
  const dir = subagentsDirOf(sessionPath);
  const files = existsSync(dir) ? collectSubagentFiles(dir) : [];
  const reports: VerifyQoderSubagentReport[] = [];
  const parentSessionId = basename(sessionPath, '.jsonl');
  const mainToolUseIds = new Set<string>();
  for (const line of mainLines) {
    for (const block of blocksOf(line as AnyRow)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') mainToolUseIds.add(block.id);
    }
  }
  const metaByAgent = new Map<string, Record<string, unknown> | undefined>();

  if (files.length > 0) {
    checks.push({ name: 'subagent-files', ok: true, detail: files.length + ' 份 agent transcript' });
  }

  for (const filePath of files) {
    const agentId = SUBAGENT_FILE_PATTERN.exec(basename(filePath))?.[1];
    if (agentId === undefined) continue;
    const start = checks.length;
    const metaPath = filePath.replace(/\.jsonl$/u, '.meta.json');

    const parsed = (() => {
      try {
        return readQoderLines(filePath);
      } catch {
        return undefined;
      }
    })();
    const rows = (parsed?.lines ?? []) as AnyRow[];
    const badLines = parsed === undefined ? 1 : parsed.badLines;
    checks.push({ name: 'subagent-' + agentId + '-jsonl-parses', ok: parsed !== undefined && badLines === 0, detail: parsed === undefined ? '文件读不出来' : '解析失败 ' + badLines + ' 行' });

    const conversation = rows.filter((row) => row.type === 'user' || row.type === 'assistant');
    checks.push({ name: 'subagent-' + agentId + '-has-conversation', ok: conversation.length > 0, detail: conversation.length + ' 条对话行' });

    const sidechainBad = conversation.filter((row) => row.isSidechain !== true || row.agentId !== agentId).length;
    checks.push({
      name: 'subagent-' + agentId + '-sidechain-agent-id',
      ok: sidechainBad === 0,
      detail: sidechainBad === 0 ? 'ok' : sidechainBad + ' 行缺 isSidechain/agentId 或 agentId 不匹配',
    });

    const brokenChain = parentChainBroken(rows);
    checks.push({ name: 'subagent-' + agentId + '-parent-chain', ok: brokenChain === 0, detail: brokenChain + ' 处断链' });

    const sessionIds = new Set(conversation.map((row) => row.sessionId).filter((value): value is string => typeof value === 'string'));
    checks.push({
      name: 'subagent-' + agentId + '-session-id',
      ok: sessionIds.size <= 1 && (sessionIds.size === 0 || sessionIds.has(parentSessionId)),
      detail: sessionIds.size === 0 ? '行内未写 sessionId（可省）' : [...sessionIds].join(','),
    });

    const pairing = toolPairingOf(rows);
    checks.push({
      name: 'subagent-' + agentId + '-tool-pairing',
      ok: pairing.orphan === 0,
      detail: 'tool_use=' + pairing.calls + ' tool_result=' + pairing.results + ' orphan=' + pairing.orphan + ' missing=' + pairing.missing,
    });

    const { meta, error } = readMeta(metaPath);
    const agentType = textOf(meta?.agentType);
    const description = meta?.description;
    const metaToolUseId = textOf(meta?.toolUseId);
    const invocationName = meta?.invocationName;
    const agentTypeOk = agentType !== undefined;
    const descriptionOk = description === undefined || textOf(description) !== undefined;
    const toolUseOk = meta?.toolUseId === undefined || metaToolUseId !== undefined;
    const invocationOk = invocationName === undefined || textOf(invocationName) !== undefined;
    checks.push({
      name: 'subagent-' + agentId + '-meta',
      ok: meta !== undefined && agentTypeOk && descriptionOk && toolUseOk && invocationOk,
      detail:
        meta === undefined
          ? (error ?? 'meta.json 不存在')
          : !agentTypeOk
            ? 'agentType 缺失'
            : !descriptionOk
              ? 'description 为空'
              : !toolUseOk
                ? 'toolUseId 为空'
                : !invocationOk
                  ? 'invocationName 为空'
                  : 'ok',
    });
    metaByAgent.set(agentId, meta);

    // 主会话里必须有 meta.toolUseId 对应的 tool_use，且每行 parent_tool_use_id 与之一致
    const rowParentIds = new Set<string>();
    for (const row of conversation) {
      const value = textOf(row.parent_tool_use_id);
      if (value !== undefined) rowParentIds.add(value);
    }
    const hasParentToolUse = metaToolUseId !== undefined && mainToolUseIds.has(metaToolUseId);
    const rowsConsistent =
      metaToolUseId === undefined
        ? rowParentIds.size === 0
        : rowParentIds.size === 1 && rowParentIds.has(metaToolUseId);
    checks.push({
      name: 'subagent-' + agentId + '-parent-tool-use',
      ok: rowsConsistent && (metaToolUseId === undefined || hasParentToolUse),
      detail:
        metaToolUseId === undefined
          ? 'meta 没有 toolUseId（子代理未关联到父 Agent 调用）'
          : !hasParentToolUse
            ? '主会话里找不到 tool_use ' + metaToolUseId
            : !rowsConsistent
              ? 'parent_tool_use_id 与 meta.toolUseId 不一致: ' + [...rowParentIds].join(',')
              : 'toolUseId=' + metaToolUseId,
    });

    reports.push({
      agentId,
      filePath,
      metaPath,
      rows: rows.length,
      conversationRows: conversation.length,
      ok: checks.slice(start).every((check) => check.ok),
    });
  }

  const expected = options.expectedChildren ?? [];
  if (expected.length > 0) {
    const byAgent = new Map(reports.map((report) => [report.agentId, report]));
    const missing = expected.filter((item) => !byAgent.has(item.agentId)).map((item) => item.agentId);
    const expectedIds = new Set(expected.map((item) => item.agentId));
    const extra = reports.filter((report) => !expectedIds.has(report.agentId)).map((report) => report.agentId);
    const parts: string[] = [];
    if (missing.length > 0) parts.push('缺少 ' + missing.join(','));
    if (extra.length > 0) parts.push('多出 ' + extra.join(','));
    checks.push({
      name: 'subagent-files-match-children',
      ok: missing.length === 0 && extra.length === 0,
      detail: parts.length === 0 ? 'ok' : parts.join('；'),
    });

    const mismatches: string[] = [];
    for (const item of expected) {
      const meta = metaByAgent.get(item.agentId);
      if (meta === undefined) {
        mismatches.push(item.agentId + ':meta');
        continue;
      }
      if (item.agentType !== undefined && meta.agentType !== item.agentType) mismatches.push(item.agentId + ':agentType');
      if (item.description !== undefined && meta.description !== item.description) mismatches.push(item.agentId + ':description');
      if (item.toolUseId !== undefined && meta.toolUseId !== item.toolUseId) mismatches.push(item.agentId + ':toolUseId');
    }
    checks.push({
      name: 'subagent-meta-matches-children',
      ok: mismatches.length === 0,
      detail: mismatches.length === 0 ? 'ok' : mismatches.join(','),
    });
  }

  return reports;
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
export async function verifyQoderSession(input: string, options: VerifyQoderOptions = {}): Promise<VerifyQoderReport> {
  const home = qoderHome(options.home);
  const path = resolveQoderSessionPath(input, home);
  const checks: VerifyCheck[] = [{ name: 'file-exists', ok: existsSync(path), detail: path }];
  if (!existsSync(path)) return { ok: false, checks, subagents: [] };
  const parsed = readQoderLines(path);
  const sessionId = basename(path, '.jsonl');
  checks.push({ name: 'jsonl-parse', ok: parsed.badLines === 0, detail: parsed.totalLines + ' lines, ' + parsed.badLines + ' bad' });
  checks.push(...verifyQoderLines(parsed.lines, sessionId));
  const bundle = await readQoderSession(path, options);
  checks.push({ name: 'ir-structure', ok: validateIrBundle(bundle).length === 0, detail: validateIrBundle(bundle).slice(0, 3).join('; ') });
  checks.push({ name: 'ir-events', ok: bundle.root.events.length > 0, detail: bundle.root.events.length + ' events' });
  checks.push({ name: 'title', ok: textOf(bundle.root.meta.title) !== undefined, detail: bundle.root.meta.title ?? 'missing' });
  const subagents = verifyQoderSubagents(path, parsed.lines, options, checks);
  return {
    ok: checks.every((check) => check.ok),
    sessionId,
    path,
    checks,
    subagents,
    bundle,
  };
}

/** 写 -> reader 读回 -> 逐事件比对（含子代理文件的往返） */
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

  if (write.children.length > 0) {
    checks.push({
      name: 'subagent-count',
      ok: readBack.children.length === write.children.length,
      detail: 'expected=' + write.children.length + ' actual=' + readBack.children.length,
    });
    for (const child of write.children) {
      const got = readBack.children.find((candidate) => candidate.label === child.agentId);
      const titleOk = got !== undefined && got.session.meta.title === child.meta.description;
      const profileOk = got !== undefined && got.session.meta.profile === child.meta.agentType;
      const viaOk = child.meta.toolUseId === undefined ? got?.viaToolCallId === undefined : got?.viaToolCallId === child.meta.toolUseId;
      checks.push({
        name: 'subagent-' + child.agentId,
        ok: got !== undefined && titleOk && profileOk && viaOk,
        detail:
          got === undefined
            ? '读回缺少子代理'
            : !titleOk
              ? '标题 ' + String(got.session.meta.title ?? 'missing') + ' != ' + child.meta.description
              : !profileOk
                ? 'profile ' + String(got.session.meta.profile ?? 'missing') + ' != ' + child.meta.agentType
                : !viaOk
                  ? 'viaToolCallId 与 meta.toolUseId 不一致'
                  : 'events=' + got.session.events.length + ' title=' + child.meta.description,
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    expected,
    actual,
    bundle: readBack,
  };
}
