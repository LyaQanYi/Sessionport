/**
 * verify：Cursor 写入后的结构自检 + 可选 app 冒烟。
 *
 * 结构自检不依赖 Cursor app：
 *   - composerHeaders 行存在且 value 能解析、composerId/workspaceId 一致
 *   - composerData 存在、_v/顺序/类型/气泡 key 完整、无孤立 bubble
 *   - 可选 readback：用 readCursorSession 再读一遍，对比消息数
 *
 * app 冒烟（可选）：重启 Cursor 后读 logs/<ts>/main.log 里
 * "[LocalAgentStorage] Scanned ... found N agent headers" 一行，作为 app 进程看见了新
 * composerHeader 的旁证；列表 UI 的最终可见性仍需人工在 app 里确认。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { validateCursorPrecomputedDiff } from './diff.ts';
import { cursorLogsDir, cursorUserDataDir, resolveCursorPaths } from './paths.ts';
import { readCursorSession } from './read.ts';
import { isCursorToolStatus } from './toolformer.ts';
import {
  BUBBLE_TYPE_AI,
  BUBBLE_TYPE_HUMAN,
  HEADER_TABLE,
  HEADER_MIGRATED_FLAG_KEY,
  bubbleKeyPrefix,
  closeCursorDb,
  countBubbles,
  headerRecordFromRow,
  isRecord,
  openCursorDb,
  readBubbles,
  readComposerDataRaw,
  readDiskKvEntries,
  readDiskKvValue,
  readHeaderRow,
  tableExists,
  tryParseJson,
} from './wire.ts';
import type {
  CursorComposerData,
  CursorConversationHeaderEntry,
  CursorToolFormerData,
} from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CursorReadbackSummary {
  events: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  /** tool_result 里带 diff block 的条数（edit diff 的读回计数） */
  diffs: number;
  reasoning: number;
  head: string | null;
}

export interface VerifyCursorOptions {
  home?: string;
  dbPath?: string;
  sessionId: string;
  /** 写入侧期望值（可选）：对不上就判失败 */
  expected?: {
    bubbles?: number;
    messages?: number;
    userMessages?: number;
    assistantMessages?: number;
    eventCount?: number;
    toolCalls?: number;
    toolResults?: number;
    /** 读回时 tool_result 里的 diff block 数量 */
    diffs?: number;
  };
  /** 跳过 readback（只看 DB 结构） */
  skipReadback?: boolean;
}

export interface VerifyCursorReport {
  ok: boolean;
  sessionId: string;
  dbPath: string;
  bubbles: number;
  checks: VerifyCheck[];
  readback?: CursorReadbackSummary;
}

export async function verifyCursorSession(options: VerifyCursorOptions): Promise<VerifyCursorReport> {
  const paths = resolveCursorPaths(options);
  const checks: VerifyCheck[] = [];
  const push = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };

  push('db-exists', existsSync(paths.dbPath), paths.dbPath);
  if (!existsSync(paths.dbPath)) {
    return { ok: false, sessionId: options.sessionId, dbPath: paths.dbPath, bubbles: 0, checks };
  }

  const db = openCursorDb(paths.dbPath, { readOnly: true });
  let bubbles = 0;
  try {
    push('header-table', tableExists(db, HEADER_TABLE), HEADER_TABLE);
    const row = readHeaderRow(db, options.sessionId);
    push('header-row', row !== undefined, row === undefined ? '缺失' : options.sessionId);
    const record = row === undefined ? undefined : headerRecordFromRow(row);
    push('header-value-parses', record !== undefined, record === undefined ? 'value 不是 JSON 对象' : 'ok');
    push('header-composer-id', record?.header.composerId === options.sessionId, String(record?.header.composerId ?? '?'));

    const headerName = record?.header.name;
    push(
      'header-name',
      typeof headerName === 'string' && headerName.trim().length > 0,
      typeof headerName === 'string' ? headerName : '缺 name（app 里会显示 New Agent）',
    );
    const workspaceId = row?.workspaceId ?? undefined;
    const headerWorkspaceId =
      record?.header.workspaceIdentifier !== undefined && typeof record.header.workspaceIdentifier.id === 'string'
        ? record.header.workspaceIdentifier.id
        : undefined;
    push(
      'header-workspace-id',
      typeof workspaceId === 'string' && workspaceId.length > 0 && headerWorkspaceId === workspaceId,
      'column=' + String(workspaceId ?? '?') + ' value=' + String(headerWorkspaceId ?? '?'),
    );
    const fsPath = workspaceFsPath(record?.header.workspaceIdentifier);
    push('workspace-uri-fspath', typeof fsPath === 'string' && fsPath.startsWith('/'), String(fsPath ?? '?'));

    const createdAt = row?.createdAt ?? record?.header.createdAt;
    const updatedAt = row?.lastUpdatedAt ?? record?.header.lastUpdatedAt;
    push(
      'timestamps-sane',
      typeof createdAt === 'number' && createdAt > 1e12 && typeof updatedAt === 'number' && updatedAt >= createdAt,
      'createdAt=' + String(createdAt ?? '?') + ' lastUpdatedAt=' + String(updatedAt ?? '?'),
    );

    const flag = readDiskKvValue(db, HEADER_MIGRATED_FLAG_KEY);
    push(
      'header-table-canonical',
      flag === '1' || flag === undefined,
      flag === undefined ? 'migratedToTable 未设置（app 启动时会补）' : flag,
    );

    const rawComposer = readComposerDataRaw(db, options.sessionId);
    push('composer-data-row', rawComposer !== undefined, rawComposer === undefined ? '缺失' : 'ok');
    const data = rawComposer === undefined ? undefined : parseComposer(rawComposer);
    push('composer-data-parses', data !== undefined, data === undefined ? '不是 JSON 对象' : 'ok');
    const version = data?._v;
    push('composer-version', typeof version === 'number' && version >= 16, '_v=' + String(version ?? '?'));

    const headers = Array.isArray(data?.fullConversationHeadersOnly)
      ? data.fullConversationHeadersOnly
      : undefined;
    push('conversation-headers', headers !== undefined && headers.length > 0, String(headers?.length ?? 0) + ' 条');

    const parsedHeaders: CursorConversationHeaderEntry[] = [];
    let badShape = 0;
    const seen = new Set<string>();
    let duplicated = 0;
    for (const item of headers ?? []) {
      if (!isRecord(item)) {
        badShape += 1;
        continue;
      }
      const bubbleId = typeof item.bubbleId === 'string' ? item.bubbleId : undefined;
      const type = typeof item.type === 'number' ? item.type : undefined;
      if (bubbleId === undefined || (type !== BUBBLE_TYPE_HUMAN && type !== BUBBLE_TYPE_AI)) {
        badShape += 1;
        continue;
      }
      if (seen.has(bubbleId)) duplicated += 1;
      seen.add(bubbleId);
      parsedHeaders.push({ ...(item as CursorConversationHeaderEntry), bubbleId, type });
    }
    push(
      'headers-shape',
      badShape === 0 && duplicated === 0,
      'bad=' + String(badShape) + ' duplicate=' + String(duplicated),
    );

    const order = headerOrderCheck(parsedHeaders);
    push('headers-order', order.ok, order.detail);

    const ids = parsedHeaders.map((entry) => entry.bubbleId);
    const { bubbles: bubbleMap, missing, bad } = readBubbles(db, options.sessionId, ids);
    bubbles = bubbleMap.size;
    push('bubbles-complete', missing.length === 0, 'missing=' + String(missing.length));
    push('bubble-json-parses', bad.length === 0, 'bad=' + String(bad.length));
    let typeMismatch = 0;
    for (const entry of parsedHeaders) {
      const bubble = bubbleMap.get(entry.bubbleId);
      if (bubble === undefined) continue;
      if (bubble.type !== entry.type) typeMismatch += 1;
    }
    push('bubble-types-match', typeMismatch === 0, 'mismatch=' + String(typeMismatch));

    // 工具气泡：字段存在、params/result 可解码、callId 配对
    const toolBubbles: Array<{ bubbleId: string; tool: CursorToolFormerData }> = [];
    for (const [bubbleId, bubble] of bubbleMap) {
      if (isRecord(bubble.toolFormerData)) {
        toolBubbles.push({ bubbleId, tool: bubble.toolFormerData as CursorToolFormerData });
      }
    }
    const callIds = new Set<string>();
    let badToolFields = 0;
    let badToolJson = 0;
    let badToolStatus = 0;
    let duplicateCallIds = 0;
    let badExtension = 0;
    for (const { tool } of toolBubbles) {
      const callId = typeof tool.toolCallId === 'string' ? tool.toolCallId : '';
      const hasName = typeof tool.name === 'string' && tool.name.trim().length > 0;
      const hasTool = typeof tool.tool === 'number' && Number.isFinite(tool.tool);
      if (callId.length === 0 || !hasName || !hasTool) badToolFields += 1;
      if (callId.length > 0) {
        if (callIds.has(callId)) duplicateCallIds += 1;
        callIds.add(callId);
      }
      if (!isCursorToolStatus(tool.status)) badToolStatus += 1;
      for (const value of [tool.params, tool.result]) {
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string' || tryParseJson(value) === undefined) badToolJson += 1;
      }
      if (tool._sessionport !== undefined) {
        const extension = tool._sessionport;
        if (!isRecord(extension) || extension.v !== 1 || typeof extension.name !== 'string') badExtension += 1;
      }
    }
    push(
      'toolformer-fields',
      badToolFields === 0,
      'tools=' + String(toolBubbles.length) + ' bad=' + String(badToolFields),
    );
    push('toolformer-params-json', badToolJson === 0, 'bad=' + String(badToolJson));
    push('toolformer-status', badToolStatus === 0, 'bad=' + String(badToolStatus));
    push(
      'toolformer-call-ids',
      duplicateCallIds === 0,
      'ids=' + String(callIds.size) + ' duplicate=' + String(duplicateCallIds),
    );
    push('toolformer-extension', badExtension === 0, 'bad=' + String(badExtension));

    // edit 的 diff：只校验实际写了的 additionalData.precomputedDiff；
    // 文本-only 的 import 或原生 blob-only 气泡没有该字段，不算失败。
    let editDiffCount = 0;
    let badEditDiffs = 0;
    let editDiffNoChanges = 0;
    let firstEditDiffError = '';
    for (const { tool } of toolBubbles) {
      if (tool.tool !== 38 && tool.name !== 'edit_file_v2') continue;
      const additional = tool.additionalData;
      const precomputed = isRecord(additional) ? additional.precomputedDiff : undefined;
      if (precomputed === undefined) continue;
      editDiffCount += 1;
      const errors = validateCursorPrecomputedDiff(precomputed);
      if (errors.length > 0) {
        badEditDiffs += 1;
        if (firstEditDiffError.length === 0) firstEditDiffError = errors[0] as string;
        continue;
      }
      const validated = precomputed as { hasChanges?: unknown; lines: Array<{ type: string }> };
      if (validated.hasChanges !== true || !validated.lines.some((line) => line.type !== 'unchanged')) {
        editDiffNoChanges += 1;
      }
    }
    push(
      'toolformer-edit-diff',
      badEditDiffs === 0,
      'withDiff=' +
        String(editDiffCount) +
        ' bad=' +
        String(badEditDiffs) +
        (editDiffNoChanges > 0 ? ' noChanges=' + String(editDiffNoChanges) : '') +
        (firstEditDiffError.length > 0 ? ' firstError=' + firstEditDiffError : ''),
    );

    let groupingMismatch = 0;
    for (const entry of parsedHeaders) {
      if (!isRecord(entry.grouping)) continue;
      const grouping = entry.grouping;
      if (typeof grouping.toolFormerTool !== 'number') continue;
      const bubble = bubbleMap.get(entry.bubbleId);
      const tool = bubble !== undefined && isRecord(bubble.toolFormerData)
        ? (bubble.toolFormerData as CursorToolFormerData)
        : undefined;
      if (tool === undefined) {
        groupingMismatch += 1;
        continue;
      }
      if (grouping.toolFormerTool !== tool.tool) groupingMismatch += 1;
      if (
        typeof grouping.toolCallId === 'string' &&
        grouping.toolCallId.length > 0 &&
        grouping.toolCallId !== tool.toolCallId
      ) {
        groupingMismatch += 1;
      }
    }
    push('toolformer-grouping', groupingMismatch === 0, 'mismatch=' + String(groupingMismatch));

    const prefix = bubbleKeyPrefix(options.sessionId);
    const orphan = readDiskKvEntries(db, prefix).filter(([key]) => {
      const bubbleId = key.slice(prefix.length);
      return !seen.has(bubbleId);
    });
    push('no-orphan-bubbles', orphan.length === 0, 'orphan=' + String(orphan.length));

    const dbBubbleCount = countBubbles(db, options.sessionId);
    push(
      'bubble-count',
      dbBubbleCount === parsedHeaders.length,
      'db=' + String(dbBubbleCount) + ' headers=' + String(parsedHeaders.length),
    );

    const expected = options.expected;
    if (expected?.bubbles !== undefined) {
      push(
        'expected-bubbles',
        parsedHeaders.length === expected.bubbles,
        'headers=' + String(parsedHeaders.length) + ' expected=' + String(expected.bubbles),
      );
    }

    let readback: CursorReadbackSummary | undefined;
    if (options.skipReadback !== true) {
      try {
        const bundle = await readCursorSession(paths.dbPath + '#' + options.sessionId, {
          home: paths.home,
          dbPath: paths.dbPath,
          includeChildren: false,
        });
        const summary = summarizeBundle(bundle);
        readback = summary;
        push('readback-events', summary.events > 0, 'events=' + String(summary.events));
        push(
          'readback-messages',
          summary.userMessages > 0,
          'user=' + String(summary.userMessages) + ' assistant=' + String(summary.assistantMessages),
        );
        if (expected?.eventCount !== undefined) {
          push(
            'expected-events',
            summary.events === expected.eventCount,
            'events=' + String(summary.events) + ' expected=' + String(expected.eventCount),
          );
        }
        if (expected?.userMessages !== undefined) {
          push(
            'expected-user-messages',
            summary.userMessages === expected.userMessages,
            'user=' + String(summary.userMessages) + ' expected=' + String(expected.userMessages),
          );
        }
        if (expected?.assistantMessages !== undefined) {
          push(
            'expected-assistant-messages',
            summary.assistantMessages === expected.assistantMessages,
            'assistant=' + String(summary.assistantMessages) + ' expected=' + String(expected.assistantMessages),
          );
        }
        if (expected?.toolCalls !== undefined) {
          push(
            'expected-tool-calls',
            summary.toolCalls === expected.toolCalls,
            'toolCalls=' + String(summary.toolCalls) + ' expected=' + String(expected.toolCalls),
          );
        }
        if (expected?.toolResults !== undefined) {
          push(
            'expected-tool-results',
            summary.toolResults === expected.toolResults,
            'toolResults=' + String(summary.toolResults) + ' expected=' + String(expected.toolResults),
          );
        }
        if (expected?.diffs !== undefined) {
          push(
            'expected-diffs',
            summary.diffs === expected.diffs,
            'diffs=' + String(summary.diffs) + ' expected=' + String(expected.diffs),
          );
        }
      } catch (error) {
        push('readback', false, error instanceof Error ? error.message : String(error));
      }
    }
    return {
      ok: checks.every((check) => check.ok),
      sessionId: options.sessionId,
      dbPath: paths.dbPath,
      bubbles,
      checks,
      ...(readback !== undefined ? { readback } : {}),
    };
  } finally {
    closeCursorDb(db);
  }
}

function parseComposer(raw: string): CursorComposerData | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? (value as CursorComposerData) : undefined;
  } catch {
    return undefined;
  }
}

function workspaceFsPath(identifier: unknown): string | undefined {
  if (!isRecord(identifier)) return undefined;
  const uri = identifier.uri;
  if (isRecord(uri) && typeof uri.fsPath === 'string') return uri.fsPath;
  return undefined;
}

function headerOrderCheck(headers: CursorConversationHeaderEntry[]): { ok: boolean; detail: string } {
  let previous = Number.NEGATIVE_INFINITY;
  let bad = 0;
  for (const header of headers) {
    const ms = typeof header.createdAt === 'string' ? Date.parse(header.createdAt) : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms < previous) bad += 1;
    previous = ms;
  }
  return { ok: bad === 0, detail: bad === 0 ? 'createdAt 单调不减' : String(bad) + ' 条乱序' };
}

function summarizeBundle(bundle: {
  root: {
    events: Array<{ kind: string; role?: string; content?: Array<{ type: string }> }>;
    head: string | null;
  };
}): CursorReadbackSummary {
  const summary: CursorReadbackSummary = {
    events: bundle.root.events.length,
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    diffs: 0,
    reasoning: 0,
    head: bundle.root.head,
  };
  for (const event of bundle.root.events) {
    if (event.kind === 'message') {
      summary.messages += 1;
      if (event.role === 'user') summary.userMessages += 1;
      else if (event.role === 'assistant') summary.assistantMessages += 1;
    } else if (event.kind === 'tool_call') {
      summary.toolCalls += 1;
    } else if (event.kind === 'tool_result') {
      summary.toolResults += 1;
      for (const block of event.content ?? []) {
        if (block.type === 'diff') summary.diffs += 1;
      }
    } else if (event.kind === 'reasoning') {
      summary.reasoning += 1;
    }
  }
  return summary;
}

/** sync 用：目标端存在性 + 计量单位（气泡条数） */
export async function countCursorTarget(input: {
  home?: string;
  dbPath?: string;
  sessionId: string;
}): Promise<{ exists: boolean; units: number }> {
  const paths = resolveCursorPaths(input);
  if (!existsSync(paths.dbPath)) return { exists: false, units: 0 };
  const db = openCursorDb(paths.dbPath, { readOnly: true });
  try {
    const hasComposer = readComposerDataRaw(db, input.sessionId) !== undefined;
    const hasHeader = readHeaderRow(db, input.sessionId) !== undefined;
    return { exists: hasComposer || hasHeader, units: countBubbles(db, input.sessionId) };
  } catch {
    return { exists: false, units: 0 };
  } finally {
    closeCursorDb(db);
  }
}

export function cursorDisplayName(composerId: string): string {
  return composerId.length > 13 ? composerId.slice(0, 8) + '…' + composerId.slice(-4) : composerId;
}

// ---------------------------------------------------------------------------
// app 冒烟（可选，不参与结构校验）
// ---------------------------------------------------------------------------

export interface CursorAgentScanLog {
  logPath: string;
  line: string;
  timestamp?: string;
  found: number;
  deduped: number;
}

/** 读 Cursor main.log 里最后一次 LocalAgentStorage 扫描结果（app 启动时的 agent 列表扫描） */
export function readCursorAgentScanLog(home?: string): CursorAgentScanLog | undefined {
  const logsRoot = cursorLogsDir(cursorUserDataDir(home));
  if (!existsSync(logsRoot)) return undefined;
  let dirs: string[];
  try {
    dirs = readdirSync(logsRoot);
  } catch {
    return undefined;
  }
  const withTime = dirs
    .map((name) => {
      const path = join(logsRoot, name);
      try {
        return { path, name, mtime: statSync(path).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((item): item is { path: string; name: string; mtime: number } => item !== undefined)
    .sort((a, b) => b.mtime - a.mtime);
  for (const dir of withTime) {
    const logPath = join(dir.path, 'main.log');
    if (!existsSync(logPath)) continue;
    let text: string;
    try {
      text = readFileSync(logPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined || !line.includes('[LocalAgentStorage]')) continue;
      const match = /found (\d+) agent headers, deduped to (\d+)/.exec(line);
      if (match === null) continue;
      return {
        logPath,
        line,
        timestamp: /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/.exec(line)?.[1],
        found: Number(match[1]),
        deduped: Number(match[2]),
      };
    }
  }
  return undefined;
}

export interface CursorHeadlessCapabilities {
  /** app 的 composer 列表能否被 headless 读取 */
  appChatListHeadless: boolean;
  /** app 的 composer 能否被 headless 续聊 */
  appChatResumeHeadless: boolean;
  /** cursor-agent CLI 是否有 ls/resume */
  cliHasListResume: boolean;
  /** CLI 聊天是否独立于 app composer 库 */
  cliChatsAreSeparateStore: boolean;
  note: string;
  evidence: string[];
}

/** 研究结论（Cursor 3.25.9 + cursor-agent 2026.07.16 实测） */
export function cursorHeadlessCapabilities(): CursorHeadlessCapabilities {
  return {
    appChatListHeadless: false,
    appChatResumeHeadless: false,
    cliHasListResume: true,
    cliChatsAreSeparateStore: true,
    note:
      'Cursor app 的 composer 会话没有 headless 的 list/resume 入口；cursor-agent CLI 的 ls/resume 面向 ~/.cursor/chats 里的 CLI 会话，' +
      '不读取 app 的 composerHeaders/composerData。写完只能重启 app 后在列表里人工确认。',
    evidence: [
      'cursor-agent --help：有 ls / resume / --resume <chatId>，但 CLI bundle 中没有任何 composerHeaders/composerData/bubbleId 字符串',
      '~/.cursor/chats/<hash>/<uuid>/{store.db,meta.json}：CLI 独立聊天存储（blobs/meta 两张表）',
      'app 侧列表在 workbench.glass.main.js 的 ComposerDataService 里通过 composerHeaders 表 + cursorDiskKV composerData 加载',
    ],
  };
}

export interface CursorAppSmokeOptions {
  home?: string;
  cwd?: string;
  /** 先退出再打开 Cursor（默认 false；true 会打断正在使用的 app） */
  restart?: boolean;
  /** 重启后等待多少毫秒再读日志（默认 8000） */
  waitMs?: number;
}

export interface CursorAppSmokeResult {
  platformSupported: boolean;
  restarted: boolean;
  opened: boolean;
  commands: string[];
  error?: string;
  scanLog?: CursorAgentScanLog;
  note: string;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs }, (error) => {
      if (error === null || error === undefined) resolvePromise({ ok: true });
      else resolvePromise({ ok: false, error: error.message });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * 可选 app 冒烟：open -a Cursor [cwd]，restart=true 时先 quit 让 app 重新加载数据库。
 * 结论来自 main.log 的 LocalAgentStorage 扫描行；列表 UI 的最终可见性仍需人工确认。
 */
export async function appSmokeCursor(options: CursorAppSmokeOptions = {}): Promise<CursorAppSmokeResult> {
  const commands: string[] = [];
  if (process.platform !== 'darwin') {
    return {
      platformSupported: false,
      restarted: false,
      opened: false,
      commands,
      note: 'app 冒烟目前只实现了 macOS（open/osascript）',
    };
  }
  const restarted = options.restart === true;
  if (restarted) {
    commands.push('osascript -e \'tell application "Cursor" to quit\'');
    const quit = await runCommand('osascript', ['-e', 'tell application "Cursor" to quit'], 30000);
    if (!quit.ok) {
      return {
        platformSupported: true,
        restarted: false,
        opened: false,
        commands,
        error: quit.error,
        note: '退出 Cursor 失败，需人工在 app 里确认',
      };
    }
    await delay(2500);
  }
  const openArgs = options.cwd !== undefined && options.cwd.length > 0 ? ['-a', 'Cursor', options.cwd] : ['-a', 'Cursor'];
  commands.push('open ' + openArgs.join(' '));
  const opened = await runCommand('open', openArgs, 30000);
  if (!opened.ok) {
    return {
      platformSupported: true,
      restarted,
      opened: false,
      commands,
      error: opened.error,
      note: '打开 Cursor 失败，需人工在 app 里确认',
    };
  }
  if (!restarted) {
    return {
      platformSupported: true,
      restarted: false,
      opened: true,
      commands,
      note: '已把 Cursor 窗口带到前台；不重启时 app 不会重新读取 composer 表，列表可见性需人工确认',
    };
  }
  await delay(options.waitMs ?? 8000);
  const scanLog = readCursorAgentScanLog(options.home);
  return {
    platformSupported: true,
    restarted: true,
    opened: true,
    commands,
    ...(scanLog !== undefined ? { scanLog } : {}),
    note:
      scanLog !== undefined
        ? 'Cursor 重启后 LocalAgentStorage 扫描到 ' + String(scanLog.found) + ' 个 agent headers（' + (scanLog.timestamp ?? '?') + '）；列表可见性请人工确认'
        : '已重启 Cursor，但没从 main.log 读到 LocalAgentStorage 扫描行；请人工在 app 列表里确认',
  };
}
