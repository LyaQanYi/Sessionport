import { useQuery } from '@tanstack/react-query';

import { api, formatTime } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { Badge, Button, Card, EmptyState, Spinner } from '../ui.tsx';

const ROLE_TONE = { user: 'info', assistant: 'default' } as const;

export function ReaderPage(props: { session: SessionRow; onBack: () => void; onMigrate: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['session', props.session.agent, props.session.nativePath],
    queryFn: () => api.readSession(props.session.agent, props.session.nativePath),
  });

  const resumeCommand = props.session.resumeHint;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[hsl(var(--border))] px-5 py-3">
        <Button variant="ghost" onClick={props.onBack}>
          ← 返回
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{data?.title ?? props.session.title ?? props.session.sessionId}</div>
          <div className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">
            {props.session.agent} · {data?.cwd ?? props.session.cwd ?? '—'} · {data ? data.events.length + ' 事件' : ''}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {resumeCommand ? (
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(resumeCommand)} title={resumeCommand}>
              复制 resume 命令
            </Button>
          ) : null}
          <Button onClick={props.onMigrate}>迁移到…</Button>
        </div>
      </header>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
          <Spinner /> 解析会话…
        </div>
      ) : error ? (
        <EmptyState title="读取失败" hint={String(error)} />
      ) : (
        <div className="flex-1 overflow-auto px-5 py-4">
          {(data?.notices ?? []).length > 0 ? (
            <Card className="mb-4 px-3 py-2">
              <div className="mb-1 text-[11px] font-medium text-[hsl(var(--muted-foreground))]">解读提示</div>
              <ul className="space-y-1">
                {data!.notices.map((notice) => (
                  <li key={notice.code} className="text-[11px] text-[hsl(var(--muted-foreground))]">
                    <span className="mr-1 font-mono">{notice.code}</span>
                    {notice.count ? '×' + notice.count + ' ' : ''}
                    {notice.message}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <div className="space-y-2">
            {data?.events.map((event) => {
              if (event.kind === 'message') {
                return (
                  <div key={event.id} className="flex gap-3">
                    <div className="w-16 shrink-0 pt-0.5">
                      <Badge tone={ROLE_TONE[event.role ?? 'assistant']}>{event.role}</Badge>
                    </div>
                    <div className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed">
                      {event.text}
                      {event.synthetic ? <span className="ml-2 text-[10px] text-[hsl(var(--muted-foreground))]">(注入)</span> : null}
                    </div>
                    <div className="w-20 shrink-0 text-right text-[10px] text-[hsl(var(--muted-foreground))]">{formatTime(event.at)}</div>
                  </div>
                );
              }
              if (event.kind === 'reasoning') {
                return (
                  <div key={event.id} className="ml-[76px] border-l-2 border-[hsl(var(--border))] pl-3 text-[12px] italic text-[hsl(var(--muted-foreground))]">
                    {event.text}
                  </div>
                );
              }
              if (event.kind === 'tool_call') {
                return (
                  <details key={event.id} className="ml-[76px] rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
                    <summary className="cursor-pointer text-[12px]">
                      <span className="font-mono text-[hsl(var(--primary))]">{event.toolName}</span>
                      <span className="ml-2 text-[10px] text-[hsl(var(--muted-foreground))]">{event.toolCallId}</span>
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-[hsl(var(--muted-foreground))]">{event.text}</pre>
                  </details>
                );
              }
              if (event.kind === 'tool_result') {
                return (
                  <details key={event.id} className="ml-[76px] rounded border border-[hsl(var(--border))] px-3 py-2">
                    <summary className="cursor-pointer text-[12px] text-[hsl(var(--muted-foreground))]">
                      {event.isError ? 'tool result (error)' : 'tool result'}
                      <span className="ml-2 font-mono text-[10px]">{event.toolCallId}</span>
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-[hsl(var(--muted-foreground))]">{event.text}</pre>
                  </details>
                );
              }
              return (
                <div key={event.id} className="ml-[76px] text-[11px] text-[hsl(var(--muted-foreground))]">
                  boundary · {event.text}
                </div>
              );
            })}
          </div>
          {data?.truncated ? (
            <div className="mt-4 text-[11px] text-amber-300">会话较长，只显示了前 {data.events.length} 个事件。</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
