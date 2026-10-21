import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Copy, Folder, Hash, MessagesSquare, RefreshCw } from 'lucide-react';

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
}) {
  const { locale, t, tError, formatTime } = useT();
  const [query, setQuery] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroupMode);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });

  const all = data?.sessions ?? [];
  const warnings = (data?.warnings ?? []).map((warning) => (locale === 'zh-CN' ? warning : warningText(warning, t)));
  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of all) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
    return counts;
  }, [all]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((row) => {
      if (props.enabledAgents.length > 0 && !props.enabledAgents.includes(row.agent)) return false;
      if (props.agentFilter && row.agent !== props.agentFilter) return false;
      if (!needle) return true;
      return [row.title, row.cwd, row.sessionId, row.agent].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [all, query, props.agentFilter, props.enabledAgents]);

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, { label: string; sessions: SessionRow[]; latest: string }>();
    for (const session of filtered) {
      const key = groupMode === 'project' ? projectName(session, t('sessions.noProject')) : timeBucket(session.updatedAt, t);
      const label = groupMode === 'project' ? key : key;
      const entry = groups.get(key) ?? { label, sessions: [], latest: '' };
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
    for (const [key, entry] of ordered) {
      rowGroup(result, key, entry.label, entry.sessions, groupMode, collapsed);
    }
    return result;
  }, [filtered, groupMode, collapsed, t]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
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

  const copy = (text: string | undefined): void => {
    if (text) void navigator.clipboard.writeText(text);
  };

  return (
    <div className="flex h-full flex-col">
      <Topbar
        icon={<MessagesSquare className="h-4 w-4" />}
        title={t('sessions.title')}
        subtitle={data ? t('sessions.subtitle', { sessions: all.length, agents: agentCounts.size }) : t('common.loading')}
        actions={
          <>
            <SearchField value={query} onChange={setQuery} placeholder={t('sessions.searchPlaceholder')} className="w-56" />
            <Button variant="outline" size="icon" onClick={() => void refetch()} title={t('common.refresh')}>
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
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => props.onAgentFilterChange(null)}
            className={cn(
              'h-6 shrink-0 rounded-full px-2 text-caption transition-colors',
              props.agentFilter === null ? 'bg-selected text-fg-1' : 'text-fg-2 hover:bg-accent',
            )}
          >
            {t('sessions.all', { count: all.length })}
          </button>
          {[...agentCounts.entries()]
            .filter(([agent]) => props.enabledAgents.length === 0 || props.enabledAgents.includes(agent))
            .map(([agent, count]) => (
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
        <div className="ml-auto shrink-0 text-caption text-fg-3">{t('sessions.count', { count: filtered.length })}</div>
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
                      className="flex h-[34px] items-center gap-2 border-b border-border bg-background px-4"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(row.key)}
                        className="flex min-w-0 items-center gap-1 text-caption font-medium text-fg-2 hover:text-fg-1"
                      >
                        {collapsed.has(row.key) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        <span className="truncate">{row.label}</span>
                        <span className="text-fg-3">{row.count}</span>
                      </button>
                    </div>
                  );
                }
                const session = row.session;
                return (
                  <div
                    key={row.key}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: 'translateY(' + virtualRow.start + 'px)' }}
                  >
                    <button
                      type="button"
                      data-session-row="true"
                      disabled={!session.readable}
                      title={session.readable ? undefined : t('sessions.readableHint')}
                      onClick={() => props.onOpen(session)}
                      className={cn(
                        'group flex h-[58px] w-full items-center gap-2.5 border-b border-border/60 px-4 text-left transition-colors',
                        session.readable ? 'hover:bg-accent/60' : 'cursor-not-allowed opacity-60',
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
                      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                        {session.resumeHint ? (
                          <RowAction label={t('sessions.copyResume', { command: session.resumeHint })} onClick={() => copy(session.resumeHint)}>
                            <Copy className="h-3.5 w-3.5" />
                          </RowAction>
                        ) : null}
                        <RowAction label={t('sessions.copySessionId', { id: session.sessionId })} onClick={() => copy(session.sessionId)}>
                          <Hash className="h-3.5 w-3.5" />
                        </RowAction>
                      </div>
                      <div className="w-20 shrink-0 text-right text-caption text-fg-3">{relativeTime(session.updatedAt, t, formatTime)}</div>
                    </button>
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