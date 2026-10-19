import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Blocks, MessagesSquare, Monitor, Moon, Settings2, Sun } from 'lucide-react';

import type { SessionRow } from './api.ts';
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

const MAIN_NAV = [
  { view: 'sessions' as View, label: '会话', icon: MessagesSquare },
  { view: 'agents' as View, label: '适配器', icon: Blocks },
  { view: 'migrate' as View, label: '迁移', icon: ArrowLeftRight },
];

export function App() {
  const [view, setView] = useState<View>('sessions');
  const [active, setActive] = useState<SessionRow | null>(null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const isMac = window.sessionport?.platform === 'darwin';

  const themeIcon = useMemo(() => {
    if (theme === 'light') return <Sun className="h-3.5 w-3.5" />;
    if (theme === 'dark') return <Moon className="h-3.5 w-3.5" />;
    return <Monitor className="h-3.5 w-3.5" />;
  }, [theme]);

  const nextTheme = (): void => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');

  const navItem = (item: { view: View; label: string; icon: typeof MessagesSquare }, selected: boolean) => {
    const Icon = item.icon;
    return (
      <button
        key={item.view}
        type="button"
        onClick={() => setView(item.view)}
        data-nav={item.view}
        className={cn(
          'group relative flex h-8 items-center gap-2 rounded-control px-2.5 text-body transition-colors app-no-drag',
          selected ? 'bg-sidebar-selected font-medium text-sidebar-foreground' : 'text-sidebar-muted hover:bg-sidebar-row hover:text-sidebar-foreground',
        )}
      >
        {selected ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-ring" /> : null}
        <Icon className="h-4 w-4 shrink-0 opacity-80" />
        <span className="truncate">{item.label}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      <aside className={cn('flex w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar', isMac ? 'pt-10' : 'pt-3')}>
        <div className="mb-3 flex items-center gap-2 px-4 app-no-drag">
          <div className="flex h-6 w-6 items-center justify-center rounded-control bg-primary text-primary-foreground">
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-title leading-tight">sessionport</div>
            <div className="truncate text-caption text-sidebar-muted">跨 agent 会话搬运</div>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          {MAIN_NAV.map((item) => navItem(item, view === item.view || (item.view === 'sessions' && view === 'reader')))}
        </nav>

        <div className="mt-auto flex flex-col gap-2 px-2 pb-2">
          {active ? (
            <button
              type="button"
              onClick={() => setView('reader')}
              className="flex items-center gap-2 rounded-control px-2.5 py-2 text-left hover:bg-sidebar-row"
              title={active.nativePath}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ring" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-caption text-sidebar-foreground">{active.title ?? active.sessionId}</span>
                <span className="block truncate text-3xs text-sidebar-muted">{active.agent}</span>
              </span>
            </button>
          ) : null}
          {navItem({ view: 'settings' as View, label: '设置', icon: Settings2 }, view === 'settings')}
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

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {view === 'sessions' ? (
          <SessionsPage
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
            onOpenAgent={(agent) => {
              setAgentFilter(agent);
              setView('sessions');
            }}
          />
        ) : null}
        {view === 'reader' ? (
          active ? (
            <ReaderPage session={active} onBack={() => setView('sessions')} onMigrate={() => setView('migrate')} />
          ) : (
            <div className="p-8 text-body text-fg-2">先从「会话」里选一个。</div>
          )
        ) : null}
        {view === 'migrate' ? <MigratePage initial={active} /> : null}
        {view === 'settings' ? <SettingsPage theme={theme} onThemeChange={setTheme} /> : null}
      </main>
    </div>
  );
}