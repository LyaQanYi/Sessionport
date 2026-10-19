/**
 * Claude Code 行的构造。字段清单来自真实会话样本（2.1.303，652 个 jsonl）
 * 与 spike 实测，集中在这里方便随格式漂移调整。
 */

export interface ClaudeUserRow {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  version: string;
  gitBranch: string;
  isSidechain: boolean;
  userType: 'external';
  isMeta?: boolean;
  message: { role: 'user'; content: unknown[] };
}

export interface ClaudeAssistantRow {
  type: 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  version: string;
  gitBranch: string;
  isSidechain: boolean;
  userType: 'external';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: unknown[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export type ClaudeRow = ClaudeUserRow | ClaudeAssistantRow;

export interface RowContext {
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
}

export function textBlock(text: string): unknown {
  return { type: 'text', text };
}

export function toolUseBlock(callId: string, name: string, input: unknown): unknown {
  return { type: 'tool_use', id: callId, name, input: input ?? {} };
}

export function toolResultBlock(callId: string, content: string, isError?: boolean): unknown {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: callId, content };
  if (isError) block.is_error = true;
  return block;
}

export function buildUserRow(ctx: RowContext, message: { uuid: string }, content: unknown[], opts: { isMeta?: boolean } = {}): ClaudeUserRow {
  const row: ClaudeUserRow = {
    type: 'user',
    uuid: message.uuid,
    parentUuid: null,
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    cwd: ctx.cwd,
    version: ctx.version,
    gitBranch: ctx.gitBranch,
    isSidechain: false,
    userType: 'external',
    message: { role: 'user', content },
  };
  if (opts.isMeta) row.isMeta = true;
  return row;
}

export function buildAssistantRow(
  ctx: RowContext,
  message: { uuid: string; messageId: string; model: string },
  content: unknown[],
): ClaudeAssistantRow {
  return {
    type: 'assistant',
    uuid: message.uuid,
    parentUuid: null,
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    cwd: ctx.cwd,
    version: ctx.version,
    gitBranch: ctx.gitBranch,
    isSidechain: false,
    userType: 'external',
    message: {
      id: message.messageId,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}
