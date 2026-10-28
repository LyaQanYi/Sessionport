import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { qoderProjectKey } from '../src/wire.ts';

export const QD_SESSION_ID = '44444444-4444-4444-8444-444444444444';
export const QD_CWD = '/tmp/qoder-project';
export const QD_AGENT_ID = 'aExplore-abc123';
export const QD_T0 = Date.parse('2026-10-16T00:00:00.000Z');

function iso(offsetMs: number): string {
  return new Date(QD_T0 + offsetMs).toISOString();
}

export function qdTranscriptLines(sessionId = QD_SESSION_ID, cwd = QD_CWD): Array<Record<string, unknown>> {
  return [
    { type: 'workspace-directories', sessionId, directories: [cwd] },
    { type: 'runtime-config', sessionId, model: 'qfmodel', reasoningEffort: null, contextWindow: null, generation: null, timestamp: QD_T0 },
    { type: 'worktree-state', sessionId, worktreeSession: null },
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: iso(10),
      message: { role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
      humanInput: { text: '第一个问题', mode: 'prompt' },
      origin: { kind: 'human' },
      promptId: 'p1',
      requestSetId: '00000000-0000-4000-8000-000000000001',
      businessModelKey: 'qfmodel',
      parentUuid: null,
      isSidechain: false,
      cwd,
      sessionId,
      userType: 'external',
      entrypoint: 'cli',
      version: '1.1.69',
    },
    {
      type: 'attachment',
      uuid: '00000000-0000-4000-8000-000000000002',
      parentUuid: '00000000-0000-4000-8000-000000000001',
      timestamp: iso(20),
      attachment: { type: 'skill_listing', content: '- skill: test' },
      sessionId,
      cwd,
      isSidechain: false,
      entrypoint: 'cli',
      version: '1.1.69',
    },
    { type: 'active-leaf', sessionId, leafUuid: '00000000-0000-4000-8000-000000000002', explicit: false, timestamp: QD_T0 + 20 },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000003',
      parentUuid: '00000000-0000-4000-8000-000000000002',
      timestamp: iso(100),
      message: { id: 'chatcmpl-test-1', type: 'message', role: 'assistant', model: 'qfmodel', stop_reason: null, stop_sequence: null, content: [{ type: 'thinking', thinking: '先查看目录', signature: '' }] },
      requestTokenAnchor: { request: 'r'.repeat(64), response: 's'.repeat(64), requestId: 'req-1' },
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: '1.1.69',
    },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000004',
      parentUuid: '00000000-0000-4000-8000-000000000003',
      timestamp: iso(100),
      message: { id: 'chatcmpl-test-1', type: 'message', role: 'assistant', model: 'qfmodel', stop_reason: null, stop_sequence: null, content: [{ type: 'text', text: '我看一下。' }] },
      requestTokenAnchor: { request: 'r'.repeat(64), response: 's'.repeat(64), requestId: 'req-1' },
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: '1.1.69',
    },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000005',
      parentUuid: '00000000-0000-4000-8000-000000000004',
      timestamp: iso(100),
      message: { id: 'chatcmpl-test-1', type: 'message', role: 'assistant', model: 'qfmodel', stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] },
      requestTokenAnchor: { request: 'r'.repeat(64), response: 's'.repeat(64), requestId: 'req-1' },
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: '1.1.69',
    },
    { type: 'active-leaf', sessionId, leafUuid: '00000000-0000-4000-8000-000000000005', explicit: false, timestamp: QD_T0 + 100 },
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000006',
      parentUuid: '00000000-0000-4000-8000-000000000005',
      timestamp: iso(200),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'README.md\nsrc' }] },
      toolUseResult: { kind: 'completed', stdout: 'README.md\nsrc' },
      sourceToolAssistantUUID: '00000000-0000-4000-8000-000000000005',
      promptId: 'p1',
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: '1.1.69',
    },
    { type: 'active-leaf', sessionId, leafUuid: '00000000-0000-4000-8000-000000000006', explicit: false, timestamp: QD_T0 + 200 },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000007',
      parentUuid: '00000000-0000-4000-8000-000000000006',
      timestamp: iso(300),
      message: { id: 'chatcmpl-test-2', type: 'message', role: 'assistant', model: 'qfmodel', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: '目录里有 README.md 和 src。' }] },
      requestTokenAnchor: { request: 't'.repeat(64), response: 'u'.repeat(64), requestId: 'req-2' },
      sessionId,
      cwd,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      version: '1.1.69',
    },
    { type: 'active-leaf', sessionId, leafUuid: '00000000-0000-4000-8000-000000000007', explicit: false, timestamp: QD_T0 + 300 },
    { type: 'user', uuid: '00000000-0000-4000-8000-00000000000a', timestamp: iso(10), message: { role: 'user', content: [{ type: 'text', text: '被放弃的旧分支' }] }, parentUuid: '00000000-0000-4000-8000-000000000001', sessionId, cwd, isSidechain: false },
    { type: 'assistant', uuid: '00000000-0000-4000-8000-00000000000b', parentUuid: '00000000-0000-4000-8000-00000000000a', timestamp: iso(15), message: { id: 'chatcmpl-old', type: 'message', role: 'assistant', model: 'qfmodel', content: [{ type: 'text', text: '旧分支的回答' }] }, sessionId, cwd, isSidechain: false },
    { type: 'last-prompt', sessionId, lastPrompt: '第二个问题' },
    { type: 'active-leaf', sessionId, leafUuid: '00000000-0000-4000-8000-000000000007', explicit: false, timestamp: QD_T0 + 400 },
  ];
}

export function qdSubagentLines(agentId = QD_AGENT_ID, sessionId = QD_SESSION_ID, cwd = QD_CWD): Array<Record<string, unknown>> {
  return [
    { type: 'user', uuid: '00000000-0000-4000-8000-0000000000c1', timestamp: iso(110), message: { role: 'user', content: '子代理任务：探索 src' }, sessionId, cwd },
    { type: 'assistant', uuid: '00000000-0000-4000-8000-0000000000c2', parentUuid: '00000000-0000-4000-8000-0000000000c1', timestamp: iso(120), message: { id: 'chatcmpl-sub', type: 'message', role: 'assistant', model: 'qfmodel', content: [{ type: 'text', text: 'src 里有 index.ts' }] }, sessionId, cwd },
  ];
}

export interface QoderFixtureOptions {
  lines?: Array<Record<string, unknown>>;
  sessionId?: string;
  cwd?: string;
  withSubagent?: boolean;
}

export function writeQoderFixture(home: string, options: QoderFixtureOptions = {}): { home: string; sessionId: string; path: string; cwd: string } {
  const sessionId = options.sessionId ?? QD_SESSION_ID;
  const cwd = options.cwd ?? QD_CWD;
  const dir = join(home, 'projects', qoderProjectKey(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId + '.jsonl');
  const lines = options.lines ?? qdTranscriptLines(sessionId, cwd);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  if (options.withSubagent === true) {
    const subDir = join(dir, sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-' + QD_AGENT_ID + '.jsonl'), qdSubagentLines(QD_AGENT_ID, sessionId, cwd).map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
    writeFileSync(
      join(subDir, 'agent-' + QD_AGENT_ID + '.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'call_sub', description: '探索 src', invocationName: 'Explore' }),
      'utf8',
    );
  }
  return { home, sessionId, path, cwd };
}
