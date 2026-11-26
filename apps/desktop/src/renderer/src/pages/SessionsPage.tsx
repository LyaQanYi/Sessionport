import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowLeftRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Folder, Hash, MessagesSquare, RefreshCw } from 'lucide-react';

import { api } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { AgentGlyph, AGENT_META, agentLabel } from '../agents.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import type { MessageKey, MessageParams } from '../i18n/messages.ts';
import { Badge, Button, EmptyState, RowAction, SearchField, SegmentedControl, Spinner, Topbar, cn } from '../ui.tsx';

type TFunction = (key: MessageKey, params?: MessageParams) => string;

type GroupMode = 'project' | 'time';

const GROUP_MODE_KEY = 'sessionport.sessions.groupMode';
const COLLAPSED_KEY = 'sessionport.sessions.collapsedGroups';

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
  | { kind: 'session'; key: string; session: SessionRow };

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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const all = data?.sessions ?? [];
  const warnings = (data?.warnings ?? []).map((warning) => (locale === 'zh-CN' ? warning : warningText(warning, t)));
  const enabledSessions = useMemo(() => {
    if (props.enabledAgents.length === 0) return all;
    return all.filter((row) => props.enabledAgents.includes(row.agent));
  }, [all, props.enabledAgents]);

  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of enabledSessions) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
    return counts;
  }, [enabledSessions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return enabledSessions.filter((row) => {
      if (props.agentFilter && row.agent !== props.agentFilter) return false;
      if (!needle) return true;
      return [row.title, row.cwd, row.sessionId, row.agent].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [enabledSessions, query, props.agentFilter]);

  const { rows, groupKeys } = useMemo<{ rows: Row[]; groupKeys: string[] }>(() => {
    const groups = new Map<string, { label: string; sessions: SessionRow[]; latest: string }>();
    for (const session of filtered) {
      const key = groupMode === 'project' ? projectName(session, t('sessions.noProject')) : timeBucket(session.updatedAt, t);
      const entry = groups.get(key) ?? { label: key, sessions: [], latest: '' };
      entry.sessions.push(session);
      const stamp = session.updatedAt ?? '';
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
      rowGroup(result, key, entry.label, entry.sessions, groupMode, collapsed);
    }
    return { rows: result, groupKeys: keys };
  }, [filtered, groupMode, collapsed, t]);

  const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => collapsed.has(key));

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? 34 : 58),
    overscan: 14,
  });

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
        subtitle={data ? t('sessions.subtitle', { sessions: enabledSessions.length, agents: agentCounts.size }) : t('common.loading')}
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
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => props.onAgentFilterChange(null)}
            className={cn(
              'h-6 shrink-0 rounded-full px-2 text-caption transition-colors',
              props.agentFilter === null ? 'bg-selected text-fg-1' : 'text-fg-2 hover:bg-accent',
            )}
          >
            {t('sessions.all', { count: enabledSessions.length })}
          </button>
          {[...agentCounts.entries()].map(([agent, count]) => (
            <button
              key={agent}
              type="button"
              onClick={() => props.onAgentFilterChange(props.agentFilter === agent ? null : agent)}
              className={cn(
                'flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption transition-colors',
                props.agentFilter === agent ? 'bg-selected text-fg-1' : 'text-fg-2 hover:bg-accent',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', AGENT_META[agent]?.dot ?? 'bg-fg-3')} />
              {agentLabel(agent)} {count}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-caption tabular-nums text-fg-3">{t('sessions.count', { count: filtered.length })}</span>
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
                return (
                  <div
                    key={row.key}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: 'translateY(' + virtualRow.start + 'px)' }}
                    className={cn(
                      'group flex h-[58px] w-full items-center border-b border-border/60 transition-colors',
                      session.readable ? 'hover:bg-accent/60' : 'opacity-60',
                    )}
                  >
                    <button
                      type="button"
                      data-session-row="true"
                      disabled={!session.readable}
                      title={session.readable ? undefined : t('sessions.readableHint')}
                      onClick={() => props.onOpen(session)}
                      className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-2.5 pl-4 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        session.readable ? 'cursor-pointer' : 'cursor-not-allowed',
                      )}
                    >
                      <AgentGlyph agent={session.agent} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-body text-fg-1">{highlight(session.title ?? session.sessionId, query)}</span>
                          {session.readable ? null : <Badge variant="outline">{t('sessions.metadata')}</Badge>}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 truncate text-caption text-fg-2">
                          <Folder className="h-3 w-3 shrink-0 text-fg-3" />
                          <span className="truncate">{session.cwd ?? session.nativePath}</span>
                        </div>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-2 pr-4">
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
            {t('sessions.footer', {
              count: filtered.length,
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
  sessions: SessionRow[],
  groupMode: GroupMode,
  collapsed: Set<string>,
): void {
  target.push({ kind: 'header', key: groupMode + ':' + key, label, count: sessions.length });
  if (collapsed.has(groupMode + ':' + key)) return;
  const sorted = [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  for (const session of sorted) {
    target.push({ kind: 'session', key: session.agent + '|' + session.sessionId + '|' + session.nativePath, session });
  }
}