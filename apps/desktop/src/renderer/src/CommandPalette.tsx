import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  Blocks,
  CornerDownLeft,
  MessagesSquare,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  Settings2,
  Sun,
  type LucideIcon,
} from 'lucide-react';

import type { SessionRow } from './api.ts';
import { AgentGlyph, agentLabel } from './agents.tsx';
import {
  buildCommands,
  clampSelection,
  groupCommands,
  nextTheme,
  resolveCommand,
  stepSelection,
  visibleCommands,
  type PaletteCommand,
  type PaletteGroup,
  type PaletteTheme,
  type PaletteView,
} from './commandPalette.ts';
import { useT } from './i18n/I18nProvider.tsx';
import { Badge, Kbd, cn } from './ui.tsx';

/** 稳定的空数组，避免 useMemo 每次 render 都失效 */
const EMPTY_SESSIONS: SessionRow[] = [];

export interface CommandPaletteProps {
  /** api.listSessions() 的缓存数据（App 里的 ['sessions'] query） */
  sessions: SessionRow[] | undefined;
  /** 会话列表还在加载 */
  loading?: boolean;
  theme: PaletteTheme;
  onClose: () => void;
  onOpenSession: (session: SessionRow) => void;
  onNavigate: (view: PaletteView) => void;
  onRefreshSessions: () => void;
  onThemeChange: (theme: PaletteTheme) => void;
}

function groupLabel(t: ReturnType<typeof useT>['t'], group: PaletteGroup): string {
  if (group === 'sessions') return t('palette.group.sessions');
  if (group === 'pages') return t('palette.group.pages');
  return t('palette.group.actions');
}

function iconFor(command: PaletteCommand<SessionRow>, theme: PaletteTheme): LucideIcon {
  if (command.view === 'sessions') return MessagesSquare;
  if (command.view === 'agents') return Blocks;
  if (command.view === 'migrate') return ArrowLeftRight;
  if (command.action === 'refresh-sessions') return RefreshCw;
  if (command.action === 'cycle-theme') return theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return Settings2;
}

function CommandGlyph(props: { command: PaletteCommand<SessionRow>; theme: PaletteTheme }): ReactNode {
  if (props.command.session) return <AgentGlyph agent={props.command.session.agent} size="sm" />;
  const Icon = iconFor(props.command, props.theme);
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-muted text-fg-2">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * ⌘K 命令面板：模态浮层 + 输入即过滤 + ↑↓/Enter/Esc。
 * 逻辑（命令构造、匹配排序）全部在 commandPalette.ts，这里只负责渲染与焦点。
 */
export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  const sessions = props.sessions ?? EMPTY_SESSIONS;
  const commands = useMemo(
    () =>
      visibleCommands(
        buildCommands({ sessions, t, theme: props.theme, agentLabel }),
        query,
      ),
    [sessions, t, props.theme, query],
  );
  const sections = useMemo(() => groupCommands(commands), [commands]);
  const selected = clampSelection(activeIndex, commands.length);

  // 打开时聚焦输入框；关闭/卸载时把焦点还给原来的元素
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      const target = restoreRef.current;
      if (target !== null && document.contains(target)) target.focus();
    };
  }, []);

  // Esc 关闭：即使焦点不在输入框（比如点到了列表空白处）也能关
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 输入变化后从头开始选
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 选中项滚进可视区
  useEffect(() => {
    if (selected < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-palette-option="' + selected + '"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected, commands.length]);

  const run = (command: PaletteCommand<SessionRow> | undefined): void => {
    if (!command) return;
    const intent = resolveCommand(command);
    if (intent === null) return;
    if (intent.kind === 'open-session') props.onOpenSession(intent.session);
    else if (intent.kind === 'navigate') props.onNavigate(intent.view);
    else if (intent.action === 'refresh-sessions') props.onRefreshSessions();
    else if (intent.action === 'cycle-theme') props.onThemeChange(nextTheme(props.theme));
    else props.onNavigate('settings');
    props.onClose();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(stepSelection(selected, event.key === 'ArrowDown' ? 1 : -1, commands.length));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(commands.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(commands[selected]);
    } else if (event.key === 'Tab') {
      // 模态里的焦点只留在输入框，避免 Tab 跑到遮罩后面的页面上
      event.preventDefault();
    }
  };

  let cursor = 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-dialog border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-fg-3" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-label={t('palette.title')}
            aria-activedescendant={selected >= 0 ? 'palette-option-' + selected : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('palette.placeholder')}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-fg-1 placeholder:text-fg-3 focus:outline-none"
            spellCheck={false}
          />
          <button type="button" onClick={props.onClose} aria-label={t('palette.close')} className="shrink-0 rounded-control p-0.5">
            <Kbd>esc</Kbd>
          </button>
        </div>

        <div ref={listRef} id="palette-listbox" role="listbox" aria-label={t('palette.title')} className="max-h-[min(420px,60vh)] overflow-y-auto p-1">
          {commands.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
              <span className="text-section text-fg-1">{t('palette.empty')}</span>
              <span className="max-w-xs text-caption leading-relaxed text-fg-2">
                {props.loading ? t('palette.loading') : t('palette.emptyHint')}
              </span>
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.group} role="group" aria-labelledby={'palette-group-' + section.group} className="py-0.5">
                <div
                  id={'palette-group-' + section.group}
                  className="px-2 pb-1 pt-1.5 text-3xs font-medium uppercase tracking-wider text-fg-3"
                >
                  {groupLabel(t, section.group)}
                </div>
                {section.commands.map((command) => {
                  const index = cursor;
                  cursor += 1;
                  const active = index === selected;
                  return (
                    <button
                      key={command.id}
                      type="button"
                      role="option"
                      id={'palette-option-' + index}
                      data-palette-option={index}
                      aria-selected={active}
                      onMouseMove={() => {
                        if (!active) setActiveIndex(index);
                      }}
                      onClick={() => run(command)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-body transition-colors',
                        active ? 'bg-selected text-fg-1' : 'text-fg-2 hover:bg-accent',
                      )}
                    >
                      <CommandGlyph command={command} theme={props.theme} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{command.label}</span>
                        {command.hint ? <span className="block truncate text-caption text-fg-3">{command.hint}</span> : null}
                      </span>
                      {command.session && command.session.readable === false ? (
                        <Badge variant="outline">{t('sessions.metadata')}</Badge>
                      ) : null}
                      {active ? <CornerDownLeft className="h-3 w-3 shrink-0 text-fg-3" /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-3 text-3xs text-fg-3">
          <span className="truncate">{t('palette.footer.hint')}</span>
          <span className="ml-auto tabular-nums">{t('palette.resultCount', { count: commands.length })}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
