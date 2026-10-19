import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { api, sessionRefOf } from '../api.ts';
import type { AgentId, SessionRow } from '../api.ts';
import { Badge, Button, Card, EmptyState } from '../ui.tsx';

export function MigratePage(props: { initial: SessionRow | null }) {
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const rowKey = (row: SessionRow): string => row.agent + '|' + row.sessionId + '|' + row.nativePath;
  const [sourceKey, setSourceKey] = useState<string | null>(props.initial ? rowKey(props.initial) : null);
  const [target, setTarget] = useState<AgentId | null>(null);
  const [register, setRegister] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(false);

  useEffect(() => {
    if (props.initial && sourceKey === null) setSourceKey(rowKey(props.initial));
  }, [props.initial, sourceKey]);

  const sessions = sessionsQuery.data?.sessions ?? [];
  const source = useMemo(() => sessions.find((row) => rowKey(row) === sourceKey) ?? null, [sessions, sourceKey]);
  const writable = capsQuery.data?.writable ?? [];

  useEffect(() => {
    if (target === null && writable.length > 0) setTarget(writable[0] ?? null);
  }, [target, writable]);

  const preview = useMutation({
    mutationFn: () => api.previewMigration(source!.agent, sessionRefOf(source!), target!),
  });
  const run = useMutation({
    mutationFn: () => api.runMigration({ agent: source!.agent, ref: sessionRefOf(source!), target: target!, register, includeChildren }),
  });

  const losses = preview.data?.losses ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[hsl(var(--border))] px-5 py-3">
        <div className="text-sm font-semibold">迁移</div>
        <div className="text-[11px] text-[hsl(var(--muted-foreground))]">选源 → 选目标 → 先预览损失清单，再写入</div>
      </header>

      <div className="flex-1 overflow-auto px-5 py-4">
        <Card className="mb-4 p-4">
          <div className="grid grid-cols-[1fr_1fr] gap-4">
            <label className="block">
              <div className="mb-1 text-[11px] text-[hsl(var(--muted-foreground))]">源会话</div>
              <select
                value={sourceKey ?? ''}
                onChange={(event) => setSourceKey(event.target.value || null)}
                className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs"
              >
                <option value="">（选择）</option>
                {sessions.map((row) => (
                  <option key={rowKey(row)} value={rowKey(row)}>
                    {row.agent} · {row.title ?? row.sessionId}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <div className="mb-1 text-[11px] text-[hsl(var(--muted-foreground))]">目标 agent</div>
              <select
                value={target ?? ''}
                onChange={(event) => setTarget((event.target.value || null) as AgentId | null)}
                className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs"
              >
                <option value="">（选择）</option>
                {writable.map((agent) => (
                  <option key={agent} value={agent}>
                    {agent}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-[hsl(var(--muted-foreground))]">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={register} onChange={(event) => setRegister(event.target.checked)} />
              写入目标 app 的索引（--register）
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={includeChildren} onChange={(event) => setIncludeChildren(event.target.checked)} />
              包含子代理会话
            </label>
            <Button
              className="ml-auto"
              disabled={!source || !target || preview.isPending}
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? '计算中…' : '预览损失清单'}
            </Button>
          </div>
          {preview.error ? <div className="mt-2 text-xs text-red-300">{String(preview.error)}</div> : null}
        </Card>

        {preview.data ? (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{preview.data.source.agent}</span>
                <span className="text-[hsl(var(--muted-foreground))]">{preview.data.source.title ?? preview.data.source.sessionId}</span>
                <span className="text-[hsl(var(--muted-foreground))]">→</span>
                <span className="font-medium">{preview.data.target}</span>
                <span className="ml-auto text-[11px] text-[hsl(var(--muted-foreground))]">
                  {preview.data.source.events} 事件 · 损失 {losses.length} 类
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(preview.data.caps).map(([key, value]) => (
                  <Badge key={key} tone={value === false ? 'warn' : 'info'}>
                    {key}: {String(value)}
                  </Badge>
                ))}
              </div>

              <div className="mt-4 overflow-hidden rounded border border-[hsl(var(--border))]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                    <tr>
                      <th className="px-3 py-2 font-medium">severity</th>
                      <th className="px-3 py-2 font-medium">loss</th>
                      <th className="px-3 py-2 font-medium">count</th>
                      <th className="px-3 py-2 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {losses.length === 0 ? (
                      <tr>
                        <td className="px-3 py-3 text-[hsl(var(--muted-foreground))]" colSpan={4}>
                          没有损失（或该 adapter 未报告）
                        </td>
                      </tr>
                    ) : (
                      losses.map((loss) => (
                        <tr key={loss.code + loss.message} className="border-t border-[hsl(var(--border))]">
                          <td className="px-3 py-2">
                            <Badge tone={loss.severity === 'warning' ? 'warn' : 'info'}>{loss.severity}</Badge>
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px]">{loss.code}</td>
                          <td className="px-3 py-2">{loss.count}</td>
                          <td className="px-3 py-2 text-[hsl(var(--muted-foreground))]">{loss.message}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Button disabled={run.isPending} onClick={() => run.mutate()}>
                  {run.isPending ? '写入中…' : '确认写入 ' + preview.data.target}
                </Button>
                <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                  写入前会再跑一次同样的转换；目标端已有内容时请用 CLI 的 sync 语义
                </span>
              </div>
              {run.error ? <div className="mt-2 text-xs text-red-300">{String(run.error)}</div> : null}
              {run.data ? (
                <div className="mt-3 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-3 text-xs">
                  <div>
                    已写入 <span className="font-mono">{run.data.target}</span> · session{' '}
                    <span className="font-mono">{run.data.sessionId}</span>
                  </div>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
                    {run.data.paths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          </div>
        ) : sessionsQuery.isLoading ? (
          <EmptyState title="加载会话列表中…" />
        ) : null}
      </div>
    </div>
  );
}