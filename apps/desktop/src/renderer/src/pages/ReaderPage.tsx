import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, Brain, Copy, Info, SquareTerminal, Wrench } from 'lucide-react';

import { api, formatTime, sessionRefOf } from '../api.ts';
import type { SessionRow } from '../api.ts';
import { Badge, Button, Spinner, Topbar, cn } from '../ui.tsx';
import { agentLabel } from '../agents.tsx';

const PAGE_SIZE = 300;

function CopyButton(props: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(props.text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <Copy className="h-3.5 w-3.5" />
      {copied ? '已复制' : props.label}
    </Button>
  );
}

export function ReaderPage(props: { session: SessionRow; onBack: () => void; onMigrate: () => void }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data, isLoading, error } = useQuery({
    queryKey: ['session', props.session.agent, props.session.nativePath, props.session.sessionId, limit],
    queryFn: () => api.readSession(props.session.agent, sessionRefOf(props.session), limit),
  });

  return (
    <div className="flex h-full flex-col">
      <Topbar
        title={data?.title ?? props.session.title ?? props.session.sessionId}
        subtitle={(data?.cwd ?? props.session.cwd ?? '—') + ' · ' + agentLabel(props.session.agent)}
        actions={
          <>
            {props.session.resumeHint ? <CopyButton text={props.session.resumeHint} label="复制 resume 命令" /> : null}
            <Button size="sm" onClick={props.onMigrate}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              迁移
            </Button>
            <Button variant="ghost" size="icon" onClick={props.onBack} title="返回会话列表">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 解析会话…
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <div className="text-sm font-medium">读取失败</div>
          <div className="max-w-md text-xs text-muted-foreground">{String(error)}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-chat px-5 py-6">
            {(data?.notices ?? []).length > 0 ? (
              <details className="group mb-5 rounded-lg border border-border bg-muted">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-2xs font-medium text-muted-foreground">
                  <Info className="h-3 w-3" />
                  解读提示 · {data!.notices.length} 类
                  <span className="ml-auto text-3xs group-open:hidden">展开</span>
                  <span className="ml-auto hidden text-3xs group-open:inline">收起</span>
                </summary>
                <ul className="max-h-48 space-y-1 overflow-auto border-t border-border px-3 py-2">
                  {data!.notices.map((notice) => (
                    <li key={notice.code} className="text-2xs leading-relaxed text-muted-foreground">
                      <span className="mr-1.5 font-mono text-3xs opacity-70">{notice.code}</span>
                      {notice.count ? '×' + notice.count + ' ' : ''}
                      {notice.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="space-y-3">
              {data?.events.map((event) => {
                if (event.kind === 'message') {
                  const isUser = event.role === 'user';
                  if (event.synthetic) {
                    const preview = (event.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
                    return (
                      <details key={event.id} className="group rounded-md border border-border bg-muted">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-3xs text-muted-foreground">
                          <span className="rounded border border-border px-1 py-px text-[9px] font-medium">注入</span>
                          <span className="truncate opacity-80">{preview}…</span>
                          <span className="ml-auto opacity-60 group-open:hidden">展开</span>
                          <span className="ml-auto hidden opacity-60 group-open:inline">收起</span>
                          <span className="ml-2 opacity-50">{formatTime(event.at)}</span>
                        </summary>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          {event.text}
                        </pre>
                      </details>
                    );
                  }
                  return (
                    <div key={event.id} className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
                      <div className="flex items-center gap-2 text-3xs text-muted-foreground">
                        <span>{isUser ? '你' : 'agent'}</span>
                        <span className="opacity-50">{formatTime(event.at)}</span>
                        {event.synthetic ? <Badge variant="outline">注入</Badge> : null}
                      </div>
                      <div
                        className={cn(
                          'max-w-[92%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                          isUser ? 'bg-primary/10 text-foreground' : 'bg-card text-foreground',
                        )}
                      >
                        {event.text}
                      </div>
                    </div>
                  );
                }
                if (event.kind === 'reasoning') {
                  return (
                    <div key={event.id} className="flex gap-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
                      <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
                      <span className="whitespace-pre-wrap">{event.text}</span>
                    </div>
                  );
                }
                if (event.kind === 'tool_call') {
                  return (
                    <details key={event.id} className="group rounded-lg border border-border bg-card">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs">
                        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-[11px] text-foreground">{event.toolName}</span>
                        <span className="truncate font-mono text-3xs text-muted-foreground">{event.toolCallId}</span>
                        <span className="ml-auto text-3xs text-muted-foreground group-open:hidden">展开</span>
                        <span className="ml-auto hidden text-3xs text-muted-foreground group-open:inline">收起</span>
                      </summary>
                      <pre className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {event.text}
                      </pre>
                    </details>
                  );
                }
                if (event.kind === 'tool_result') {
                  return (
                    <details key={event.id} className="group rounded-lg border border-border bg-background">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs">
                        <SquareTerminal className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-muted-foreground">{event.isError ? 'tool result · error' : 'tool result'}</span>
                        <span className="truncate font-mono text-3xs text-muted-foreground">{event.toolCallId}</span>
                        <span className="ml-auto text-3xs text-muted-foreground group-open:hidden">展开</span>
                        <span className="ml-auto hidden text-3xs text-muted-foreground group-open:inline">收起</span>
                      </summary>
                      <pre className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {event.text}
                      </pre>
                    </details>
                  );
                }
                return (
                  <div key={event.id} className="flex justify-center">
                    <Badge variant="outline">boundary · {event.text}</Badge>
                  </div>
                );
              })}
            </div>

            {data && data.totalEvents > data.events.length ? (
              <div className="mt-6 flex flex-col items-center gap-2">
                <div className="text-2xs text-muted-foreground">
                  已显示 {data.events.length} / {data.totalEvents} 个事件
                </div>
                <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
                  加载更多
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}