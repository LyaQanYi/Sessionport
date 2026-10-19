import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw, Search, Sparkles } from 'lucide-react';

import { api, formatTime } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { Badge, Button, EmptyState, Input, Spinner, Topbar, cn } from '../ui.tsx';

export const AGENT_META: Record<string, { label: string; dot: string }> = {
  'kimi-code': { label: 'Kimi Code', dot: 'bg-violet-500' },
  'claude-code': { label: 'Claude Code', dot: 'bg-amber-500' },
  'command-code': { label: 'Command Code', dot: 'bg-emerald-500' },
  dsh: { label: 'DeepSeek Harness', dot: 'bg-sky-500' },
  codex: { label: 'Codex', dot: 'bg-zinc-400' },
  opencode: { label: 'opencode', dot: 'bg-rose-500' },
};

export function agentLabel(agent: string): string {
  return AGENT_META[agent]?.label ?? agent;
}

export function SessionsPage(props: { onOpen: (session: SessionRow) => void }) {
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });

  const all = data?.sessions ?? [];
  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of all) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
    return counts;
  }, [all]);

  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((row) => {
      if (agentFilter && row.agent !== agentFilter) return false;
      if (!needle) return true;
      return [row.title, row.cwd, row.sessionId, row.agent].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [all, query, agentFilter]);

  const rowVirtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 14,
  });

  return (
    <div className="flex h-full flex-col">
      <Topbar
        title="会话"
        subtitle={data ? all.length + ' 个会话 · ' + agentCounts.size + ' 个 agent' : '加载中…'}
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题 / 路径 / id"
                className="w-56 pl-7"
              />
            </div>
            <Button variant="outline" size="icon" onClick={() => void refetch()} title="刷新">
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            </Button>
          </>
        }
      >
        <div className="ml-4 hidden items-center gap-1 lg:flex">
          <button
            type="button"
            onClick={() => setAgentFilter(null)}
            className={cn(
              'h-6 rounded-full px-2 text-2xs transition-colors',
              agentFilter === null ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            全部 {all.length}
          </button>
          {[...agentCounts.entries()].map(([agent, count]) => (
            <button
              key={agent}
              type="button"
              onClick={() => setAgentFilter(agentFilter === agent ? null : agent)}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-full px-2 text-2xs transition-colors',
                agentFilter === agent ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', AGENT_META[agent]?.dot ?? 'bg-muted-foreground')} />
              {agentLabel(agent)} {count}
            </button>
          ))}
        </div>
      </Topbar>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 正在扫描会话…
        </div>
      ) : error ? (
        <EmptyState title="加载失败" hint={String(error)} />
      ) : sessions.length === 0 ? (
        <EmptyState title="没有找到会话" hint={data?.warnings.join('；') || '检查对应 agent 的数据目录是否存在'} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {(data?.warnings ?? []).map((warning) => (
            <div key={warning} className="border-b border-border bg-amber-500/10 px-4 py-2 text-2xs text-amber-600 dark:text-amber-400">
              {warning}
            </div>
          ))}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const session = sessions[virtualRow.index]!;
                return (
                  <div
                    key={session.agent + '|' + session.sessionId + '|' + session.nativePath}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: 'translateY(' + virtualRow.start + 'px)' }}
                  >
                    <button
                      type="button"
                      disabled={!session.readable}
                      title={session.readable ? undefined : '该 agent 还没有 reader，只能看到列表元数据'}
                      onClick={() => props.onOpen(session)}
                      className={cn(
                        'flex h-[60px] w-full items-center gap-3 border-b border-border px-4 text-left transition-colors',
                        session.readable ? 'hover:bg-accent' : 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', AGENT_META[session.agent]?.dot ?? 'bg-muted-foreground')} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium">{session.title ?? session.sessionId}</span>
                          {session.readable ? null : <Badge variant="outline">元数据</Badge>}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
                          <span className="shrink-0">{agentLabel(session.agent)}</span>
                          <span className="opacity-40">·</span>
                          <span className="truncate">{session.cwd ?? session.nativePath}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-2xs text-muted-foreground">{formatTime(session.updatedAt)}</div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border px-4 text-3xs text-muted-foreground">
            <Sparkles className="h-3 w-3" />
            共 {sessions.length} 条 · 虚拟滚动
          </div>
        </div>
      )}
    </div>
  );
}
