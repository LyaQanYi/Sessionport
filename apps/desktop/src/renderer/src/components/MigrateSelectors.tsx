import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Clock, Folder, Search, X } from 'lucide-react';

import type { AgentId, SessionRow } from '../api.ts';
import { AgentGlyph, agentLabel } from '../agents.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { Badge, cn } from '../ui.tsx';

const MAX_RENDERED_SESSIONS = 120;

function matchesQuery(row: SessionRow, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [row.title, row.cwd, row.sessionId, row.agent, agentLabel(row.agent), row.nativePath]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function projectDisplay(row: SessionRow, fallback: string): string {
  return row.cwd ?? row.nativePath ?? fallback;
}

export interface SourceSessionPickerProps {
  sessions: SessionRow[];
  value: string | null;
  onChange: (key: string | null) => void;
  rowKey: (row: SessionRow) => string;
  loading?: boolean;
}

/**
 * 可搜索的源会话选择器：展示 agent 图标、会话标题、项目路径与更新时间，支持键盘导航。
 */
export function SourceSessionPicker(props: SourceSessionPickerProps): ReactNode {
  const { t, formatTime } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selected = useMemo(
    () => (props.value ? props.sessions.find((row) => props.rowKey(row) === props.value) ?? null : null),
    [props.sessions, props.value, props.rowKey],
  );

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return props.sessions.filter((row) => matchesQuery(row, terms));
  }, [props.sessions, query]);

  const visible = useMemo(() => filtered.slice(0, MAX_RENDERED_SESSIONS), [filtered]);
  const selectableIndexes = useMemo(() => {
    const indexes: number[] = [];
    for (let index = 0; index < visible.length; index += 1) {
      if (visible[index]?.readable !== false) indexes.push(index);
    }
    return indexes;
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = props.value ? visible.findIndex((row) => props.rowKey(row) === props.value && row.readable) : -1;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : (selectableIndexes[0] ?? 0));
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- open transitions only

  useEffect(() => {
    if (!open) return;
    if (visible.length === 0) {
      setActiveIndex(0);
      return;
    }
    const current = visible[activeIndex];
    if (!current || !current.readable) {
      setActiveIndex(selectableIndexes[0] ?? 0);
    }
  }, [open, visible, activeIndex, selectableIndexes]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const target = listRef.current.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const selectRow = (row: SessionRow): void => {
    if (!row.readable) return;
    props.onChange(props.rowKey(row));
    setQuery('');
    setOpen(false);
    triggerRef.current?.focus();
  };

  const stepActive = (delta: number): void => {
    if (selectableIndexes.length === 0) return;
    const pos = selectableIndexes.indexOf(activeIndex);
    if (pos === -1) {
      setActiveIndex(delta > 0 ? selectableIndexes[0]! : selectableIndexes[selectableIndexes.length - 1]!);
      return;
    }
    const nextPos = (pos + delta + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextPos]!);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      stepActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      stepActive(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = visible[activeIndex];
      if (row && row.readable) selectRow(row);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-haspopup="listbox"
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'flex min-h-[48px] w-full items-center gap-3 rounded-control border border-input bg-background px-3 py-2 text-left transition-colors',
            'hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
            selected ? 'pr-14' : 'pr-9',
            open && 'border-ring ring-2 ring-ring/20',
          )}
        >
          {selected ? (
            <>
              <AgentGlyph agent={selected.agent} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body font-medium text-fg-1">{selected.title ?? selected.sessionId}</span>
                  <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
                    {agentLabel(selected.agent)}
                  </Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-caption text-fg-2">
                  <Folder className="h-3 w-3 shrink-0 text-fg-3" />
                  <span className="min-w-0 truncate" title={projectDisplay(selected, t('migrate.sourceNoProject'))}>
                    {projectDisplay(selected, t('migrate.sourceNoProject'))}
                  </span>
                  <span className="shrink-0 text-fg-3">·</span>
                  <Clock className="h-3 w-3 shrink-0 text-fg-3" />
                  <span className="shrink-0 tabular-nums text-fg-3">{formatTime(selected.updatedAt)}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-body text-fg-3">
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">
                {props.loading ? t('migrate.loadingSessions') : t('migrate.sourcePlaceholder')}
              </span>
            </div>
          )}
        </button>

        {selected ? (
          <button
            type="button"
            aria-label={t('migrate.sourceClear')}
            title={t('migrate.sourceClear')}
            onClick={() => {
              props.onChange(null);
              triggerRef.current?.focus();
            }}
            className="absolute right-8 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-control text-fg-3 transition-colors hover:bg-accent hover:text-fg-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}

        <ChevronDown
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3 transition-transform',
            open && 'rotate-180',
          )}
        />
      </div>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-panel border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center gap-2 border-b border-border bg-subtle/60 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-3" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t('migrate.sourceSearchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-body text-fg-1 placeholder:text-fg-3 focus:outline-none"
            />
            {query.length > 0 ? (
              <button
                type="button"
                aria-label={t('migrate.sourceClearSearch')}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="flex h-5 w-5 items-center justify-center rounded-control text-fg-3 hover:bg-accent hover:text-fg-1"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
            <span className="shrink-0 text-3xs tabular-nums text-fg-3">
              {t('migrate.sourceMatchCount', { shown: filtered.length, total: props.sessions.length })}
            </span>
          </div>

          <div ref={listRef} id={listboxId} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {props.sessions.length === 0 ? (
              <div className="px-3 py-6 text-center text-caption text-fg-3">
                {props.loading ? t('migrate.loadingSessions') : t('migrate.sourceNoSessions')}
              </div>
            ) : visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-caption text-fg-3">{t('migrate.sourceEmpty')}</div>
            ) : (
              visible.map((row, index) => {
                const key = props.rowKey(row);
                const isSelected = props.value === key;
                const isHighlighted = index === activeIndex;
                const disabled = !row.readable;
                const project = projectDisplay(row, t('migrate.sourceNoProject'));
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={disabled}
                    data-option-index={index}
                    onMouseEnter={() => {
                      if (!disabled) setActiveIndex(index);
                    }}
                    onClick={() => selectRow(row)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors',
                      isSelected ? 'bg-selected' : isHighlighted && !disabled ? 'bg-accent' : 'hover:bg-accent/70',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <AgentGlyph agent={row.agent} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-body font-medium text-fg-1">{row.title ?? row.sessionId}</span>
                        {disabled ? <Badge variant="outline" className="shrink-0 whitespace-nowrap">{t('migrate.sourceUnreadable')}</Badge> : null}
                        <span className="ml-auto shrink-0 text-3xs tabular-nums text-fg-3">{formatTime(row.updatedAt)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-caption text-fg-2">
                        <span className="shrink-0 font-medium text-fg-2">{agentLabel(row.agent)}</span>
                        <span className="shrink-0 text-fg-3">·</span>
                        <span className="min-w-0 truncate" title={project}>
                          {project}
                        </span>
                      </div>
                    </div>
                    {isSelected ? <Check className="h-3.5 w-3.5 shrink-0 text-ring" /> : null}
                  </button>
                );
              })
            )}
          </div>

          {filtered.length > visible.length ? (
            <div className="border-t border-border bg-subtle/60 px-3 py-1.5 text-3xs text-fg-3">
              {t('migrate.sourceMoreHint', { shown: visible.length, total: filtered.length })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface TargetAgentSelectorProps {
  targets: AgentId[];
  value: AgentId | null;
  onChange: (target: AgentId) => void;
}

/**
 * 目标 agent 视觉网格选择器：展示图标、原生写入 vs Antigravity 交接写入标识与当前选中态。
 */
export function TargetAgentSelector(props: TargetAgentSelectorProps): ReactNode {
  const { t } = useT();

  if (props.targets.length === 0) {
    return (
      <div className="rounded-control border border-border bg-subtle px-3 py-2.5 text-caption text-fg-3">
        {t('migrate.target.empty')}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label={t('migrate.target')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {props.targets.map((agent) => {
        const selected = props.value === agent;
        const isHandoff = agent === 'antigravity';
        return (
          <button
            key={agent}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => props.onChange(agent)}
            className={cn(
              'group flex items-start gap-2.5 rounded-control border px-2.5 py-2 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
              selected ? 'border-ring bg-selected shadow-sm' : 'border-border bg-card hover:border-border-strong hover:bg-subtle',
            )}
          >
            <AgentGlyph agent={agent} size="sm" className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-body font-medium text-fg-1">{agentLabel(agent)}</span>
                {selected ? <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-ring" /> : null}
              </div>
              <div className="mt-0.5">
                {isHandoff ? (
                  <span className="inline-flex items-center rounded bg-ring/10 px-1.5 py-0.5 text-3xs font-medium text-ring">
                    {t('migrate.target.handoff')}
                  </span>
                ) : (
                  <span className="text-3xs text-fg-3">{t('migrate.target.native')}</span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
