import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  Info,
  Search,
  Users,
  X,
} from 'lucide-react';

import { api, sessionRefOf } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { AGENT_META, AgentGlyph, agentLabel } from '../agents.tsx';
import {
  eventMatchesSearch,
  InlineCopyButton,
  MessageBubble,
  pairReaderEvents,
  ReasoningBlock,
  ToolPairCard,
  type BulkToggleSignal,
  type ReaderItem,
} from '../components/ReaderBlocks.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { Badge, Button, CopyButton, EmptyState, Spinner, Topbar, cn } from '../ui.tsx';

const PAGE_SIZE = 300;

type EventFilter = 'all' | 'conversation' | 'tools' | 'errors';

function itemMatchesFilter(item: ReaderItem, filter: EventFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'conversation') return item.kind === 'event' && item.event.kind === 'message';
  if (filter === 'tools') {
    return item.kind === 'tool_pair' || (item.kind === 'event' && item.event.kind === 'reasoning');
  }
  return item.kind === 'tool_pair' && item.result?.isError === true;
}

export function ReaderPage(props: { session: SessionRow; onBack: () => void; onMigrate: () => void }) {
  const { t, tError, tNotice, formatTime } = useT();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [childId, setChildId] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<EventFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkSignal, setBulkSignal] = useState<BulkToggleSignal>({ open: false, seq: 0 });
  const subagentsRef = useRef<HTMLElement>(null);

  // 切换会话时回到根会话并重置筛选状态，避免把上一个会话的上下文带过去
  useEffect(() => {
    setChildId(undefined);
    setLimit(PAGE_SIZE);
    setFilter('all');
    setSearchQuery('');
    setBulkSignal({ open: false, seq: 0 });
  }, [props.session.agent, props.session.nativePath, props.session.sessionId]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['session', props.session.agent, props.session.nativePath, props.session.sessionId, limit, childId],
    queryFn: () => api.readSession(props.session.agent, sessionRefOf(props.session), limit, childId),
  });

  const pairedItems = useMemo(() => pairReaderEvents(data?.events ?? []), [data?.events]);

  const filterCounts = useMemo(() => {
    let conversation = 0;
    let tools = 0;
    let errors = 0;
    for (const item of pairedItems) {
      if (item.kind === 'event' && item.event.kind === 'message') conversation += 1;
      if (item.kind === 'tool_pair' || (item.kind === 'event' && item.event.kind === 'reasoning')) tools += 1;
      if (item.kind === 'tool_pair' && item.result?.isError === true) errors += 1;
    }
    return { all: pairedItems.length, conversation, tools, errors };
  }, [pairedItems]);

  const visibleItems = useMemo(() => {
    return pairedItems.filter((item) => itemMatchesFilter(item, filter) && eventMatchesSearch(item, searchQuery));
  }, [pairedItems, filter, searchQuery]);

  const collapsibleCount = useMemo(() => {
    let count = 0;
    for (const item of visibleItems) {
      if (item.kind === 'tool_pair' || (item.kind === 'event' && item.event.kind === 'reasoning')) {
        count += 1;
      }
    }
    return count;
  }, [visibleItems]);

  const cwd = data?.cwd ?? props.session.cwd;
  const sessionId = data?.sessionId ?? props.session.sessionId;
  const hasActiveFilter = filter !== 'all' || searchQuery.trim().length > 0;

  const toolLabels = useMemo(
    () => ({
      ok: t('reader.toolOk'),
      error: t('reader.toolError'),
      pending: t('reader.toolPending'),
      orphan: t('reader.toolOrphan'),
      input: t('reader.toolInput'),
      output: t('reader.toolOutput'),
      emptyOutput: t('reader.toolEmptyOutput'),
      unknownTool: t('reader.toolUnknown'),
      copyInput: t('reader.copyInput'),
      copyOutput: t('reader.copyOutput'),
      copied: t('common.copied'),
    }),
    [t],
  );

  const switchChild = (nextChildId: string | undefined): void => {
    setChildId(nextChildId);
    setLimit(PAGE_SIZE);
    setFilter('all');
    setSearchQuery('');
    setBulkSignal({ open: false, seq: 0 });
  };

  const filterOptions: Array<{ key: EventFilter; label: string; count: number }> = [
    { key: 'all', label: t('reader.filter.all'), count: filterCounts.all },
    { key: 'conversation', label: t('reader.filter.conversation'), count: filterCounts.conversation },
    { key: 'tools', label: t('reader.filter.tools'), count: filterCounts.tools },
    { key: 'errors', label: t('reader.filter.errors'), count: filterCounts.errors },
  ];

  return (
    <div className="flex h-full flex-col">
      <Topbar
        leading={
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onBack}
            title={t('reader.back')}
            aria-label={t('reader.back')}
            className="shrink-0 app-no-drag"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        }
        icon={<AgentGlyph agent={props.session.agent} size="sm" />}
        title={data?.title ?? props.session.title ?? props.session.sessionId}
        subtitle={
          <span className="flex items-center gap-1.5 truncate">
            {data?.isChild ? (
              <>
                <span className="font-medium text-fg-1">{t('reader.subagentBadge')}</span>
                <span>·</span>
              </>
            ) : null}
            <span className="truncate font-mono text-3xs">{sessionId}</span>
            {props.session.updatedAt ? (
              <>
                <span>·</span>
                <span className="shrink-0 tabular-nums">{formatTime(props.session.updatedAt)}</span>
              </>
            ) : null}
          </span>
        }
        actions={
          <div className="flex shrink-0 items-center gap-2 app-no-drag">
            {data?.isChild ? (
              <Button variant="outline" size="sm" onClick={() => switchChild(undefined)}>
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('reader.childBack')}
              </Button>
            ) : null}
            {props.session.resumeHint ? <CopyButton text={props.session.resumeHint} label={t('reader.copyResume')} /> : null}
            <Button size="sm" onClick={props.onMigrate}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              {t('reader.migrate')}
            </Button>
          </div>
        }
      />

      {!isLoading && !error && data ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-subtle/40 px-4 py-1.5 text-caption">
            <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-fg-1">
              <span className={cn('h-1.5 w-1.5 rounded-full', AGENT_META[props.session.agent]?.dot ?? 'bg-fg-3')} />
              {agentLabel(props.session.agent)}
            </span>
            {cwd ? (
              <div className="flex min-w-0 max-w-full items-center gap-1 text-fg-2 sm:max-w-[460px] lg:max-w-[600px]">
                <Folder className="h-3 w-3 shrink-0 text-fg-3" />
                <span className="truncate font-mono" title={cwd}>
                  {cwd}
                </span>
                <InlineCopyButton text={cwd} label={t('reader.copyCwd')} copiedLabel={t('common.copied')} />
              </div>
            ) : null}
            <span className="shrink-0 tabular-nums text-fg-2">
              {data.totalEvents > data.events.length
                ? t('reader.eventsShownTotal', { shown: data.events.length, total: data.totalEvents })
                : t('reader.eventsTotal', { count: data.totalEvents })}
            </span>
            {!childId && data.children.length > 0 ? (
              <button
                type="button"
                onClick={() => subagentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-caption font-medium text-fg-1 transition-colors hover:bg-accent"
              >
                <Users className="h-3 w-3 text-fg-2" />
                <span>{t('reader.subagents', { count: data.children.length })}</span>
              </button>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-1.5">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              {filterOptions.map((opt) => {
                const active = filter === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setFilter(opt.key)}
                    className={cn(
                      'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption transition-colors',
                      active ? 'bg-selected font-medium text-fg-1' : 'text-fg-2 hover:bg-accent hover:text-fg-1',
                    )}
                  >
                    <span>{opt.label}</span>
                    <span
                      className={cn(
                        'tabular-nums text-3xs',
                        opt.key === 'errors' && opt.count > 0 ? 'font-medium text-destructive' : 'text-fg-3',
                      )}
                    >
                      {opt.count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="relative w-44 sm:w-52">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('reader.searchPlaceholder')}
                  className={cn(
                    'h-7 w-full rounded-control border border-input bg-background pl-7 text-caption text-fg-1',
                    searchQuery ? 'pr-7' : 'pr-2.5',
                    'placeholder:text-fg-3 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
                  )}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    title={t('reader.searchClear')}
                    aria-label={t('reader.searchClear')}
                    className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-fg-3 hover:bg-accent hover:text-fg-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>

              {searchQuery.trim() ? (
                <span className="shrink-0 text-caption tabular-nums text-fg-2">
                  {t('reader.searchMatches', { count: visibleItems.length })}
                </span>
              ) : null}

              <Button
                variant="outline"
                size="sm"
                disabled={collapsibleCount === 0}
                onClick={() => setBulkSignal((prev) => ({ open: !prev.open, seq: prev.seq + 1 }))}
                className="h-7 shrink-0 px-2 text-caption"
              >
                {bulkSignal.open ? (
                  <>
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                    {t('reader.collapseAll')}
                  </>
                ) : (
                  <>
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                    {t('reader.expandAll')}
                  </>
                )}
              </Button>
            </div>
          </div>
        </>
      ) : null}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-2">
          <Spinner /> {t('reader.loading')}
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <div className="text-section text-fg-1">{t('reader.errorTitle')}</div>
          <div className="max-w-md text-caption text-fg-2">{tError(error)}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-chat px-5 py-6">
            {(data?.notices ?? []).length > 0 ? (
              <details className="group mb-5 rounded-panel border border-border bg-subtle">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-caption font-medium text-fg-2">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  {t('reader.notices', { count: data!.notices.length })}
                  <span className="ml-auto text-3xs group-open:hidden">{t('common.expand')}</span>
                  <span className="ml-auto hidden text-3xs group-open:inline">{t('common.collapse')}</span>
                </summary>
                <ul className="max-h-48 space-y-1 overflow-auto border-t border-border px-3 py-2">
                  {data!.notices.map((notice) => {
                    const text = tNotice(notice);
                    return (
                      <li key={notice.code} className="text-caption leading-relaxed text-fg-2" title={text === notice.message ? undefined : notice.message}>
                        <span className="mr-1.5 font-mono text-3xs text-fg-3">{notice.code}</span>
                        {notice.count ? '×' + notice.count + ' ' : ''}
                        {text}
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}

            {!childId && data && data.children.length > 0 ? (
              <section ref={subagentsRef} id="reader-subagents" className="mb-5 overflow-hidden rounded-panel border border-border bg-card">
                <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-caption font-medium text-fg-1">
                  <Users className="h-3.5 w-3.5 text-fg-2" />
                  <span>{t('reader.subagents', { count: data.children.length })}</span>
                  <span className="ml-auto text-3xs font-normal text-fg-3">{t('reader.subagentsHint')}</span>
                </header>
                <ul className="divide-y divide-border">
                  {data.children.map((child) => (
                    <li key={child.id}>
                      <button
                        type="button"
                        data-child-row={child.id}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/60"
                        onClick={() => switchChild(child.id)}
                      >
                        <span className="min-w-0 flex-1 truncate text-body text-fg-1">
                          {child.title ?? child.label ?? child.nativeSessionId ?? child.id}
                        </span>
                        {child.profile ? <Badge variant="outline" className="shrink-0 whitespace-nowrap">{child.profile}</Badge> : null}
                        <span className="shrink-0 text-3xs tabular-nums text-fg-3">
                          {t('reader.childEvents', { count: child.events })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {visibleItems.length === 0 ? (
              <EmptyState
                icon={<Search className="h-5 w-5" />}
                title={t('reader.emptyFilterTitle')}
                hint={hasActiveFilter ? t('reader.emptyFilterHint') : undefined}
                action={
                  hasActiveFilter ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => {
                        setFilter('all');
                        setSearchQuery('');
                      }}
                    >
                      {t('reader.resetFilters')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="space-y-3">
                {visibleItems.map((item) => {
                  if (item.kind === 'tool_pair') {
                    const timestamp = item.call?.at ?? item.result?.at;
                    return (
                      <ToolPairCard
                        key={item.id}
                        call={item.call}
                        result={item.result}
                        cwd={cwd}
                        timeLabel={formatTime(timestamp)}
                        labels={toolLabels}
                        searchQuery={searchQuery}
                        bulkSignal={bulkSignal}
                      />
                    );
                  }

                  const event = item.event;
                  if (event.kind === 'message') {
                    return (
                      <MessageBubble
                        key={event.id}
                        event={event}
                        roleLabel={event.role === 'user' ? t('reader.roleUser') : t('reader.roleAgent')}
                        timeLabel={formatTime(event.at)}
                        injectedLabel={t('reader.injected')}
                        copyLabel={t('reader.copyMessage')}
                        copiedLabel={t('common.copied')}
                        expandLabel={t('common.expand')}
                        collapseLabel={t('common.collapse')}
                        codeFallbackLabel={t('reader.codeFallback')}
                        codeCopyLabel={t('reader.copyCode')}
                        searchQuery={searchQuery}
                      />
                    );
                  }

                  if (event.kind === 'reasoning') {
                    return (
                      <ReasoningBlock
                        key={event.id}
                        event={event}
                        thinkingLabel={t('reader.thinking')}
                        encryptedLabel={t('reader.encryptedReasoning')}
                        timeLabel={formatTime(event.at)}
                        copyLabel={t('common.copy')}
                        copiedLabel={t('common.copied')}
                        codeFallbackLabel={t('reader.codeFallback')}
                        codeCopyLabel={t('reader.copyCode')}
                        searchQuery={searchQuery}
                        bulkSignal={bulkSignal}
                      />
                    );
                  }

                  return (
                    <div key={event.id} className="flex justify-center">
                      <Badge variant="outline">{t('reader.boundary', { kind: event.text ?? '' })}</Badge>
                    </div>
                  );
                })}
              </div>
            )}

            {data && data.totalEvents > data.events.length ? (
              <div className="mt-6 flex flex-col items-center gap-2">
                <div className="text-caption text-fg-2">
                  {t('reader.shown', { shown: data.events.length, total: data.totalEvents })}
                </div>
                <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
                  {t('reader.loadMore')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
