import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Folder,
  GitBranch,
  Hash,
  MessagesSquare,
  RefreshCw,
  X,
} from 'lucide-react';

import { api } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { AgentGlyph, AGENT_META, agentLabel } from '../agents.tsx';
import {
  buildSessionForest,
  filterSessionForest,
  flattenVisibleTree,
  type SessionTreeNode,
} from '../sessionTree.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import type { MessageKey, MessageParams } from '../i18n/messages.ts';
import { Badge, Button, EmptyState, RowAction, SearchField, SegmentedControl, Spinner, Topbar, cn } from '../ui.tsx';

type TFunction = (key: MessageKey, params?: MessageParams) => string;

type GroupMode = 'project' | 'time';

const GROUP_MODE_KEY = 'sessionport.sessions.groupMode';
const COLLAPSED_KEY = 'sessionport.sessions.collapsedGroups';
const EXPANDED_NODES_KEY = 'sessionport.sessions.expandedNodes';

function readGroupMode(): GroupMode {
  return localStorage.getItem(GROUP_MODE_KEY) === 'time' ? 'time' : 'project';
}

function readCollapsed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

function readExpandedNodes(): Set<string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(EXPANDED_NODES_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeExpandedNodes(keys: Set<string>): void {
  try {
    sessionStorage.setItem(EXPANDED_NODES_KEY, JSON.stringify([...keys]));
  } catch {
    // ignore storage errors
  }
}

function projectName(session: SessionRow, noProject: string): string {
  const dir = session.cwd ?? session.nativePath;
  if (!dir) return noProject;
  const parts = dir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function relativeTime(iso: string | undefined, t: TFunction, formatTime: (iso?: string) => string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const delta = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return t('sessions.time.justNow');
  if (delta < hour) return t('sessions.time.minutesAgo', { count: Math.floor(delta / minute) });
  if (delta < day) return t('sessions.time.hoursAgo', { count: Math.floor(delta / hour) });
  if (delta < 2 * day) return t('sessions.time.yesterday');
  return formatTime(iso);
}

function timeBucket(iso: string | undefined, t: TFunction): string {
  if (!iso) return t('sessions.time.earlier');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return t('sessions.time.earlier');
  const now = new Date();
  const date = new Date(ms);
  const sameDay = now.toDateString() === date.toDateString();
  if (sameDay) return t('sessions.time.today');
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (yesterday.toDateString() === date.toDateString()) return t('sessions.time.yesterday');
  if (now.getTime() - ms < 7 * 86_400_000) return t('sessions.time.recent7');
  return t('sessions.time.earlier');
}

function warningText(warning: string, t: TFunction): string {
  if (warning.startsWith('core.listAllSessions 尚未实现')) return t('sessions.warning.coreMissing');
  if (warning.startsWith('listAllSessions 调用失败')) return t('sessions.warning.listFailed');
  if (warning.startsWith('Codex 列表失败')) return t('sessions.warning.codexFailed');
  return warning;
}

function highlight(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-ring/25 px-0.5 text-inherit">{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

type Row =
  | { kind: 'header'; key: string; label: string; count: number }
  | {
      kind: 'session';
      key: string;
      nodeKey: string;
      session: SessionRow;
      depth: number;
      directChildCount: number;
      descendantCount: number;
      expanded: boolean;
      isLastSibling: boolean;
      guideMask: boolean[];
    };

export function SessionsPage(props: {
  enabledAgents: string[];
  agentFilter: string | null;
  onAgentFilterChange: (agent: string | null) => void;
  onOpen: (session: SessionRow) => void;
  onMigrate: (session: SessionRow) => void;
}) {
  const { locale, t, tError, formatTime } = useT();
  const [query, setQuery] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroupMode);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(readExpandedNodes);
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setSearchCollapsed(new Set());
  }, [query]);

  const all = data?.sessions ?? [];
  const warnings = (data?.warnings ?? []).map((warning) => (locale === 'zh-CN' ? warning : warningText(warning, t)));
  const enabledSessions = useMemo(() => {
    if (props.enabledAgents.length === 0) return all;
    return all.filter((row) => props.enabledAgents.includes(row.agent));
  }, [all, props.enabledAgents]);

  const forest = useMemo(() => buildSessionForest(enabledSessions), [enabledSessions]);

  const agentRoots = useMemo(
    () => (props.agentFilter ? forest.roots.filter((node) => node.session.agent === props.agentFilter) : forest.roots),
    [forest.roots, props.agentFilter],
  );

  const searchNeedle = query.trim().toLowerCase();
  const isSearching = searchNeedle.length > 0;

  const filteredForest = useMemo(() => {
    if (!isSearching) {
      let childCount = 0;
      for (const root of agentRoots) childCount += root.descendantCount;
      return { roots: agentRoots, autoExpandKeys: new Set<string>(), visibleChildCount: childCount };
    }
    return filterSessionForest(agentRoots, (row) =>
      [row.title, row.cwd, row.sessionId, row.agent].filter(Boolean).join(' ').toLowerCase().includes(searchNeedle),
    );
  }, [agentRoots, isSearching, searchNeedle]);

  const effectiveExpanded = useMemo(() => {
    if (!isSearching) return expandedNodes;
    const next = new Set(expandedNodes);
    for (const key of filteredForest.autoExpandKeys) {
      if (!searchCollapsed.has(key)) next.add(key);
    }
    return next;
  }, [isSearching, expandedNodes, filteredForest.autoExpandKeys, searchCollapsed]);

  const { rows, groupKeys } = useMemo<{ rows: Row[]; groupKeys: string[] }>(() => {
    const groups = new Map<string, { label: string; nodes: SessionTreeNode<SessionRow>[]; latest: string }>();
    for (const root of filteredForest.roots) {
      const stamp = root.latestActivity || root.session.updatedAt || '';
      const key = groupMode === 'project' ? projectName(root.session, t('sessions.noProject')) : timeBucket(stamp || undefined, t);
      const entry = groups.get(key) ?? { label: key, nodes: [], latest: '' };
      entry.nodes.push(root);
      if (stamp > entry.latest) entry.latest = stamp;
      groups.set(key, entry);
    }
    const ordered =
      groupMode === 'project'
        ? [...groups.entries()].sort((a, b) => (b[1].latest ?? '').localeCompare(a[1].latest ?? ''))
        : [...groups.entries()]; // 时间桶保持「今天/昨天/…」的自然插入顺序
    const result: Row[] = [];
    const keys: string[] = [];
    for (const [key, entry] of ordered) {
      keys.push(groupMode + ':' + key);
      rowGroup(result, key, entry.label, entry.nodes, groupMode, collapsed, effectiveExpanded);
    }
    return { rows: result, groupKeys: keys };
  }, [filteredForest.roots, groupMode, collapsed, effectiveExpanded, t]);

  const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => collapsed.has(key));
  const visibleRootCount = filteredForest.roots.length;
  const visibleChildCount = filteredForest.visibleChildCount;

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rows[index];
      if (row === undefined || row.kind === 'header') return 34;
      return row.depth > 0 ? 50 : 58;
    },
    overscan: 14,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rows, rowVirtualizer]);

  const toggleNode = (nodeKey: string): void => {
    if (isSearching && filteredForest.autoExpandKeys.has(nodeKey)) {
      const currentlyExpanded = !searchCollapsed.has(nodeKey);
      setSearchCollapsed((current) => {
        const next = new Set(current);
        if (currentlyExpanded) next.add(nodeKey);
        else next.delete(nodeKey);
        return next;
      });
      setExpandedNodes((current) => {
        const next = new Set(current);
        if (currentlyExpanded) next.delete(nodeKey);
        else next.add(nodeKey);
        writeExpandedNodes(next);
        return next;
      });
      return;
    }
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(nodeKey)) next.delete(nodeKey);
      else next.add(nodeKey);
      writeExpandedNodes(next);
      return next;
    });
  };

  const toggleGroup = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const toggleAllGroups = (): void => {
    if (groupKeys.length === 0) return;
    setCollapsed((current) => {
      const next = new Set(current);
      if (allCollapsed) {
        for (const key of groupKeys) next.delete(key);
      } else {
        for (const key of groupKeys) next.add(key);
      }
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const copy = (feedbackKey: string, text: string | undefined): void => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopiedKey(feedbackKey);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1400);
  };

  return (
    <div className="flex h-full flex-col">
      <Topbar
        icon={<MessagesSquare className="h-4 w-4" />}
        title={t('sessions.title')}
        subtitle={data ? t('sessions.subtitle', { sessions: forest.totalRootCount, agents: forest.rootCountByAgent.size }) : t('common.loading')}
        actions={
          <>
            <SearchField value={query} onChange={setQuery} placeholder={t('sessions.searchPlaceholder')} className="w-56" />
            <Button variant="outline" size="icon" onClick={() => void refetch()} title={t('common.refresh')} aria-label={t('common.refresh')}>
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            </Button>
          </>
        }
      />

      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-4">
        <SegmentedControl
          value={groupMode}
          onChange={(mode) => {
            localStorage.setItem(GROUP_MODE_KEY, mode);
            setGroupMode(mode);
          }}
          options={[
            { value: 'project', label: t('sessions.group.project') },
            { value: 'time', label: t('sessions.group.time') },
          ]}
        />
        {props.agentFilter ? (
          <button
            type="button"
            onClick={() => props.onAgentFilterChange(null)}
            title={t('common.clear')}
            aria-label={t('common.clear')}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-selected px-2 text-caption text-fg-1 transition-colors hover:bg-accent"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', AGENT_META[props.agentFilter]?.dot ?? 'bg-fg-3')} />
            <span>{agentLabel(props.agentFilter)}</span>
            <X className="h-3 w-3 text-fg-3" />
          </button>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-caption tabular-nums text-fg-3">
            {visibleChildCount > 0
              ? t('sessions.countWithChildren', { count: visibleRootCount, children: visibleChildCount })
              : t('sessions.count', { count: visibleRootCount })}
          </span>
          {groupKeys.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleAllGroups}
              title={allCollapsed ? t('sessions.expandAll') : t('sessions.collapseAll')}
              className="h-6 px-2 text-caption text-fg-2"
            >
              {allCollapsed ? <ChevronsUpDown className="h-3.5 w-3.5" /> : <ChevronsDownUp className="h-3.5 w-3.5" />}
              <span>{allCollapsed ? t('sessions.expandAll') : t('sessions.collapseAll')}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-2">
          <Spinner /> {t('sessions.loading')}
        </div>
      ) : error ? (
        <EmptyState title={t('sessions.loadErrorTitle')} hint={tError(error)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('sessions.emptyTitle')}
          hint={warnings.length > 0 ? warnings.join(t('common.listSeparator')) : t('sessions.emptyHint')}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]!;
                if (row.kind === 'header') {
                  return (
                    <div
                      key={row.key}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: 'translateY(' + virtualRow.start + 'px)' }}
                      className="flex h-[34px] items-center border-b border-border bg-subtle/70"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(row.key)}
                        className="group flex h-full w-full items-center gap-2 px-4 text-left text-caption font-medium text-fg-2 transition-colors hover:bg-subtle hover:text-fg-1"
                      >
                        {collapsed.has(row.key) ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-3" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
                        <span className="truncate">{row.label}</span>
                        <span className="rounded bg-background/80 px-1.5 py-0.5 text-3xs tabular-nums text-fg-3">{row.count}</span>
                      </button>
                    </div>
                  );
                }
                const session = row.session;
                const resumeCopied = copiedKey === row.key + ':resume';
                const idCopied = copiedKey === row.key + ':id';
                const anyCopied = resumeCopied || idCopied;
                const isNested = row.depth > 0;
                const hasChildren = row.directChildCount > 0;
                const childTooltip =
                  row.descendantCount > row.directChildCount
                    ? t('sessions.childrenTooltipNested', { direct: row.directChildCount, total: row.descendantCount })
                    : t('sessions.childrenTooltipDirect', { direct: row.directChildCount });
                const cappedGuides = row.guideMask.slice(0, 5);
                return (
                  <div
                    key={row.key}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: 'translateY(' + virtualRow.start + 'px)' }}
                    className={cn(
                      'group flex w-full items-center border-b border-border/60 pl-3 pr-4 transition-colors',
                      isNested ? 'h-[50px] bg-subtle/20' : 'h-[58px]',
                      session.readable ? 'hover:bg-accent/60' : 'opacity-60',
                    )}
                  >
                    {isNested ? (
                      <div className="flex h-full shrink-0 items-center" aria-hidden="true">
                        {cappedGuides.map((hasMore, idx) => (
                          <span key={idx} className="relative h-full w-4 shrink-0">
                            {hasMore ? <span className="absolute inset-y-0 left-2 w-px bg-border/80" /> : null}
                          </span>
                        ))}
                        <span className="relative h-full w-4 shrink-0">
                          <span className={cn('absolute left-2 top-0 w-px bg-border/80', row.isLastSibling ? 'h-1/2' : 'bottom-0')} />
                          <span className="absolute left-2 top-1/2 h-px w-2 bg-border/80" />
                        </span>
                      </div>
                    ) : null}
                    {hasChildren ? (
                      <button
                        type="button"
                        data-tree-toggle={row.nodeKey}
                        onClick={() => toggleNode(row.nodeKey)}
                        aria-label={row.expanded ? t('sessions.collapseChildren') : t('sessions.expandChildren')}
                        aria-expanded={row.expanded}
                        title={childTooltip}
                        className="mr-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded-control text-fg-3 transition-colors hover:bg-accent hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {row.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    ) : (
                      <span className={cn('shrink-0', isNested ? 'mr-0.5 w-4' : 'mr-0.5 w-5')} aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      data-session-row="true"
                      data-depth={row.depth}
                      disabled={!session.readable}
                      title={session.readable ? undefined : t('sessions.readableHint')}
                      onClick={() => props.onOpen(session)}
                      className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-2.5 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        session.readable ? 'cursor-pointer' : 'cursor-not-allowed',
                      )}
                    >
                      <AgentGlyph agent={session.agent} className={isNested ? 'h-5 w-5' : undefined} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn('truncate text-fg-1', isNested ? 'text-caption font-medium' : 'text-body')}>
                            {highlight(session.title ?? session.sessionId, query)}
                          </span>
                          {session.readable ? null : <Badge variant="outline">{t('sessions.metadata')}</Badge>}
                        </div>
                        <div className={cn('flex items-center gap-1.5 truncate text-caption text-fg-2', isNested ? 'mt-0' : 'mt-0.5')}>
                          <Folder className="h-3 w-3 shrink-0 text-fg-3" />
                          <span className="truncate">{session.cwd ?? session.nativePath}</span>
                        </div>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.descendantCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleNode(row.nodeKey)}
                          title={childTooltip}
                          aria-label={childTooltip}
                          className={cn(
                            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-3xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            row.expanded
                              ? 'border-ring/40 bg-selected text-fg-1'
                              : 'border-border bg-subtle/80 text-fg-2 hover:bg-accent hover:text-fg-1',
                          )}
                        >
                          <GitBranch className="h-2.5 w-2.5 shrink-0 text-fg-3" />
                          <span>{row.descendantCount}</span>
                        </button>
                      ) : null}
                      <div className={cn('items-center gap-0.5', anyCopied ? 'flex' : 'hidden group-hover:flex group-focus-within:flex')}>
                        {session.readable ? (
                          <RowAction label={t('sessions.migrate')} onClick={() => props.onMigrate(session)}>
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                          </RowAction>
                        ) : null}
                        {session.resumeHint ? (
                          <RowAction
                            label={t('sessions.copyResume', { command: session.resumeHint })}
                            copied={resumeCopied}
                            copiedLabel={t('common.copied')}
                            onClick={() => copy(row.key + ':resume', session.resumeHint)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </RowAction>
                        ) : null}
                        <RowAction
                          label={t('sessions.copySessionId', { id: session.sessionId })}
                          copied={idCopied}
                          copiedLabel={t('common.copied')}
                          onClick={() => copy(row.key + ':id', session.sessionId)}
                        >
                          <Hash className="h-3.5 w-3.5" />
                        </RowAction>
                      </div>
                      <div className="w-20 shrink-0 text-right text-caption tabular-nums text-fg-3">
                        {relativeTime(session.updatedAt, t, formatTime)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border px-4 text-3xs text-fg-3">
            {visibleChildCount > 0
              ? t('sessions.footerWithChildren', {
                  count: visibleRootCount,
                  children: visibleChildCount,
                  grouping: groupMode === 'project' ? t('sessions.grouping.project') : t('sessions.grouping.time'),
                })
              : t('sessions.footer', {
                  count: visibleRootCount,
                  grouping: groupMode === 'project' ? t('sessions.grouping.project') : t('sessions.grouping.time'),
                })}
          </div>
        </div>
      )}
    </div>
  );
}

function rowGroup(
  target: Row[],
  key: string,
  label: string,
  nodes: SessionTreeNode<SessionRow>[],
  groupMode: GroupMode,
  collapsed: Set<string>,
  expandedNodes: ReadonlySet<string>,
): void {
  target.push({ kind: 'header', key: 'header|' + groupMode + ':' + key, label, count: nodes.length });
  if (collapsed.has(groupMode + ':' + key)) return;
  const flat = flattenVisibleTree(nodes, expandedNodes);
  for (const item of flat) {
    target.push({
      kind: 'session',
      key: 'session|' + item.key + '|' + item.session.nativePath,
      nodeKey: item.key,
      session: item.session,
      depth: item.depth,
      directChildCount: item.directChildCount,
      descendantCount: item.descendantCount,
      expanded: item.expanded,
      isLastSibling: item.isLastSibling,
      guideMask: item.guideMask,
    });
  }
}