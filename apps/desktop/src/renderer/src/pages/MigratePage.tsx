import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, ListChecks, Loader2 } from 'lucide-react';

import { api, sessionRefOf } from '../api.ts';
import type { AgentId, DivergedMode, SessionRow } from '../api.ts';
import { Badge, Button, Card, CheckboxRow, Select, Spinner, Topbar, cn } from '../ui.tsx';
import type { OfficialTarget, OfficialVerifyRow } from '../api.ts';
import { agentLabel } from '../agents.tsx';

const DECISION_TONE = {
  fresh: 'default',
  refresh: 'default',
  'up-to-date': 'success',
  diverged: 'warning',
} as const;

export function MigratePage(props: { initial: SessionRow | null; enabledAgents: string[] }) {
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const rowKey = (row: SessionRow): string => row.agent + '|' + row.sessionId + '|' + row.nativePath;
  const [sourceKey, setSourceKey] = useState<string | null>(props.initial ? rowKey(props.initial) : null);
  const [target, setTarget] = useState<AgentId | null>(null);
  const [register, setRegister] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [dshMode, setDshMode] = useState<'full' | 'slim' | 'compact'>('compact');
  const [mode, setMode] = useState<DivergedMode>('auto');
  const [officialResults, setOfficialResults] = useState<Partial<Record<OfficialTarget, OfficialVerifyRow>>>({});
  const officialQuery = useQuery({ queryKey: ['official'], queryFn: api.officialList });

  useEffect(() => {
    if (props.initial && sourceKey === null) setSourceKey(rowKey(props.initial));
  }, [props.initial, sourceKey]);

  const sessions = (sessionsQuery.data?.sessions ?? []).filter(
    (row) => props.enabledAgents.length === 0 || props.enabledAgents.includes(row.agent),
  );
  const source = useMemo(() => sessions.find((row) => rowKey(row) === sourceKey) ?? null, [sessions, sourceKey]);
  const writableAll = capsQuery.data?.writable ?? [];
  const writable = writableAll.filter(
    (agent) => props.enabledAgents.length === 0 || props.enabledAgents.includes(agent),
  );
  const targets = writable.length > 0 ? writable : writableAll;

  useEffect(() => {
    if (target === null && targets.length > 0) setTarget(targets[0] ?? null);
  }, [target, targets]);

  const preview = useMutation({
    mutationFn: () =>
      api.previewMigration(source!.agent, sessionRefOf(source!), target!, {
        register,
        includeChildren,
        ...(target === 'dsh' ? { slim: dshMode === 'slim', compact: dshMode === 'compact' } : {}),
      }),
  });
  const run = useMutation({
    mutationFn: () =>
      api.runMigration({
        agent: source!.agent,
        ref: sessionRefOf(source!),
        target: target!,
        register,
        includeChildren,
        onDiverged: mode,
        ...(target === 'dsh' ? { slim: dshMode === 'slim', compact: dshMode === 'compact' } : {}),
      }),
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
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">官方导入（推荐）</span>
              <span className="text-2xs text-fg-3">目标 app 自带的迁移功能，能一并带记忆/MCP，比直接写更稳</span>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {(officialQuery.data ?? []).map((row) => {
                const sourceOk = source !== null && row.sources.includes(source.agent);
                const verify = officialResults[row.target];
                return (
                  <div key={row.target} className="flex flex-col gap-2 rounded-panel border border-border p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium">{row.appName}</span>
                      {row.supported ? <Badge variant="success">官方支持</Badge> : <Badge variant="outline">无官方导入</Badge>}
                      <span className="ml-auto text-3xs text-fg-3">{row.mechanism}</span>
                    </div>
                    <div className="truncate font-mono text-3xs text-fg-3" title={row.store}>{row.store}</div>
                    {row.supported ? (
                      <ol className="list-inside list-decimal space-y-0.5 text-2xs text-fg-2">
                        {row.steps.slice(0, 3).map((step) => (<li key={step}>{step}</li>))}
                        {row.steps.length > 3 ? (
                          <li className="list-none text-3xs text-fg-3">…完整步骤见命令行 import 输出</li>
                        ) : null}
                      </ol>
                    ) : (
                      <div className="text-2xs text-fg-2">{row.notes.join('；')}</div>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!row.supported}
                        onClick={() => void api.officialOpen(row.target).catch(() => undefined)}
                      >
                        打开 {row.appName}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!row.supported || !sourceOk}
                        title={sourceOk ? '读取目标 app 自己的存储，确认导入是否落库' : '先在下方选择匹配来源的会话（' + row.sources.join(' / ') + '）'}
                        onClick={() => {
                          void api.officialVerify(row.target, { cwd: source?.cwd, title: source?.title }).then((result) => {
                            setOfficialResults((current) => ({ ...current, [row.target]: result }));
                          }).catch(() => undefined);
                        }}
                      >
                        验证导入
                      </Button>
                    </div>
                    {verify ? (
                      <div className={cn('rounded-control border px-2 py-1.5 text-2xs', verify.ok ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400')}>
                        {verify.ok ? '已找到导入结果' : '未找到（可能还没在 app 里点导入）'} · 匹配 {verify.matches.length}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
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
                  {targets.map((agent) => (
                    <option key={agent} value={agent}>
                      {agentLabel(agent)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            {target === 'dsh' ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-control border border-border bg-subtle px-3 py-2 text-caption text-fg-2">
                <span className="text-fg-1">导入模式</span>
                {([
                  { value: 'compact' as const, label: '压缩（推荐）', hint: '保留完整日志 + compaction，上下文=摘要+最近 step' },
                  { value: 'full' as const, label: '全量', hint: '超大文件可能超出模型上下文' },
                  { value: 'slim' as const, label: '精简', hint: '截断工具内容，日志也损' },
                ]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setDshMode(option.value)}
                    title={option.hint}
                    className={cn(
                      'h-6 rounded px-2 text-caption transition-colors',
                      dshMode === option.value ? 'bg-card text-fg-1 shadow-sm' : 'text-fg-2 hover:text-fg-1',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}

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
                          mode === option.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
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
                <Card className="border-destructive bg-destructive/10 p-3 text-xs text-destructive">{String(run.error)}</Card>
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