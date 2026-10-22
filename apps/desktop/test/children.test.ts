import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrChildSession, IrEvent, IrSession } from '@sessionport/core';

import { selectSession } from '../src/main/services.ts';

function session(id: string, nativeId: string, title: string, profile?: string): IrSession {
  const events: IrEvent[] = [
    {
      kind: 'message',
      id: id + ':e1',
      parentId: null,
      at: '2026-01-01T00:00:00.000Z',
      role: 'user',
      parts: [{ type: 'text', text: title }],
    },
    {
      kind: 'message',
      id: id + ':e2',
      parentId: id + ':e1',
      at: '2026-01-01T00:00:01.000Z',
      role: 'assistant',
      parts: [{ type: 'text', text: 'ok' }],
    },
  ];
  return {
    id,
    source: { agent: 'claude-code', nativeSessionId: nativeId },
    meta: { cwd: '/tmp/sessionport-desktop-children', title, ...(profile !== undefined ? { profile } : {}) },
    events,
    head: events[events.length - 1]!.id,
    notices: [],
  };
}

function childSession(id: string, nativeId: string, title: string, profile?: string): IrChildSession {
  return {
    session: session(id, nativeId, title, profile),
    parentSessionId: 'claude-code:root',
    label: 'agent-' + nativeId,
    viaToolCallId: 'tool_' + nativeId,
  };
}

function makeBundle(): IrBundle {
  return {
    irVersion: IR_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    root: session('claude-code:root', 'root-native', '主会话'),
    children: [
      childSession('claude-code:root:agent-aaa', 'aaa', '子代理 A', 'workflow-subagent'),
      childSession('claude-code:root:agent-bbb', 'bbb', '子代理 B', 'general-purpose'),
    ],
  };
}

test('selectSession：不传 childId 返回根会话 + 子代理摘要', () => {
  const picked = selectSession(makeBundle());
  assert.equal(picked.isChild, false);
  assert.equal(picked.session.id, 'claude-code:root');
  assert.equal(picked.children.length, 2);
  assert.deepEqual(
    picked.children.map((child) => child.title),
    ['子代理 A', '子代理 B'],
  );
  assert.equal(picked.children[0]!.profile, 'workflow-subagent');
  assert.equal(picked.children[0]!.events, 2);
  assert.equal(picked.children[0]!.label, 'agent-aaa');
  assert.equal(picked.children[0]!.viaToolCallId, 'tool_aaa');
});

test('selectSession：按 IR child id 下钻', () => {
  const picked = selectSession(makeBundle(), 'claude-code:root:agent-bbb');
  assert.equal(picked.isChild, true);
  assert.equal(picked.session.id, 'claude-code:root:agent-bbb');
  assert.equal(picked.session.meta.title, '子代理 B');
  assert.equal(picked.session.meta.profile, 'general-purpose');
  assert.deepEqual(picked.children, []);
});

test('selectSession：也接受 nativeSessionId 作为 childId', () => {
  const picked = selectSession(makeBundle(), 'aaa');
  assert.equal(picked.isChild, true);
  assert.equal(picked.session.id, 'claude-code:root:agent-aaa');
});

test('selectSession：未知 childId 抛结构化错误', () => {
  assert.throws(
    () => selectSession(makeBundle(), 'nope'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'session.childNotFound');
      return true;
    },
  );
});

test('selectSession：空字符串 childId 按根会话处理', () => {
  const picked = selectSession(makeBundle(), '');
  assert.equal(picked.isChild, false);
});
