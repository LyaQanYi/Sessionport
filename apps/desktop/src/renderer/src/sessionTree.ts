/**
 * 多层级会话树纯逻辑：构建森林、祖先感知搜索过滤、按展开态拍平显示列表、主会话计数。
 *
 * 零 React / Electron 依赖，可在 node --test 下直接单测。
 */

export interface TreeSession {
  agent: string;
  sessionId: string;
  parentSessionId?: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  nativePath?: string;
}

export interface SessionTreeNode<T extends TreeSession> {
  key: string;
  session: T;
  children: SessionTreeNode<T>[];
  directChildCount: number;
  descendantCount: number;
  latestActivity: string;
}

export interface SessionForest<T extends TreeSession> {
  roots: SessionTreeNode<T>[];
  nodeByKey: Map<string, SessionTreeNode<T>>;
  rootCountByAgent: Map<string, number>;
  totalRootCount: number;
  totalChildCount: number;
}

export interface FilteredSessionForest<T extends TreeSession> {
  roots: SessionTreeNode<T>[];
  autoExpandKeys: Set<string>;
  visibleChildCount: number;
}

export interface FlattenedSessionRow<T extends TreeSession> {
  key: string;
  session: T;
  depth: number;
  directChildCount: number;
  descendantCount: number;
  expanded: boolean;
  isLastSibling: boolean;
  /** 每列祖先是否还有后续兄弟节点，用于绘制树形竖线（长度为 max(0, depth - 1)） */
  guideMask: boolean[];
}

export function sessionNodeKey(session: Pick<TreeSession, 'agent' | 'sessionId'>): string {
  return session.agent + '\0' + session.sessionId;
}

function timestampMs(iso: string | undefined): number {
  if (iso === undefined || iso.length === 0) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function compareNodes<T extends TreeSession>(a: SessionTreeNode<T>, b: SessionTreeNode<T>): number {
  const delta = timestampMs(b.latestActivity) - timestampMs(a.latestActivity);
  if (delta !== 0) return delta;
  if (a.session.agent !== b.session.agent) return a.session.agent < b.session.agent ? -1 : 1;
  return a.session.sessionId < b.session.sessionId ? -1 : a.session.sessionId > b.session.sessionId ? 1 : 0;
}

function wouldCreateCycle(parentKey: string, childKey: string, attachedParent: Map<string, string>): boolean {
  let cursor: string | undefined = parentKey;
  const visited = new Set<string>([childKey]);
  while (cursor !== undefined) {
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = attachedParent.get(cursor);
  }
  return false;
}

function finalizeSubtree<T extends TreeSession>(node: SessionTreeNode<T>): void {
  for (const child of node.children) finalizeSubtree(child);
  node.children.sort(compareNodes);
  node.directChildCount = node.children.length;
  let descendants = 0;
  let latestMs = timestampMs(node.session.updatedAt);
  let latestIso = node.session.updatedAt ?? '';
  for (const child of node.children) {
    descendants += 1 + child.descendantCount;
    const childMs = timestampMs(child.latestActivity);
    if (childMs > latestMs) {
      latestMs = childMs;
      latestIso = child.latestActivity;
    }
  }
  node.descendantCount = descendants;
  node.latestActivity = latestIso;
}

/** 将扁平会话清单按 parentSessionId 组装为多层级森林（孤儿退化为根，自动破环） */
export function buildSessionForest<T extends TreeSession>(sessions: readonly T[]): SessionForest<T> {
  const nodeByKey = new Map<string, SessionTreeNode<T>>();
  for (const session of sessions) {
    const key = sessionNodeKey(session);
    if (nodeByKey.has(key)) continue;
    nodeByKey.set(key, {
      key,
      session,
      children: [],
      directChildCount: 0,
      descendantCount: 0,
      latestActivity: session.updatedAt ?? '',
    });
  }

  const attachedParent = new Map<string, string>();
  const roots: SessionTreeNode<T>[] = [];
  for (const node of nodeByKey.values()) {
    const parentId = node.session.parentSessionId?.trim();
    if (parentId !== undefined && parentId.length > 0) {
      const parentKey = node.session.agent + '\0' + parentId;
      const parentNode = nodeByKey.get(parentKey);
      if (parentNode !== undefined && parentNode !== node && !wouldCreateCycle(parentKey, node.key, attachedParent)) {
        parentNode.children.push(node);
        attachedParent.set(node.key, parentKey);
        continue;
      }
    }
    roots.push(node);
  }

  for (const root of roots) finalizeSubtree(root);
  roots.sort(compareNodes);

  const rootCountByAgent = new Map<string, number>();
  let totalChildCount = 0;
  for (const root of roots) {
    rootCountByAgent.set(root.session.agent, (rootCountByAgent.get(root.session.agent) ?? 0) + 1);
    totalChildCount += root.descendantCount;
  }

  return {
    roots,
    nodeByKey,
    rootCountByAgent,
    totalRootCount: roots.length,
    totalChildCount,
  };
}

/** 搜索时保留命中节点及其祖先链路，并返回需要自动展开的祖先 key */
export function filterSessionForest<T extends TreeSession>(
  roots: readonly SessionTreeNode<T>[],
  matcher: (session: T) => boolean,
): FilteredSessionForest<T> {
  const autoExpandKeys = new Set<string>();

  const filterNodes = (nodes: readonly SessionTreeNode<T>[]): SessionTreeNode<T>[] => {
    const out: SessionTreeNode<T>[] = [];
    for (const node of nodes) {
      const filteredChildren = filterNodes(node.children);
      if (filteredChildren.length > 0) {
        autoExpandKeys.add(node.key);
        let descendants = 0;
        for (const child of filteredChildren) descendants += 1 + child.descendantCount;
        out.push({
          key: node.key,
          session: node.session,
          children: filteredChildren,
          directChildCount: filteredChildren.length,
          descendantCount: descendants,
          latestActivity: node.latestActivity,
        });
      } else if (matcher(node.session)) {
        // 父节点自身命中时保留完整子树，让用户仍能按需展开查看其子会话
        out.push(node);
      }
    }
    return out;
  };

  const filteredRoots = filterNodes(roots);
  let visibleChildCount = 0;
  for (const root of filteredRoots) visibleChildCount += root.descendantCount;
  return { roots: filteredRoots, autoExpandKeys, visibleChildCount };
}

/** 按 expandedKeys 逐层前序拍平可见树行（未展开节点的后代全部隐藏） */
export function flattenVisibleTree<T extends TreeSession>(
  roots: readonly SessionTreeNode<T>[],
  expandedKeys: ReadonlySet<string>,
): FlattenedSessionRow<T>[] {
  const rows: FlattenedSessionRow<T>[] = [];

  const visit = (nodes: readonly SessionTreeNode<T>[], depth: number, guideMask: boolean[]): void => {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const isLastSibling = i === nodes.length - 1;
      const expanded = node.children.length > 0 && expandedKeys.has(node.key);
      rows.push({
        key: node.key,
        session: node.session,
        depth,
        directChildCount: node.directChildCount,
        descendantCount: node.descendantCount,
        expanded,
        isLastSibling,
        guideMask,
      });
      if (expanded) {
        const nextMask = depth === 0 ? [] : [...guideMask, !isLastSibling];
        visit(node.children, depth + 1, nextMask);
      }
    }
  };

  visit(roots, 0, []);
  return rows;
}

/** 按 agent 统计顶级主会话数（用于侧栏、适配器卡片与列表总览一致） */
export function countRootSessionsByAgent<T extends TreeSession>(sessions: readonly T[]): Map<string, number> {
  return buildSessionForest(sessions).rootCountByAgent;
}

/** 提取排序后的顶级主会话列表（用于命令面板与迁移源默认列表） */
export function filterRootSessions<T extends TreeSession>(sessions: readonly T[]): T[] {
  return buildSessionForest(sessions).roots.map((node) => node.session);
}
