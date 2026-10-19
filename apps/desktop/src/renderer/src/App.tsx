import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Blocks, ChevronLeft, ChevronRight, MessagesSquare, Monitor, Moon, Settings2, Sun } from 'lucide-react';

import { api } from './api.ts';
import type { SessionRow } from './api.ts';
import { AgentGlyph, AGENT_META, agentLabel } from './agents.tsx';
import { HOME_TO_AGENT, useAgentPreferences } from './preferences.ts';
import { cn } from './ui.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { ReaderPage } from './pages/ReaderPage.tsx';
import { MigratePage } from './pages/MigratePage.tsx';
import { AgentsPage } from './pages/AgentsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

export type View = 'sessions' | 'agents' | 'reader' | 'migrate' | 'settings';
export type ThemeMode = 'system' | 'light' | 'dark';

function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const fromEnv = window.sessionport?.initialTheme;
    if (fromEnv === 'light' || fromEnv === 'dark' || fromEnv === 'system') return fromEnv;
    return (localStorage.getItem('sessionport.theme') as ThemeMode | null) ?? 'system';
  });
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    if (mode !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode]);
  const update = (next: ThemeMode): void => {
    localStorage.setItem('sessionport.theme', next);
    setMode(next);
  };
  return [mode, update];
}

export function App() {
  const [view, setView] = useState<View>('sessions');
  const [active, setActive] = useState<SessionRow | null>(null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useTheme();
  const isMac = window.sessionport?.platform === 'darwin';

  const pathsQuery = useQuery({ queryKey: ['paths'], queryFn: api.paths });
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });

  const detected = useMemo(() => {
    const homes = pathsQuery.data?.homes ?? {};
    return Object.entries(homes)
      .filter(([, info]) => info.exists)
      .map(([key]) => HOME_TO_AGENT[key])
      .filter((agent): agent is string => Boolean(agent));
  }, [pathsQuery.data]);

  const prefs = useAgentPreferences(detected);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of sessionsQuery.data?.sessions ?? []) map.set(row.agent, (map.get(row.agent) ?? 0) + 1);
    return map;
  }, [sessionsQuery.data]);

  const themeIcon = useMemo(() => {
    if (theme === 'light') return <Sun className="h-3.5 w-3.5" />;
    if (theme === 'dark') return <Moon className="h-3.5 w-3.5" />;
    return <Monitor className="h-3.5 w-3.5" />;
  }, [theme]);

  const nextTheme = (): void => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');

  const navBack = (): void => setView('sessions');

  const globalNav = [
    { view: 'sessions' as View, label: '会话', icon: MessagesSquare },
    { view: 'agents' as View, label: '适配器', icon: Blocks },
    { view: 'migrate' as View, label: '迁移', icon: ArrowLeftRight },
  ];

  const rowClass = (selected: boolean): string =>
    cn(
      'group relative flex h-8 w-full items-center gap-2 rounded-control px-2.5 text-body transition-colors app-no-drag',
      selected ? 'bg-sidebar-selected font-medium text-sidebar-foreground' : 'text-sidebar-muted hover:bg-sidebar-row hover:text-sidebar-foreground',
    );

  const enabledAgents = prefs.enabled;

  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      <aside className={cn('flex w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar', isMac ? 'pt-10' : 'pt-3', collapsed && 'hidden')}>
        <div className="mb-3 flex items-center gap-2 px-4 app-no-drag">
          <div className="flex h-6 w-6 items-center justify-center rounded-control bg-primary text-primary-foreground">
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-title leading-tight">sessionport</div>
            <div className="truncate text-caption text-sidebar-muted">跨 agent 会话搬运</div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="flex h-6 w-6 items-center justify-center rounded-control text-sidebar-muted hover:bg-sidebar-row hover:text-sidebar-foreground"
            title="收起侧栏"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 我安装的 harness：点一行 = 过滤该 agent 的会话 */}
        <div className="px-2">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-3xs font-medium uppercase tracking-wider text-sidebar-muted">Harness</span>
            <button
              type="button"
              onClick={() => setView('settings')}
              className="text-3xs text-sidebar-muted hover:text-sidebar-foreground"
              title="在设置里选择显示哪些 harness"
            >
              管理
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {enabledAgents.length === 0 ? (
              <button type="button" onClick={() => setView('settings')} className={cn(rowClass(false), 'justify-start')}>
                还没有启用的 harness…
              </button>
            ) : (
              enabledAgents.map((agent) => {
                const selected = view === 'sessions' && agentFilter === agent;
                const count = counts.get(agent) ?? 0;
                return (
                  <button
                    key={agent}
                    type="button"
                    data-nav={'agent:' + agent}
                    onClick={() => {
                      setAgentFilter(agent);
                      setView('sessions');
                    }}
                    className={rowClass(selected)}
                    title={agentLabel(agent)}
                  >
                    {selected ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-ring" /> : null}
                    <AgentGlyph agent={agent} size="sm" />
                    <span className="truncate">{agentLabel(agent)}</span>
                    {count > 0 ? (
                      <span className="ml-auto rounded-full bg-sidebar-row px-1.5 text-3xs tabular-nums text-sidebar-muted">{count}</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="mx-4 my-3 h-px bg-sidebar-border" />

        <nav className="flex flex-col gap-0.5 px-2">
          {globalNav.map((item) => {
            const Icon = item.icon;
            const selected =
              item.view === 'sessions'
                ? (view === 'sessions' && agentFilter === null) || view === 'reader'
                : view === item.view;
            return (
              <button
                key={item.view}
                type="button"
                data-nav={item.view}
                onClick={() => {
                  if (item.view === 'sessions') setAgentFilter(null);
                  setView(item.view);
                }}
                className={rowClass(selected)}
              >
                {selected ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-ring" /> : null}
                <Icon className="h-4 w-4 shrink-0 opacity-80" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {active ? (
          <button
            type="button"
            onClick={() => setView('reader')}
            className="mx-2 mt-3 flex items-center gap-2 rounded-control px-2.5 py-2 text-left hover:bg-sidebar-row"
            title={active.nativePath}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ring" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-caption text-sidebar-foreground">{active.title ?? active.sessionId}</span>
              <span className="block truncate text-3xs text-sidebar-muted">{active.agent}</span>
            </span>
          </button>
        ) : null}

        <div className="mt-auto flex flex-col gap-2 px-2 pb-2">
          <button
            type="button"
            data-nav="settings"
            onClick={() => setView('settings')}
            className={rowClass(view === 'settings')}
          >
            {view === 'settings' ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-ring" /> : null}
            <Settings2 className="h-4 w-4 shrink-0 opacity-80" />
            <span className="truncate">设置</span>
          </button>
          <div className="flex items-center justify-between rounded-control px-1">
            <span className="text-3xs text-sidebar-muted">v0.0.0 · alpha</span>
            <button
              type="button"
              onClick={nextTheme}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-3xs text-sidebar-muted hover:bg-sidebar-row hover:text-sidebar-foreground"
              title={'主题：' + theme}
            >
              {themeIcon}
              <span>{theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}</span>
            </button>
          </div>
        </div>
      </aside>

      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="absolute left-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-control border border-border bg-card text-fg-2 shadow-sm hover:text-fg-1"
          title="展开侧栏"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {view === 'sessions' ? (
          <SessionsPage
            enabledAgents={enabledAgents}
            agentFilter={agentFilter}
            onAgentFilterChange={setAgentFilter}
            onOpen={(session) => {
              setActive(session);
              setView('reader');
            }}
          />
        ) : null}
        {view === 'agents' ? (
          <AgentsPage
            prefs={prefs}
            onOpenAgent={(agent) => {
              setAgentFilter(agent);
              setView('sessions');
            }}
          />
        ) : null}
        {view === 'reader' && active ? (
          <ReaderPage session={active} onBack={navBack} onMigrate={() => setView('migrate')} />
        ) : null}
        {view === 'migrate' ? <MigratePage initial={active} enabledAgents={enabledAgents} /> : null}
        {view === 'settings' ? <SettingsPage theme={theme} onThemeChange={setTheme} prefs={prefs} /> : null}
      </main>
    </div>
  );
}