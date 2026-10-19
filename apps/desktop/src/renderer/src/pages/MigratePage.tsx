import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, ListChecks, Loader2 } from 'lucide-react';

import { api, sessionRefOf } from '../api.ts';
import type { AgentId, DivergedMode, SessionRow } from '../api.ts';
import { Badge, Button, Card, CheckboxRow, Select, Spinner, Topbar, cn } from '../ui.tsx';
import { agentLabel } from '../agents.tsx';

const DECISION_TONE = {
  fresh: 'default',
  refresh: 'default',
  'up-to-date': 'success',
  diverged: 'warning',
} as const;

export function MigratePage(props: { initial: SessionRow | null }) {
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const rowKey = (row: SessionRow): string => row.agent + '|' + row.sessionId + '|' + row.nativePath;
  const [sourceKey, setSourceKey] = useState<string | null>(props.initial ? rowKey(props.initial) : null);
  const [target, setTarget] = useState<AgentId | null>(null);
  const [register, setRegister] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [mode, setMode] = useState<DivergedMode>('auto');

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
    mutationFn: () => api.previewMigration(source!.agent, sessionRefOf(source!), target!, { register, includeChildren }),
  });
  const run = useMutation({
    mutationFn: () =>
      api.runMigration({ agent: source!.agent, ref: sessionRefOf(source!), target: target!, register, includeChildren, onDiverged: mode }),
    onSuccess: (result) => {
      if (!result.refused) preview.mutate();
    },
  });

  const losses = preview.data?.losses ?? [];
  const warned = losses.filter((loss) => loss.severity === 'warning').length;

  return (
    <div className="flex h-full flex-col">
      <Topbar title="迁移" subtitle="选源 → 选目标 → 先预览损失清单，再写入" />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          <Card className="p-4">
            <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-end">
              <label className="block space-y-1.5">
                <div className="text-2xs font-medium text-muted-foreground">来源会话</div>
                <Select value={sourceKey ?? ''} onChange={(event) => setSourceKey(event.target.value || null)}>
                  <option value="">（选择）</option>
                  {sessions.map((row) => (
                    <option key={rowKey(row)} value={rowKey(row)}>
                      {agentLabel(row.agent)} · {row.title ?? row.sessionId}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="hidden pb-2 text-muted-foreground md:block">
                <ArrowRight className="h-4 w-4" />
              </div>
              <label className="block space-y-1.5">
                <div className="text-2xs font-medium text-muted-foreground">目标 agent</div>
                <Select value={target ?? ''} onChange={(event) => setTarget((event.target.value || null) as AgentId | null)}>
                  <option value="">（选择）</option>
                  {writable.map((agent) => (
                    <option key={agent} value={agent}>
                      {agentLabel(agent)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              <CheckboxRow checked={register} onChange={setRegister}>
                写入目标 app 索引
              </CheckboxRow>
              <CheckboxRow checked={includeChildren} onChange={setIncludeChildren}>
                包含子代理会话
              </CheckboxRow>
              <Button
                className="ml-auto"
                size="sm"
                disabled={!source || !target || preview.isPending}
                onClick={() => preview.mutate()}
              >
                {preview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                预览损失清单
              </Button>
            </div>
            {preview.error ? (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {String(preview.error)}
              </div>
            ) : null}
          </Card>

          {preview.data ? (
            <div className="mt-4 space-y-4">
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{agentLabel(preview.data.source.agent)}</span>
                  <span className="truncate text-muted-foreground">{preview.data.source.title ?? preview.data.source.sessionId}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{agentLabel(preview.data.target)}</span>
                  <Badge variant={DECISION_TONE[preview.data.sync.decision]} className="ml-auto">
                    {preview.data.sync.decision}
                  </Badge>
                </div>
                <div className="mt-1 text-2xs text-muted-foreground">{preview.data.sync.description}</div>
                <div className="mt-2 grid gap-1 font-mono text-3xs text-muted-foreground">
                  <div>source events = {preview.data.sync.sourceEvents}</div>
                  <div>target units = {preview.data.sync.targetUnits}</div>
                  {preview.data.sync.targetPath ? <div className="truncate">target path = {preview.data.sync.targetPath}</div> : null}
                  <div className="truncate">registry = {preview.data.sync.stateFile}</div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
                  {Object.entries(preview.data.caps).map(([key, value]) => (
                    <Badge key={key} variant={value === false ? 'warning' : 'outline'}>
                      {key}: {String(value)}
                    </Badge>
                  ))}
                </div>
              </Card>

              {preview.data.sync.decision === 'diverged' ? (
                <Card className="border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    目标端在上次迁移后新增了 {preview.data.sync.targetExtra ?? 0} 条内容
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {([
                      { value: 'fork' as DivergedMode, title: 'fork', hint: '另建一会话，保留旧的（推荐）' },
                      { value: 'force' as DivergedMode, title: 'force', hint: '覆盖目标端，新增内容会丢' },
                      { value: 'auto' as DivergedMode, title: '拒绝', hint: '不写入' },
                    ]).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setMode(option.value)}
                        className={cn(
                          'rounded-md border px-3 py-2 text-left text-xs transition-colors',
                          mode === option.value ? 'border-primary bg-primary-soft' : 'border-border hover:bg-accent',
                        )}
                      >
                        <div className="font-medium">{option.title}</div>
                        <div className="mt-0.5 text-2xs text-muted-foreground">{option.hint}</div>
                      </button>
                    ))}
                  </div>
                </Card>
              ) : null}

              <Card className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                  <span className="text-xs font-medium">损失清单</span>
                  <Badge variant="secondary">{losses.length} 类</Badge>
                  {warned > 0 ? <Badge variant="warning">{warned} 项 warning</Badge> : <Badge variant="success">无 warning</Badge>}
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted text-2xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">severity</th>
                      <th className="px-4 py-2 font-medium">loss</th>
                      <th className="px-4 py-2 font-medium">count</th>
                      <th className="px-4 py-2 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {losses.length === 0 ? (
                      <tr>
                        <td className="px-4 py-4 text-muted-foreground" colSpan={4}>
                          <div className="flex items-center gap-1.5">
                            <Info className="h-3.5 w-3.5" />
                            没有损失（或该 adapter 未报告）
                          </div>
                        </td>
                      </tr>
                    ) : (
                      losses.map((loss) => (
                        <tr key={loss.code + loss.message} className="border-t border-border">
                          <td className="px-4 py-2">
                            <Badge variant={loss.severity === 'warning' ? 'warning' : 'outline'}>{loss.severity}</Badge>
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px]">{loss.code}</td>
                          <td className="px-4 py-2 text-muted-foreground">{loss.count}</td>
                          <td className="px-4 py-2 text-muted-foreground">{loss.message}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </Card>

              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={run.isPending} onClick={() => run.mutate()}>
                  {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  确认写入 {agentLabel(preview.data.target)}
                </Button>
                <span className="text-2xs text-muted-foreground">写入前会重新计算一次；目标端已有新增时按上面的策略处理</span>
              </div>

              {run.error ? (
                <Card className="border-destructive bg-destructive-soft p-3 text-xs text-destructive">{String(run.error)}</Card>
              ) : null}
              {run.data?.refused ? (
                <Card className="border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
                  {run.data.refused.reason}
                </Card>
              ) : null}
              {run.data && !run.data.refused ? (
                <Card className="p-4">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    已写入 {agentLabel(run.data.target)} · <span className="font-mono">{run.data.sessionId}</span>
                  </div>
                  <ul className="mt-2 space-y-0.5 font-mono text-3xs text-muted-foreground">
                    {run.data.paths.map((path) => (
                      <li key={path} className="truncate">
                        {path}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </div>
          ) : sessionsQuery.isLoading ? (
            <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner /> 加载会话列表中…
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}