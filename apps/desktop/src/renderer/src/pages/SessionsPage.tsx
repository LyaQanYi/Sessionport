import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, formatTime } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { Badge, Button, Card, EmptyState, Spinner, cn } from '../ui.tsx';

const AGENT_TONE: Record<string, 'info' | 'warn' | 'default' | 'error'> = {
  'kimi-code': 'info',
  'claude-code': 'warn',
  'command-code': 'default',
  dsh: 'info',
  codex: 'warn',
  opencode: 'default',
};

export function SessionsPage(props: { onOpen: (session: SessionRow) => void }) {
  const [query, setQuery] = useState('');
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });

  const sessions = useMemo(() => {
    const rows = data?.sessions ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, row.cwd, row.sessionId, row.agent].filter(Boolean).join(' ').toLowerCase().includes(needle),
    );
  }, [data, query]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[hsl(var(--border))] px-5 py-3">
        <div className="text-sm font-semibold">会话</div>
        <div className="text-xs text-[hsl(var(--muted-foreground))]">
          {data ? data.sessions.length + ' 个' : '—'} · {isFetching ? '刷新中' : '就绪'}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题 / 路径 / id"
            className="w-64 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs outline-none focus:border-[hsl(var(--ring))]"
          />
          <Button variant="ghost" onClick={() => void refetch()}>
            刷新
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
          <Spinner /> 正在扫描会话…
        </div>
      ) : error ? (
        <EmptyState title="加载失败" hint={String(error)} />
      ) : sessions.length === 0 ? (
        <EmptyState title="没有找到会话" hint={data?.warnings.join('；') || '检查对应 agent 的数据目录是否存在'} />
      ) : (
        <div className="flex-1 overflow-auto">
          {(data?.warnings ?? []).map((warning) => (
            <div key={warning} className="border-b border-[hsl(var(--border))] bg-amber-500/10 px-5 py-2 text-xs text-amber-200">
              {warning}
            </div>
          ))}
          {sessions.map((session) => (
            <button
              type="button"
              key={session.nativePath}
              onClick={() => props.onOpen(session)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-[hsl(var(--border))] px-5 py-3 text-left transition',
                'hover:bg-[hsl(var(--muted))]/50',
              )}
            >
              <Badge tone={AGENT_TONE[session.agent] ?? 'default'}>{session.agent}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{session.title ?? session.sessionId}</div>
                <div className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">{session.cwd ?? session.nativePath}</div>
              </div>
              <div className="shrink-0 text-[11px] text-[hsl(var(--muted-foreground))]">{formatTime(session.updatedAt)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
