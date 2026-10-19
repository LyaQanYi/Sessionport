import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { AgentId, IrBundle, IrContent, IrEvent, IrBundle as Bundle } from '@sessionport/core';

export const WORK_ROOT = join(process.cwd(), '.spikes', 'dsh-verify');

export async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(WORK_ROOT, { recursive: true });
  return mkdtemp(join(WORK_ROOT, prefix));
}

interface PartialEvent {
  kind: 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'boundary';
  at?: string;
  role?: 'user' | 'assistant';
  parts?: Array<{ type: 'text'; text: string }>;
  synthetic?: boolean;
  reasoning?: { kind: 'plain'; text: string };
  callId?: string;
  name?: string;
  input?: unknown;
  content?: IrContent[];
  isError?: boolean;
  boundary?: 'fork' | 'undo' | 'compact' | 'cancel';
  detail?: string;
}

export function chainEvents(partials: PartialEvent[]): IrEvent[] {
  const out: IrEvent[] = [];
  const base = Date.parse('2026-10-19T06:00:00.000Z');
  partials.forEach((partial, index) => {
    const id = 'synthetic-e' + String(index + 1).padStart(3, '0');
    const parentId = index === 0 ? null : 'synthetic-e' + String(index).padStart(3, '0');
    const at = partial.at ?? new Date(base + index * 1000).toISOString();
    const common = { id, parentId, at };
    switch (partial.kind) {
      case 'message': {
        const event: IrEvent = {
          ...common,
          kind: 'message',
          role: partial.role ?? 'user',
          parts: partial.parts ?? [{ type: 'text', text: 'message' }],
        };
        if (partial.synthetic === true) (event as { synthetic?: boolean }).synthetic = true;
        out.push(event);
        break;
      }
      case 'reasoning':
        out.push({ ...common, kind: 'reasoning', reasoning: partial.reasoning ?? { kind: 'plain', text: 'reasoning' } });
        break;
      case 'tool_call':
        out.push({ ...common, kind: 'tool_call', callId: partial.callId ?? 'call_1', name: partial.name ?? 'bash', input: partial.input ?? { command: 'ls' } });
        break;
      case 'tool_result':
        out.push({ ...common, kind: 'tool_result', callId: partial.callId ?? 'call_1', content: partial.content ?? [{ type: 'text', text: 'ok' }], isError: partial.isError === true });
        break;
      case 'boundary':
        out.push({ ...common, kind: 'boundary', boundary: partial.boundary ?? 'compact', detail: partial.detail });
        break;
    }
  });
  return out;
}

export function buildSyntheticBundle(cwd: string): IrBundle {
  const events = chainEvents([
    { kind: 'message', role: 'user', parts: [{ type: 'text', text: '请检查项目结构' }] },
    { kind: 'reasoning', reasoning: { kind: 'plain', text: '先看看目录里有什么' } },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: '我先列出目录。' }] },
    { kind: 'tool_call', callId: 'call_ls', name: 'bash', input: { command: 'ls -la' } },
    { kind: 'tool_result', callId: 'call_ls', content: [{ type: 'text', text: 'README.md\npackage.json' }] },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: '目录里有 README 和 package.json。' }] },
    { kind: 'message', role: 'user', parts: [{ type: 'text', text: '谢谢' }] },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: '不客气。' }] },
    { kind: 'boundary', boundary: 'compact', detail: 'test compact boundary' },
    { kind: 'message', role: 'user', synthetic: true, parts: [{ type: 'text', text: '<system-reminder>runtime note</system-reminder>' }] },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: '收到运行时提示。' }] },
    { kind: 'tool_call', callId: 'call_missing', name: 'bash', input: { command: 'pwd' } },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: '最后一条调用源端没有结果。' }] },
  ]);
  const bundle: Bundle = {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: 'synthetic:root',
      source: { agent: 'claude-code' as AgentId, nativeSessionId: 'synthetic-session', formatVersion: '1' },
      meta: {
        cwd,
        title: '合成往返会话',
        createdAt: '2026-10-19T06:00:00.000Z',
        updatedAt: '2026-10-19T06:10:00.000Z',
        model: 'deepseek-v4.1-flash',
        profile: 'standard',
      },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
  return bundle;
}

/** 英文 canary 会话：用于断言模型可见上下文是否被真实回放。 */
export function buildCanaryBundle(cwd: string): IrBundle {
  const events = chainEvents([
    { kind: 'message', role: 'user', parts: [{ type: 'text', text: 'MOCK_CANARY_USER_ALPHA' }] },
    { kind: 'reasoning', reasoning: { kind: 'plain', text: 'MOCK_CANARY_REASONING_GAMMA' } },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: 'MOCK_CANARY_ASSISTANT_BETA' }] },
    { kind: 'tool_call', callId: 'call_mock_1', name: 'bash', input: { command: 'echo MOCK_CANARY_TOOL_DELTA' } },
    { kind: 'tool_result', callId: 'call_mock_1', content: [{ type: 'text', text: 'MOCK_CANARY_TOOL_RESULT_EPSILON' }] },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: 'MOCK_CANARY_FINAL_ZETA' }] },
  ]);
  const bundle: Bundle = {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: 'synthetic:canary',
      source: { agent: 'claude-code' as AgentId, nativeSessionId: 'canary' },
      meta: { cwd, title: 'mock canary resume', createdAt: '2026-10-19T07:00:00.000Z', model: 'mock-model' },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
  return bundle;
}

export function buildMinimalBundle(cwd: string): IrBundle {
  const events = chainEvents([
    { kind: 'message', role: 'user', parts: [{ type: 'text', text: '会话导入测试：请回答 OK' }] },
    { kind: 'message', role: 'assistant', parts: [{ type: 'text', text: 'OK' }] },
  ]);
  const bundle: Bundle = {
    irVersion: IR_VERSION,
    createdAt: new Date().toISOString(),
    root: {
      id: 'synthetic:minimal',
      source: { agent: 'claude-code' as AgentId, nativeSessionId: 'synthetic-minimal' },
      meta: { cwd, title: '最小导入会话', createdAt: '2026-10-19T06:00:00.000Z' },
      events,
      head: events[events.length - 1]!.id,
      notices: [],
    },
    children: [],
  };
  return bundle;
}
