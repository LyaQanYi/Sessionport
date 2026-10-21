import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, ListChecks, Loader2 } from 'lucide-react';

import { api, sessionRefOf } from '../api.ts';
import type { AgentId, DivergedMode, SessionRow } from '../api.ts';
import { Badge, Button, Card, CheckboxRow, Select, Spinner, Topbar, cn } from '../ui.tsx';
import type { OfficialTarget, OfficialVerifyRow } from '../api.ts';
import { agentLabel } from '../agents.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';

const DECISION_TONE = {
  fresh: 'default',
  refresh: 'default',
  'up-to-date': 'success',
  diverged: 'warning',
} as const;

/** core 的官方导入步骤/说明在 renderer 侧按目标重写，保证两种语言都完整。 */
const OFFICIAL_TEXT: Record<OfficialTarget, { steps: MessageKey[]; notes: MessageKey[] }> = {
  zcode: {
    steps: ['official.zcode.step1', 'official.zcode.step2', 'official.zcode.step3', 'official.zcode.step4'],
    notes: ['official.zcode.note1', 'official.zcode.note2'],
  },
  qoder: {
    steps: ['official.qoder.step1', 'official.qoder.step2', 'official.qoder.step3', 'official.qoder.step4'],
    notes: ['official.qoder.note1', 'official.qoder.note2'],
  },
  cursor: {
    steps: [],
    notes: ['official.cursor.note1', 'official.cursor.note2', 'official.cursor.note3'],
  },
};

export function MigratePage(props: { initial: SessionRow | null; enabledAgents: string[] }) {
  const { locale, t, tError, tLoss, tDecision, tSyncDescription, tMechanism } = useT();
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const rowKey = (row: SessionRow): string => row.agent + '|' + row.sessionId + '|' + row.nativePath;
  const [sourceKey, setSourceKey] = useState<string | null>(props.initial ? rowKey(props.initial) : null);
  const [target, setTarget] = useState<AgentId | null>(null);
  const [register, setRegister] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [dshMode, setDshMode] = useState<'full' | 'slim' | 'compact'>('compact');
  const [summaryEngine, setSummaryEngine] = useState<'off' | 'claude' | 'codex'>('off');
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
    if (target !== null) return;
    const preset = window.sessionport?.initialTarget;
    if (preset !== null && preset !== undefined && targets.includes(preset as AgentId)) {
      setTarget(preset as AgentId);
      return;
    }
    if (targets.length > 0) setTarget(targets[0] ?? null);
  }, [target, targets]);

  const preview = useMutation({
    mutationFn: () =>
      api.previewMigration(source!.agent, sessionRefOf(source!), target!, {
        register,
        includeChildren,
        ...(target === 'dsh'
          ? {
              slim: dshMode === 'slim',
              compact: dshMode === 'compact',
              ...(summaryEngine === 'off'
                ? {}
                : { summaryCommand: summaryEngine === 'claude' ? 'claude -p' : 'codex exec -' }),
            }
          : {}),
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
        ...(target === 'dsh'
          ? {
              slim: dshMode === 'slim',
              compact: dshMode === 'compact',
              ...(summaryEngine === 'off'
                ? {}
                : { summaryCommand: summaryEngine === 'claude' ? 'claude -p' : 'codex exec -' }),
            }
          : {}),
      }),
    onSuccess: (result) => {
      if (!result.refused) preview.mutate();
    },
  });

  const losses = preview.data?.losses ?? [];
  const warned = losses.filter((loss) => loss.severity === 'warning').length;
  const refused = run.data?.refused;
  const refusedText = refused
    ? locale === 'zh-CN' || refused.code !== 'migrate.diverged'
      ? refused.reason
      : t('migrate.refused.diverged')
    : '';

  return (
    <div className="flex h-full flex-col">
      <Topbar title={t('migrate.title')} subtitle={t('migrate.subtitle')} />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t('migrate.official.title')}</span>
              <span className="text-2xs text-fg-3">{t('migrate.official.subtitle')}</span>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {(officialQuery.data ?? []).map((row) => {
                const sourceOk = source !== null && row.sources.includes(source.agent);
                const verify = officialResults[row.target];
                const copy = OFFICIAL_TEXT[row.target];
                // 以 core 的步骤/说明数量为准：core 增删步骤时回退到原文，避免漏展示
                const steps = row.steps.length === copy.steps.length ? copy.steps.map((key) => t(key)) : row.steps;
                const notes = row.notes.length === copy.notes.length ? copy.notes.map((key) => t(key)) : row.notes;
                return (
                  <div key={row.target} className="flex flex-col gap-2 rounded-panel border border-border p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium">{row.appName}</span>
                      {row.supported ? <Badge variant="success">{t('migrate.official.supported')}</Badge> : <Badge variant="outline">{t('migrate.official.unsupported')}</Badge>}
                      <span className="ml-auto text-3xs text-fg-3">{tMechanism(row.mechanism)}</span>
                    </div>
                    <div className="truncate font-mono text-3xs text-fg-3" title={row.store}>{row.store}</div>
                    {row.supported ? (
                      <ol className="list-inside list-decimal space-y-0.5 text-2xs text-fg-2">
                        {steps.slice(0, 3).map((step) => (<li key={step}>{step}</li>))}
                        {steps.length > 3 ? (
                          <li className="list-none text-3xs text-fg-3">{t('migrate.official.moreSteps')}</li>
                        ) : null}
                      </ol>
                    ) : (
                      <div className="text-2xs text-fg-2">{notes.join(t('common.listSeparator'))}</div>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!row.supported}
                        onClick={() => void api.officialOpen(row.target).catch(() => undefined)}
                      >
                        {t('migrate.official.open', { app: row.appName })}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!row.supported || !sourceOk}
                        title={sourceOk ? t('migrate.official.verifyHint') : t('migrate.official.sourceHint', { sources: row.sources.join(' / ') })}
                        onClick={() => {
                          void api.officialVerify(row.target, { cwd: source?.cwd, title: source?.title }).then((result) => {
                            setOfficialResults((current) => ({ ...current, [row.target]: result }));
                          }).catch(() => undefined);
                        }}
                      >
                        {t('migrate.official.verify')}
                      </Button>
                    </div>
                    {verify ? (
                      <div className={cn('rounded-control border px-2 py-1.5 text-2xs', verify.ok ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400')}>
                        {verify.ok ? t('migrate.official.found') : t('migrate.official.notFound')} · {t('migrate.official.matches', { count: verify.matches.length })}
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
                <div className="text-2xs font-medium text-muted-foreground">{t('migrate.source')}</div>
                <Select value={sourceKey ?? ''} onChange={(event) => setSourceKey(event.target.value || null)}>
                  <option value="">{t('common.select')}</option>
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
                <div className="text-2xs font-medium text-muted-foreground">{t('migrate.target')}</div>
                <Select value={target ?? ''} onChange={(event) => setTarget((event.target.value || null) as AgentId | null)}>
                  <option value="">{t('common.select')}</option>
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
                <span className="text-fg-1">{t('migrate.importMode')}</span>
                {([
                  { value: 'compact' as const, label: t('migrate.importMode.compact'), hint: t('migrate.importMode.compactHint') },
                  { value: 'full' as const, label: t('migrate.importMode.full'), hint: t('migrate.importMode.fullHint') },
                  { value: 'slim' as const, label: t('migrate.importMode.slim'), hint: t('migrate.importMode.slimHint') },
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
                <span className="ml-3 text-fg-1">{t('migrate.summary')}</span>
                {([
                  { value: 'off' as const, label: t('migrate.summary.off'), hint: t('migrate.summary.offHint') },
                  { value: 'claude' as const, label: t('migrate.summary.claude'), hint: t('migrate.summary.claudeHint') },
                  { value: 'codex' as const, label: t('migrate.summary.codex'), hint: t('migrate.summary.codexHint') },
                ]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSummaryEngine(option.value)}
                    title={option.hint}
                    className={cn(
                      'h-6 rounded px-2 text-caption transition-colors',
                      summaryEngine === option.value ? 'bg-card text-fg-1 shadow-sm' : 'text-fg-2 hover:text-fg-1',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              <CheckboxRow checked={register} onChange={setRegister}>
                {t('migrate.register')}
              </CheckboxRow>
              <CheckboxRow checked={includeChildren} onChange={setIncludeChildren}>
                {t('migrate.includeChildren')}
              </CheckboxRow>
              <Button
                className="ml-auto"
                size="sm"
                disabled={!source || !target || preview.isPending}
                onClick={() => preview.mutate()}
              >
                {preview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                {t('migrate.preview')}
              </Button>
            </div>
            {preview.error ? (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {tError(preview.error)}
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
                    {tDecision(preview.data.sync.decision)}
                  </Badge>
                </div>
                <div className="mt-1 text-2xs text-muted-foreground" title={locale === 'en-US' ? preview.data.sync.description : undefined}>
                  {locale === 'zh-CN'
                    ? preview.data.sync.description
                    : tSyncDescription(preview.data.sync.decision, preview.data.sync.targetExtra)}
                </div>
                <div className="mt-2 grid gap-1 font-mono text-3xs text-muted-foreground">
                  <div>{t('migrate.sync.sourceEvents', { count: preview.data.sync.sourceEvents })}</div>
                  <div>{t('migrate.sync.targetUnits', { count: preview.data.sync.targetUnits })}</div>
                  {preview.data.sync.targetPath ? <div className="truncate">{t('migrate.sync.targetPath', { path: preview.data.sync.targetPath })}</div> : null}
                  <div className="truncate">{t('migrate.sync.registry', { path: preview.data.sync.stateFile })}</div>
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
                    {t('migrate.diverged.count', { count: preview.data.sync.targetExtra ?? 0 })}
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {([
                      { value: 'fork' as DivergedMode, title: t('migrate.diverged.fork'), hint: t('migrate.diverged.forkHint') },
                      { value: 'force' as DivergedMode, title: t('migrate.diverged.force'), hint: t('migrate.diverged.forceHint') },
                      { value: 'auto' as DivergedMode, title: t('migrate.diverged.auto'), hint: t('migrate.diverged.autoHint') },
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
                  <span className="text-xs font-medium">{t('migrate.losses.title')}</span>
                  <Badge variant="secondary">{t('migrate.losses.types', { count: losses.length })}</Badge>
                  {warned > 0 ? <Badge variant="warning">{t('migrate.losses.warnings', { count: warned })}</Badge> : <Badge variant="success">{t('migrate.losses.noWarnings')}</Badge>}
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted text-2xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('migrate.losses.severity')}</th>
                      <th className="px-4 py-2 font-medium">{t('migrate.losses.code')}</th>
                      <th className="px-4 py-2 font-medium">{t('migrate.losses.count')}</th>
                      <th className="px-4 py-2 font-medium">{t('migrate.losses.description')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {losses.length === 0 ? (
                      <tr>
                        <td className="px-4 py-4 text-muted-foreground" colSpan={4}>
                          <div className="flex items-center gap-1.5">
                            <Info className="h-3.5 w-3.5" />
                            {t('migrate.losses.empty')}
                          </div>
                        </td>
                      </tr>
                    ) : (
                      losses.map((loss) => {
                        const message = tLoss(loss);
                        return (
                          <tr key={loss.code + loss.message} className="border-t border-border">
                            <td className="px-4 py-2">
                              <Badge variant={loss.severity === 'warning' ? 'warning' : 'outline'}>
                                {loss.severity === 'warning' ? t('migrate.severity.warning') : t('migrate.severity.info')}
                              </Badge>
                            </td>
                            <td className="px-4 py-2 font-mono text-[11px]">{loss.code}</td>
                            <td className="px-4 py-2 text-muted-foreground">{loss.count}</td>
                            <td className="px-4 py-2 text-muted-foreground" title={message === loss.message ? undefined : loss.message}>{message}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </Card>

              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={run.isPending} onClick={() => run.mutate()}>
                  {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('migrate.confirmWrite', { target: agentLabel(preview.data.target) })}
                </Button>
                <span className="text-2xs text-muted-foreground">{t('migrate.writeHint')}</span>
              </div>

              {run.error ? (
                <Card className="border-destructive bg-destructive/10 p-3 text-xs text-destructive">{tError(run.error)}</Card>
              ) : null}
              {refused ? (
                <Card className="border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
                  <span title={refused.reason}>{refusedText}</span>
                </Card>
              ) : null}
              {run.data && !run.data.refused ? (
                <Card className="p-4">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('migrate.written', { target: agentLabel(run.data.target) })} · <span className="font-mono">{run.data.sessionId}</span>
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
              <Spinner /> {t('migrate.loadingSessions')}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
