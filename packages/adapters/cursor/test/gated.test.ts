import assert from 'node:assert/strict';
import test from 'node:test';

import { listCursorSessions, readCursorSession, verifyCursorSession } from '../src/index.ts';

const REAL_HOME = process.env.SESSIONPORT_CURSOR_HOME;
const gated = REAL_HOME === undefined;

test(
  '真实 Cursor 库只读：列表 + 读最近一个会话 + 结构自检',
  { skip: gated ? '未设置 SESSIONPORT_CURSOR_HOME（gated 真实库测试）' : false },
  async () => {
    const rows = await listCursorSessions({ home: REAL_HOME, limit: 5 });
    assert.ok(rows.length > 0, '真实库应至少有一个 composer');
    const first = rows[0];
    assert.ok(first !== undefined);
    assert.equal(first.agent, 'cursor');
    assert.ok(first.sessionId.length > 0);
    assert.ok(first.nativePath.endsWith('state.vscdb'));

    const bundle = await readCursorSession(first.sessionId, { home: REAL_HOME, includeChildren: false });
    assert.equal(bundle.root.source.agent, 'cursor');
    assert.equal(bundle.root.source.nativeSessionId, first.sessionId);
    assert.ok(bundle.root.events.length > 0);

    const report = await verifyCursorSession({ home: REAL_HOME, sessionId: first.sessionId });
    assert.ok(report.checks.length > 0);
    assert.equal(typeof report.ok, 'boolean');
  },
);
