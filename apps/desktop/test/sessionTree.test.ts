import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSessionForest,
  countRootSessionsByAgent,
  filterRootSessions,
  filterSessionForest,
  flattenVisibleTree,
  sessionNodeKey,
  type TreeSession,
} from '../src/renderer/src/sessionTree.ts';

function s(
  agent: string,
  sessionId: string,
  updatedAt: string,
  opts: Partial<TreeSession> = {},
): TreeSession {
  return {
    agent,
    sessionId,
    updatedAt,
    title: opts.title ?? sessionId,
    ...opts,
  };
}

test('sessionTree: 四层嵌套构建、子孙计数、最新活跃时间冒泡与跨 agent 隔离', () => {
  const items: TreeSession[] = [
    s('antigravity', 'root', '2026-11-20T00:00:00.000Z'),
    s('antigravity', 'child-1', '2026-11-20T01:00:00.000Z', { parentSessionId: 'root' }),
    s('antigravity', 'child-2', '2026-11-20T00:30:00.000Z', { parentSessionId: 'root' }),
    s('antigravity', 'grandchild', '2026-11-20T02:00:00.000Z', { parentSessionId: 'child-1' }),
    s('antigravity', 'leaf', '2026-11-20T03:00:00.000Z', { parentSessionId: 'grandchild' }),
    // 不同 agent 同 sessionId 不得误挂到 antigravity:root
    s('codex', 'root', '2026-11-20T00:10:00.000Z'),
    s('codex', 'codex-sub', '2026-11-20T00:20:00.000Z', { parentSessionId: 'root' }),
  ];

  const forest = buildSessionForest(items);
  assert.equal(forest.totalRootCount, 2);
  assert.equal(forest.totalChildCount, 5);
  assert.equal(forest.rootCountByAgent.get('antigravity'), 1);
  assert.equal(forest.rootCountByAgent.get('codex'), 1);

  const agRoot = forest.roots[0]!;
  assert.equal(agRoot.session.agent, 'antigravity');
  assert.equal(agRoot.directChildCount, 2);
  assert.equal(agRoot.descendantCount, 4);
  assert.equal(agRoot.latestActivity, '2026-11-20T03:00:00.000Z');
  assert.deepEqual(
    agRoot.children.map((c) => c.session.sessionId),
    ['child-1', 'child-2'],
  );

  const codexRoot = forest.roots[1]!;
  assert.equal(codexRoot.session.agent, 'codex');
  assert.equal(codexRoot.directChildCount, 1);

  assert.deepEqual(countRootSessionsByAgent(items), new Map([['antigravity', 1], ['codex', 1]]));
  assert.deepEqual(
    filterRootSessions(items).map((item) => item.agent + ':' + item.sessionId),
    ['antigravity:root', 'codex:root'],
  );
});

test('sessionTree: 孤儿子会话降级为根，环引用安全破环', () => {
  const items: TreeSession[] = [
    s('dsh', 'orphan', '2026-11-21T00:00:00.000Z', { parentSessionId: 'missing-parent' }),
    s('dsh', 'cyc-a', '2026-11-21T02:00:00.000Z', { parentSessionId: 'cyc-b' }),
    s('dsh', 'cyc-b', '2026-11-21T01:00:00.000Z', { parentSessionId: 'cyc-a' }),
    s('dsh', 'self', '2026-11-21T00:30:00.000Z', { parentSessionId: 'self' }),
  ];

  const forest = buildSessionForest(items);
  // 首节点 cyc-a 挂在 cyc-b 下后，cyc-b 再挂回 cyc-a 会触发破环保留为根；orphan/self 退化为根
  assert.equal(forest.totalRootCount, 3);
  assert.equal(forest.totalChildCount, 1);
  assert.deepEqual(
    forest.roots.map((r) => r.session.sessionId),
    ['cyc-b', 'self', 'orphan'],
  );
  assert.deepEqual(
    forest.roots[0]!.children.map((c) => c.session.sessionId),
    ['cyc-a'],
  );
});

test('sessionTree: flattenVisibleTree 支持严格逐层展开、收起隐藏深层以及竖线 guideMask', () => {
  const root = s('antigravity', 'r', '2026-11-20T00:00:00.000Z');
  const d1a = s('antigravity', 'd1a', '2026-11-20T02:00:00.000Z', { parentSessionId: 'r' });
  const d1b = s('antigravity', 'd1b', '2026-11-20T01:00:00.000Z', { parentSessionId: 'r' });
  const d2 = s('antigravity', 'd2', '2026-11-20T03:00:00.000Z', { parentSessionId: 'd1a' });
  const d3 = s('antigravity', 'd3', '2026-11-20T04:00:00.000Z', { parentSessionId: 'd2' });

  const forest = buildSessionForest([root, d1a, d1b, d2, d3]);
  const key = (id: string): string => sessionNodeKey({ agent: 'antigravity', sessionId: id });

  // 全部折叠：只显示根
  assert.deepEqual(
    flattenVisibleTree(forest.roots, new Set()).map((r) => [r.session.sessionId, r.depth]),
    [['r', 0]],
  );

  // 仅展开 root：显示 d1a, d1b（depth=1），d2 不出现
  assert.deepEqual(
    flattenVisibleTree(forest.roots, new Set([key('r')])).map((r) => [r.session.sessionId, r.depth, r.isLastSibling, r.guideMask]),
    [
      ['r', 0, true, []],
      ['d1a', 1, false, []],
      ['d1b', 1, true, []],
    ],
  );

  // 再展开 d1a：露出 d2（depth=2），guideMask=[true] 表示 d1a 后面还有兄弟 d1b
  assert.deepEqual(
    flattenVisibleTree(forest.roots, new Set([key('r'), key('d1a')])).map((r) => [r.session.sessionId, r.depth, r.isLastSibling, r.guideMask]),
    [
      ['r', 0, true, []],
      ['d1a', 1, false, []],
      ['d2', 2, true, [true]],
      ['d1b', 1, true, []],
    ],
  );

  // 只展开 d1a 而不展开 r：深层保持隐藏
  assert.deepEqual(
    flattenVisibleTree(forest.roots, new Set([key('d1a'), key('d2')])).map((r) => r.session.sessionId),
    ['r'],
  );
});

test('sessionTree: 搜索过滤命中深层叶子时保留祖先路径并计算 autoExpandKeys', () => {
  const forest = buildSessionForest([
    s('opencode', 'root-hit', '2026-11-22T00:00:00.000Z', { title: 'Match in root' }),
    s('opencode', 'root-child', '2026-11-22T01:00:00.000Z', { parentSessionId: 'root-hit', title: 'other' }),
    s('antigravity', 'ag-root', '2026-11-23T00:00:00.000Z', { title: 'Main build' }),
    s('antigravity', 'ag-mid', '2026-11-23T01:00:00.000Z', { parentSessionId: 'ag-root', title: 'Planner' }),
    s('antigravity', 'ag-leaf', '2026-11-23T02:00:00.000Z', { parentSessionId: 'ag-mid', title: 'Fix Auth Token' }),
    s('antigravity', 'ag-other', '2026-11-23T00:30:00.000Z', { parentSessionId: 'ag-root', title: 'Unrelated' }),
  ]);

  const filteredLeaf = filterSessionForest(forest.roots, (item) => (item.title ?? '').toLowerCase().includes('auth'));
  assert.deepEqual(
    filteredLeaf.roots.map((r) => r.session.sessionId),
    ['ag-root'],
  );
  assert.equal(filteredLeaf.visibleChildCount, 2); // ag-mid + ag-leaf
  assert.ok(filteredLeaf.autoExpandKeys.has('antigravity\0ag-root'));
  assert.ok(filteredLeaf.autoExpandKeys.has('antigravity\0ag-mid'));
  const flatLeaf = flattenVisibleTree(filteredLeaf.roots, filteredLeaf.autoExpandKeys);
  assert.deepEqual(
    flatLeaf.map((r) => [r.session.sessionId, r.depth]),
    [
      ['ag-root', 0],
      ['ag-mid', 1],
      ['ag-leaf', 2],
    ],
  );

  // 父节点命中时保留原子树（可展开），但不强行展开
  const filteredParent = filterSessionForest(forest.roots, (item) => (item.title ?? '').includes('Match in root'));
  assert.deepEqual(
    filteredParent.roots.map((r) => r.session.sessionId),
    ['root-hit'],
  );
  assert.equal(filteredParent.autoExpandKeys.size, 0);
  assert.equal(filteredParent.roots[0]!.descendantCount, 1);
});
