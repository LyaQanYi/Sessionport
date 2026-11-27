/**
 * Cursor ~/.cursor/projects/<slug>/agent-transcripts/<composerId>/<composerId>.jsonl 轻量解析与回落读取。
 *
 * 当 state.vscdb 中只保留了 composerHeaders 索引而 composerData / bubbleId 已被清理，
 * 或 Cursor CLI 创建的独立对话只在 agent-transcripts 中留存时，从这里恢复只读会话内容。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { AgentId, IrBundle, IrChildSession, IrContent, IrEvent, IrEventInput, IrNotice, IrPart, IrSession } from '@sessionport/core';

import { listCursorTranscriptSubagents } from './paths.ts';
import { isRecord } from './wire.ts';

const CURSOR_AGENT_ID = 'cursor' as AgentId;

export interface CursorTranscriptInspection {
  hasConversation: boolean;
  firstUserText?: string;
}

export interface CursorTranscriptReadHints {
  composerId?: string;
  title?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  includeChildren?: boolean;
}

function parseLineTimestamp(text: string): string | undefined {
  const match = /<timestamp>\s*([^<\n]+?)\s*<\/timestamp>/i.exec(text);
  if (match === null || match[1] === undefined) return undefined;
  // 先去掉末尾的 " (UTC+8)" 这类时区注释，若 Date.parse 可识别则转 ISO
  const candidate = match[1].replace(/\s*\(UTC[+-]?\d+(?::\d+)?\)\s*$/i, '').trim();
  const ms = Date.parse(candidate);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  const rawMs = Date.parse(match[1]);
  return Number.isFinite(rawMs) ? new Date(rawMs).toISOString() : undefined;
}

export function extractCursorTranscriptQueryText(rawText: string): string {
  let cleaned = rawText.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '').trim();
  const queryMatch = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(cleaned);
  if (queryMatch?.[1] !== undefined) cleaned = queryMatch[1].trim();
  // 如果以 <cursor_commands> 等元块开头，尽量剥离前置标签
  cleaned = cleaned.replace(/^<cursor_commands>[\s\S]*?<\/cursor_commands>/i, '').trim();
  return cleaned;
}

function collectTextFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      out.push(item.text);
    }
  }
  return out.join('\n');
}

function lineHasConversation(obj: Record<string, unknown>): boolean {
  if (obj.role !== 'user' && obj.role !== 'assistant') return false;
  const msg = isRecord(obj.message) ? obj.message : undefined;
  const content = msg?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0;
    return block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'thinking';
  });
}

/** 快速检查 transcript JSONL 是否含真实对话并提取首条用户标题 */
export function inspectCursorTranscript(filePath: string): CursorTranscriptInspection {
  let head = '';
  try {
    const raw = readFileSync(filePath, 'utf8');
    head = raw.length > 64 * 1024 ? raw.slice(0, 64 * 1024) : raw;
  } catch {
    return { hasConversation: false };
  }

  let hasConversation = false;
  let firstUserText: string | undefined;
  for (const rawLine of head.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (lineHasConversation(parsed)) hasConversation = true;
    if (firstUserText === undefined && parsed.role === 'user') {
      const msg = isRecord(parsed.message) ? parsed.message : undefined;
      const rawText = collectTextFromBlocks(msg?.content);
      const cleaned = extractCursorTranscriptQueryText(rawText).replace(/\s+/gu, ' ').trim();
      if (cleaned.length > 0) {
        firstUserText = cleaned.length > 100 ? cleaned.slice(0, 100) + '…' : cleaned;
      }
    }
    if (hasConversation && firstUserText !== undefined) break;
  }
  return { hasConversation, ...(firstUserText !== undefined ? { firstUserText } : {}) };
}

function parseToolResultContent(rawContent: unknown): IrContent[] {
  if (typeof rawContent === 'string') return rawContent.length > 0 ? [{ type: 'text', text: rawContent }] : [];
  if (Array.isArray(rawContent)) {
    const text = collectTextFromBlocks(rawContent);
    if (text.length > 0) return [{ type: 'text', text }];
    return [{ type: 'json', value: rawContent }];
  }
  if (rawContent !== undefined && rawContent !== null) return [{ type: 'json', value: rawContent }];
  return [];
}

function parseSingleTranscriptFile(
  filePath: string,
  hints: CursorTranscriptReadHints,
): IrSession {
  const raw = readFileSync(filePath, 'utf8');
  const mtimeMs = (() => {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const composerId = hints.composerId ?? basename(filePath, '.jsonl');
  const fallbackAt = hints.createdAt ?? (mtimeMs > 0 ? new Date(mtimeMs).toISOString() : new Date(0).toISOString());

  const events: IrEvent[] = [];
  const push = (event: IrEventInput): void => {
    const id = 'cursor:e' + String(events.length + 1).padStart(6, '0');
    const parentId = events.length === 0 ? null : events[events.length - 1]!.id;
    events.push({ ...(event as IrEvent), id, parentId });
  };

  let badLines = 0;
  let currentAt = fallbackAt;
  let toolCallSeq = 0;
  let firstUserTitle: string | undefined;
  let lastUserPrompt: string | undefined;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!isRecord(obj)) continue;
    if (obj.type === 'turn_ended') continue;

    const msg = isRecord(obj.message) ? obj.message : undefined;
    const content = msg?.content;

    if (obj.role === 'user') {
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
      const parts: IrPart[] = [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
          const parsedAt = parseLineTimestamp(block.text);
          if (parsedAt !== undefined) currentAt = parsedAt;
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_result') {
          const callId = typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0 ? block.tool_use_id : 'cursor-tr-res';
          push({
            kind: 'tool_result',
            at: currentAt,
            callId,
            content: parseToolResultContent(block.content),
            isError: block.is_error === true,
          });
        }
      }
      if (parts.length > 0) {
        push({ kind: 'message', at: currentAt, role: 'user', parts });
        const queryText = extractCursorTranscriptQueryText(collectTextFromBlocks(blocks)).replace(/\s+/gu, ' ').trim();
        if (queryText.length > 0) {
          if (firstUserTitle === undefined) firstUserTitle = queryText.length > 80 ? queryText.slice(0, 80) + '…' : queryText;
          lastUserPrompt = queryText.slice(0, 200);
        }
      }
      continue;
    }

    if (obj.role === 'assistant') {
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === 'thinking') {
          const thinkingText = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
          if (thinkingText.trim().length > 0) {
            push({ kind: 'reasoning', at: currentAt, reasoning: { kind: 'plain', text: thinkingText } });
          }
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
          push({ kind: 'message', at: currentAt, role: 'assistant', parts: [{ type: 'text', text: block.text }] });
        } else if (block.type === 'tool_use') {
          toolCallSeq += 1;
          const callId =
            typeof block.id === 'string' && block.id.length > 0 ? block.id : 'cursor-tr-' + String(toolCallSeq);
          const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
          push({ kind: 'tool_call', at: currentAt, callId, name, input: block.input ?? null });
        } else if (block.type === 'tool_result') {
          const callId = typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0 ? block.tool_use_id : 'cursor-tr-res';
          push({
            kind: 'tool_result',
            at: currentAt,
            callId,
            content: parseToolResultContent(block.content),
            isError: block.is_error === true,
          });
        }
      }
    }
  }

  const notices: IrNotice[] = [
    {
      code: 'cursor.transcript-fallback',
      message: '从 Cursor agent-transcripts JSONL 读取（state.vscdb 缺少气泡或 CLI 会话；不含模型思考签名与工具输出）',
      severity: 'info',
    },
  ];
  if (badLines > 0) {
    notices.push({
      code: 'cursor.bad-bubble',
      message: 'transcript JSONL 中有无法解析的行，已跳过',
      count: badLines,
      severity: 'warning',
    });
  }

  const updatedAt = hints.updatedAt ?? (mtimeMs > 0 ? new Date(mtimeMs).toISOString() : undefined);
  return {
    id: 'cursor:' + composerId,
    source: {
      agent: CURSOR_AGENT_ID,
      formatVersion: 'transcript-jsonl',
      nativeSessionId: composerId,
      nativePath: filePath,
    },
    meta: {
      ...(hints.cwd !== undefined ? { cwd: hints.cwd } : {}),
      ...(hints.title ?? firstUserTitle ? { title: hints.title ?? firstUserTitle } : {}),
      ...(hints.createdAt !== undefined ? { createdAt: hints.createdAt } : events[0] ? { createdAt: events[0].at } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(hints.archived === true ? { archived: true } : {}),
      ...(lastUserPrompt !== undefined ? { lastPrompt: lastUserPrompt } : {}),
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };
}

export function readCursorTranscriptSession(filePath: string, hints: CursorTranscriptReadHints = {}): IrBundle {
  const composerId = hints.composerId ?? basename(filePath, '.jsonl');
  const root = parseSingleTranscriptFile(filePath, { ...hints, composerId });
  const children: IrChildSession[] = [];

  if (hints.includeChildren !== false) {
    const subFiles = listCursorTranscriptSubagents(filePath);
    for (const subPath of subFiles) {
      const subId = basename(subPath, '.jsonl');
      if (subId === composerId) continue;
      const childSession = parseSingleTranscriptFile(subPath, {
        composerId: subId,
        cwd: root.meta.cwd,
        includeChildren: false,
      });
      if (childSession.events.length === 0) continue;
      children.push({
        session: childSession,
        parentSessionId: composerId,
        label: basename(dirname(subPath)) === 'subagents' ? subId.slice(0, 8) : basename(dirname(subPath)),
      });
    }
    if (children.length > 0) {
      root.notices.push({
        code: 'cursor.transcript-subagents',
        message: '已从 agent-transcripts/subagents 目录读取子代理会话',
        count: children.length,
        severity: 'info',
      });
    }
  }

  return {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root,
    children,
  };
}
