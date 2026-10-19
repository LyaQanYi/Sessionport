import { useState } from 'react';

import type { SessionRow } from './api.ts';
import { cn } from './ui.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { ReaderPage } from './pages/ReaderPage.tsx';
import { MigratePage } from './pages/MigratePage.tsx';

type View = 'sessions' | 'reader' | 'migrate';

export function App() {
  const [view, setView] = useState<View>('sessions');
  const [active, setActive] = useState<SessionRow | null>(null);

  const navItem = (target: View, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => setView(target)}
      className={cn(
        'w-full rounded-md px-3 py-2 text-left text-sm transition',
        view === target ? 'bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]/60',
      )}
    >
      <div className="font-medium">{label}</div>
      <div className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">{hint}</div>
    </button>
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col gap-2 border-r border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 pb-3 pt-12">
        <div className="px-2 pb-2">
          <div className="text-sm font-semibold tracking-wide">sessionport</div>
          <div className="text-[11px] text-[hsl(var(--muted-foreground))]">跨 agent 会话搬运</div>
        </div>
        {navItem('sessions', '会话', '浏览本机所有 agent 的会话')}
        {navItem('migrate', '迁移', '选择源 → 目标，先看损失清单')}
        <div className="mt-auto px-2 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
          {active ? (
            <div className="truncate" title={active.nativePath}>
              当前：{active.agent} · {active.title ?? active.sessionId}
            </div>
          ) : (
            <div>没有选中的会话</div>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        {view === 'sessions' ? (
          <SessionsPage
            onOpen={(session) => {
              setActive(session);
              setView('reader');
            }}
          />
        ) : null}
        {view === 'reader' ? (
          active ? (
            <ReaderPage session={active} onBack={() => setView('sessions')} onMigrate={() => setView('migrate')} />
          ) : (
            <div className="p-8 text-sm text-[hsl(var(--muted-foreground))]">先从「会话」里选一个。</div>
          )
        ) : null}
        {view === 'migrate' ? <MigratePage initial={active} /> : null}
      </main>
    </div>
  );
}
