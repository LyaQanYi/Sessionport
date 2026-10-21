/**
 * Cursor adapter 测试夹具：在临时目录里造一个小号 state.vscdb。
 * 只依赖 node:test / node:sqlite / node:fs，不引第三方依赖。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrMeta } from '@sessionport/core';

import { workspaceIdentifierFor } from '../src/paths.ts';
import type { CursorWorkspaceIdentifier } from '../src/paths.ts';
import {
  BUBBLE_TYPE_AI,
  BUBBLE_TYPE_HUMAN,
  HEADER_MIGRATED_FLAG_KEY,
  HEADER_TABLE,
  LEGACY_HEADER_BLOB_KEY,
  composerDataKey,
  ensureCursorSchema,
  newUuid,
} from '../src/wire.ts';

export interface FixtureWorkspace {
  workspaceId: string;
  cwd: string;
}

export interface FixtureToolSpec {
  name?: string;
  toolCallId?: string;
  params?: unknown;
  rawArgs?: unknown;
  result?: unknown;
  status?: string;
  tool?: number;
  additionalData?: unknown;
  error?: unknown;
  toolCallBinary?: string;
}

export interface FixtureBubbleSpec {
  bubbleId?: string;
  type: 1 | 2;
  text?: string;
  richText?: string;
  thinking?: { text: string; signature?: string };
  tool?: FixtureToolSpec;
  images?: Array<{ uuid: string; dimension?: { width: number; height: number } }>;
  simulated?: boolean;
  interpreterResults?: unknown[];
  createdAt?: string;
  empty?: boolean;
}

export interface FixtureComposerSpec {
  composerId?: string;
  workspaceId?: string;
  name?: string;
  createdAtMs?: number;
  lastUpdatedAtMs?: number;
  bubbles: FixtureBubbleSpec[];
  isArchived?: boolean;
  subagent?: {
    parentComposerId: string;
    subagentTypeName?: string;
    toolCallId?: string;
  };
  subagentComposerIds?: string[];
  status?: string;
  version?: number;
  /** 只写 composerData，不写 composerHeaders 行 */
  omitHeader?: boolean;
}

export interface CursorFixtureInput {
  composers?: FixtureComposerSpec[];
  workspaces?: FixtureWorkspace[];
  /** 用旧版 ItemTable blob 代替 composerHeaders 表（仅读兼容测试） */
  legacyHeaderBlob?: boolean;
}

export interface CursorFixture {
  home: string;
  dbPath: string;
  workspaceStorage: string;
  cwd: string;
  cleanup: () => void;
  open: () => DatabaseSync;
}

const BASE_MS = 1789214508000;

function bubbleCreatedAt(index: number): string {
  return new Date(BASE_MS + index * 1000).toISOString();
}

function buildBubbleJson(spec: FixtureBubbleSpec, index: number): string {
  const bubbleId = spec.bubbleId ?? newUuid();
  if (spec.empty === true) {
    return JSON.stringify({ _v: 3, type: spec.type, bubbleId, text: '' });
  }
  const bubble: Record<string, unknown> = {
    _v: 3,
    type: spec.type,
    bubbleId,
    createdAt: spec.createdAt ?? bubbleCreatedAt(index),
    requestId: '',
    unifiedMode: 2,
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    conversationState: '~',
  };
  if (spec.text !== undefined) {
    bubble.text = spec.text;
    if (spec.type === BUBBLE_TYPE_HUMAN) {
      bubble.richText = spec.richText ?? JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: spec.text }] }],
      });
    }
  } else {
    bubble.text = '';
  }
  if (spec.richText !== undefined) bubble.richText = spec.richText;
  if (spec.thinking !== undefined) {
    bubble.thinking = { text: spec.thinking.text, signature: spec.thinking.signature ?? '' };
    bubble.capabilityType = 30;
  }
  if (spec.tool !== undefined) {
    const tool = spec.tool;
    bubble.toolFormerData = {
      toolCallId: tool.toolCallId ?? 'call-' + bubbleId,
      name: tool.name ?? 'glob_file_search',
      params: tool.params === undefined ? undefined : typeof tool.params === 'string' ? tool.params : JSON.stringify(tool.params),
      rawArgs:
        tool.rawArgs === undefined
          ? undefined
          : typeof tool.rawArgs === 'string'
            ? tool.rawArgs
            : JSON.stringify(tool.rawArgs),
      result:
        tool.result === undefined
          ? undefined
          : typeof tool.result === 'string'
            ? tool.result
            : JSON.stringify(tool.result),
      status: tool.status ?? 'completed',
      tool: tool.tool ?? 42,
      additionalData: tool.additionalData,
      error: tool.error,
      toolCallBinary: tool.toolCallBinary,
    };
  }
  if (spec.images !== undefined) bubble.images = spec.images;
  if (spec.simulated === true) {
    bubble.isSimulatedMsg = true;
    bubble.simulatedMsgReason = 3;
  }
  if (spec.interpreterResults !== undefined) bubble.interpreterResults = spec.interpreterResults;
  return JSON.stringify(bubble);
}

function buildHeaderEntry(bubbleId: string, spec: FixtureBubbleSpec, index: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    bubbleId,
    type: spec.type,
    createdAt: spec.createdAt ?? bubbleCreatedAt(index),
    grouping:
      spec.thinking !== undefined
        ? { isRenderable: true, capabilityType: 30, hasThinking: true, toolDisplayComputed: true }
        : { isRenderable: true, hasText: spec.empty === true ? undefined : true, toolDisplayComputed: true },
  };
  return entry;
}

export function createCursorFixture(input: CursorFixtureInput = {}): CursorFixture {
  const home = mkdtempSync(join(tmpdir(), 'sessionport-cursor-'));
  const globalDir = join(home, 'User', 'globalStorage');
  mkdirSync(globalDir, { recursive: true });
  const workspaceStorage = join(home, 'User', 'workspaceStorage');
  mkdirSync(workspaceStorage, { recursive: true });

  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const workspaces =
    input.workspaces !== undefined && input.workspaces.length > 0
      ? input.workspaces
      : [{ workspaceId: 'ws-test', cwd }];
  for (const workspace of workspaces) {
    mkdirSync(workspace.cwd, { recursive: true });
    const dir = join(workspaceStorage, workspace.workspaceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ folder: new URL('file://' + workspace.cwd).toString() }));
  }

  const dbPath = join(globalDir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  try {
    ensureCursorSchema(db);
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(HEADER_MIGRATED_FLAG_KEY, '1');
    const legacyHeaders: Array<Record<string, unknown>> = [];
    for (const composer of input.composers ?? []) {
      seedComposer(db, composer, workspaces[0] as FixtureWorkspace, legacyHeaders);
    }
    if (input.legacyHeaderBlob === true) {
      db.exec('DROP TABLE ' + HEADER_TABLE);
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        LEGACY_HEADER_BLOB_KEY,
        JSON.stringify({ allComposers: legacyHeaders }),
      );
    }
  } finally {
    db.close();
  }

  return {
    home,
    dbPath,
    workspaceStorage,
    cwd,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
    open: () => new DatabaseSync(dbPath),
  };
}

function seedComposer(
  db: DatabaseSync,
  spec: FixtureComposerSpec,
  workspace: FixtureWorkspace,
  legacyHeaders: Array<Record<string, unknown>>,
): string {
  const composerId = spec.composerId ?? newUuid();
  const workspaceId = spec.workspaceId ?? workspace.workspaceId;
  const createdAtMs = spec.createdAtMs ?? BASE_MS;
  const lastUpdatedAtMs = spec.lastUpdatedAtMs ?? createdAtMs + ((spec.bubbles.length + 1) * 1000);
  const workspaceIdentifier: CursorWorkspaceIdentifier = workspaceIdentifierFor(workspaceId, workspace.cwd);

  const headers: Array<Record<string, unknown>> = [];
  const bubbleRows: Array<{ key: string; json: string }> = [];
  spec.bubbles.forEach((bubble, index) => {
    const bubbleId = bubble.bubbleId ?? newUuid();
    const header = buildHeaderEntry(bubbleId, bubble, index);
    // 让 create-time 与 composer 时间一致，保证排序断言稳定
    headers.push(header);
    bubbleRows.push({
      key: 'bubbleId:' + composerId + ':' + bubbleId,
      json: buildBubbleJson({ ...bubble, bubbleId }, index),
    });
  });

  const composerData: Record<string, unknown> = {
    _v: spec.version ?? 18,
    composerId,
    name: spec.name,
    richText: '',
    hasLoaded: true,
    text: '',
    fullConversationHeadersOnly: headers,
    conversationMap: {},
    status: spec.status ?? 'completed',
    createdAt: createdAtMs,
    lastUpdatedAt: lastUpdatedAtMs,
    conversationCheckpointLastUpdatedAt: lastUpdatedAtMs,
    isAgentic: true,
    unifiedMode: 'agent',
    forceMode: 'edit',
    modelConfig: { modelName: 'grok-4.7', maxMode: false },
    workspaceIdentifier,
    subagentComposerIds: spec.subagentComposerIds ?? [],
    subComposerIds: [],
    context: {},
    capabilities: [],
  };
  if (spec.subagent !== undefined) {
    composerData.subagentInfo = {
      parentComposerId: spec.subagent.parentComposerId,
      subagentTypeName: spec.subagent.subagentTypeName ?? 'general-purpose',
      toolCallId: spec.subagent.toolCallId,
    };
  }

  const headerValue: Record<string, unknown> = {
    type: 'head',
    composerId,
    name: spec.name,
    createdAt: createdAtMs,
    lastUpdatedAt: lastUpdatedAtMs,
    conversationCheckpointLastUpdatedAt: lastUpdatedAtMs,
    unifiedMode: 'agent',
    forceMode: 'edit',
    hasUnreadMessages: false,
    isDraft: false,
    numSubComposers: (spec.subagentComposerIds ?? []).length,
    workspaceIdentifier,
  };
  if (spec.isArchived === true) headerValue.isArchived = true;
  if (spec.subagent !== undefined) {
    headerValue.subagentInfo = {
      parentComposerId: spec.subagent.parentComposerId,
      subagentTypeName: spec.subagent.subagentTypeName ?? 'general-purpose',
    };
  }

  const insertKv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  insertKv.run(composerDataKey(composerId), JSON.stringify(composerData));
  for (const row of bubbleRows) insertKv.run(row.key, row.json);

  if (spec.omitHeader !== true) {
    db.prepare(
      'INSERT INTO ' +
        HEADER_TABLE +
        ' (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, subagentTypeName, value) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      composerId,
      workspaceId,
      createdAtMs,
      lastUpdatedAtMs,
      spec.isArchived === true ? 1 : 0,
      spec.subagent !== undefined ? 1 : 0,
      lastUpdatedAtMs,
      lastUpdatedAtMs,
      spec.subagent?.subagentTypeName ?? '',
      JSON.stringify(headerValue),
    );
  }
  legacyHeaders.push(headerValue);
  return composerId;
}

// ---------------------------------------------------------------------------
// IR bundle helpers（写测试用）
// ---------------------------------------------------------------------------

export function makeIrBundle(
  events: Array<Omit<IrEvent, 'id' | 'parentId'>>,
  meta: IrMeta = {},
  children: IrBundle['children'] = [],
): IrBundle {
  let parentId: string | null = null;
  const chained: IrEvent[] = [];
  events.forEach((event, index) => {
    const id = 'ir:e' + String(index + 1).padStart(6, '0');
    chained.push({ ...(event as IrEvent), id, parentId });
    parentId = id;
  });
  return {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: 'test:root',
      source: { agent: 'claude-code', nativeSessionId: 'claude-session-1', nativePath: '/tmp/claude.jsonl' },
      meta: { cwd: '/tmp/work', title: '测试会话', model: 'claude-sonnet', createdAt: new Date(BASE_MS).toISOString(), ...meta },
      events: chained,
      head: chained.length > 0 ? (chained[chained.length - 1] as IrEvent).id : null,
      notices: [],
    },
    children,
  };
}

export function userMessage(text: string, at = new Date(BASE_MS).toISOString()) {
  return { kind: 'message', role: 'user', parts: [{ type: 'text', text }], at } as const;
}

export function assistantMessage(text: string, at = new Date(BASE_MS + 1000).toISOString()) {
  return { kind: 'message', role: 'assistant', parts: [{ type: 'text', text }], at } as const;
}

export function reasoningEvent(text: string, at = new Date(BASE_MS + 500).toISOString()) {
  return { kind: 'reasoning', reasoning: { kind: 'plain', text }, at } as const;
}

export function toolCallEvent(callId: string, name: string, input: unknown, at = new Date(BASE_MS + 1500).toISOString()) {
  return { kind: 'tool_call', callId, name, input, at } as const;
}

export function toolResultEvent(callId: string, text: string, at = new Date(BASE_MS + 2000).toISOString()) {
  return { kind: 'tool_result', callId, content: [{ type: 'text', text }], at } as const;
}

export { BASE_MS, BUBBLE_TYPE_AI, BUBBLE_TYPE_HUMAN };
