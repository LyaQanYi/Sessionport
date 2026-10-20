import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { workBuddyProjectKey } from '../src/wire.ts';

export const WB_SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const WB_CWD = '/tmp/wb-project';
export const WB_START = 1790000000000;

export function wbTranscriptLines(): Array<Record<string, unknown>> {
  return [
    { type: 'session-meta', id: 'meta-1', sessionId: WB_SESSION_ID, timestamp: WB_START, meta: { 'codebuddy.ai/hostKind': 'unopted' } },
    {
      type: 'message',
      id: 'u1',
      role: 'user',
      sessionId: WB_SESSION_ID,
      cwd: WB_CWD,
      timestamp: WB_START + 10,
      content: [
        {
          type: 'input_text',
          text: '<system-reminder data-role="user-context">\n<user_info>OS: darwin</user_info>\n</system-reminder>\n<user_query>你好，帮我看看目录</user_query>',
        },
      ],
      providerData: { model: 'step-5-preview' },
    },
    { type: 'file-history-snapshot', timestamp: WB_START + 20, messageId: 'u1', snapshot: { messageId: 'u1', trackedFileBackups: {} }, cwd: WB_CWD },
    { type: 'ai-title', id: 't1', timestamp: WB_START + 30, aiTitle: 'WorkBuddy 测试会话', cwd: WB_CWD },
    {
      type: 'reasoning',
      id: 'r1',
      parentId: 'u1',
      timestamp: WB_START + 100,
      content: [],
      rawContent: [{ type: 'reasoning_text', text: '先列目录' }],
      providerData: { model: 'step-5-preview' },
      sessionId: WB_SESSION_ID,
      cwd: WB_CWD,
    },
    {
      type: 'function_call',
      id: 'fc1',
      parentId: 'r1',
      callId: 'call_1',
      name: 'Bash',
      arguments: '{"command":"ls"}',
      timestamp: WB_START + 110,
      sessionId: WB_SESSION_ID,
      cwd: WB_CWD,
    },
    {
      type: 'function_call_result',
      id: 'fr1',
      parentId: 'fc1',
      callId: 'call_1',
      name: 'Bash',
      status: 'completed',
      output: { type: 'text', text: 'README.md\nsrc' },
      timestamp: WB_START + 200,
      sessionId: WB_SESSION_ID,
      cwd: WB_CWD,
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'fr1',
      role: 'assistant',
      status: 'completed',
      timestamp: WB_START + 300,
      content: [{ type: 'output_text', text: '目录里有 README.md 和 src。' }],
      providerData: { model: 'step-5-preview' },
      sessionId: WB_SESSION_ID,
      cwd: WB_CWD,
    },
    { type: 'credit-usage', id: 'c1', timestamp: WB_START + 310, sessionId: WB_SESSION_ID },
    { type: 'resend-fork-notice', id: 'f1', timestamp: WB_START + 320, editedUserItemId: 'u1' },
  ];
}

export function wbSubagentLines(agentId: string): Array<Record<string, unknown>> {
  return [
    { type: 'session-meta', id: 'cmeta', sessionId: agentId, timestamp: WB_START + 120 },
    {
      type: 'message',
      id: 'cu1',
      role: 'user',
      timestamp: WB_START + 130,
      content: [{ type: 'input_text', text: '子代理任务：探索 src' }],
      sessionId: agentId,
      cwd: WB_CWD,
    },
    {
      type: 'reasoning',
      id: 'cr1',
      parentId: 'cu1',
      timestamp: WB_START + 140,
      rawContent: [{ type: 'reasoning_text', text: '看看 src' }],
      sessionId: agentId,
      cwd: WB_CWD,
    },
    {
      type: 'message',
      id: 'ca1',
      parentId: 'cr1',
      role: 'assistant',
      status: 'completed',
      timestamp: WB_START + 150,
      content: [{ type: 'output_text', text: 'src 里有 index.ts' }],
      sessionId: agentId,
      cwd: WB_CWD,
    },
  ];
}

export interface WorkBuddyFixtureOptions {
  includeSubagent?: boolean;
  lines?: Array<Record<string, unknown>>;
  sessionId?: string;
}

/** 在临时 home 下铺一份 projects/<slug>/<id>.jsonl（+ 可选子代理） */
export function writeWorkBuddyFixture(home: string, options: WorkBuddyFixtureOptions = {}): { home: string; sessionId: string; path: string } {
  const sessionId = options.sessionId ?? WB_SESSION_ID;
  const projectDir = join(home, 'projects', workBuddyProjectKey(WB_CWD));
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, sessionId + '.jsonl');
  const lines = options.lines ?? wbTranscriptLines();
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  if (options.includeSubagent === true) {
    const agentId = '22222222-2222-4222-8222-222222222222';
    const subDir = join(projectDir, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-' + agentId + '.jsonl'), wbSubagentLines(agentId).map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  }
  return { home, sessionId, path };
}
