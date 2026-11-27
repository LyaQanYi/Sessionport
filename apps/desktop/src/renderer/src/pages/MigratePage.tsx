import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  GitMerge,
  History,
  Info,
  ListChecks,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';

import { api, sessionRefOf } from '../api.ts';
import type {
  AgentId,
  DivergedMode,
  HistoryRecordSummary,
  LossEntry,
  OfficialSupportRow,
  OfficialTarget,
  OfficialVerifyRow,
  SessionRow,
  UndoResult,
} from '../api.ts';
import { AgentGlyph, agentLabel } from '../agents.tsx';
import { SourceSessionPicker, TargetAgentSelector } from '../components/MigrateSelectors.tsx';
import { filterRootSessions } from '../sessionTree.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import type { MessageKey, MessageParams } from '../i18n/messages.ts';
import { Badge, Button, Card, CheckboxRow, Spinner, Topbar, cn } from '../ui.tsx';

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
  antigravity: {
    steps: [],
    notes: [],
  },
};

const HISTORY_ACTION_KEY: Record<HistoryRecordSummary['action'], MessageKey> = {
  push: 'migrate.history.action.push',
  sync: 'migrate.history.action.sync',
  'merge-back': 'migrate.history.action.merge-back',
  'desktop-migrate': 'migrate.history.action.desktop-migrate',
};

type CapBadgeVariant = 'success' | 'warning' | 'outline' | 'secondary';

interface FormattedCap {
  key: string;
  label: string;
  variant: CapBadgeVariant;
}

const CAP_ORDER = [
  'nativeHistory',
  'contextHandoff',
  'createConversationApi',
  'reasoning',
  'toolResults',
  'subagents',
  'branching',
  'modelPinned',
];

function formatCapabilities(
  caps: Record<string, unknown>,
  t: (key: MessageKey, params?: MessageParams) => string,
): FormattedCap[] {
  const entries = Object.entries(caps).filter(([key]) => key !== 'agent');
  entries.sort(([a], [b]) => {
    const idxA = CAP_ORDER.indexOf(a);
    const idxB = CAP_ORDER.indexOf(b);
    if (idxA === -1 && idxB === -1) return a.localeCompare(b);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });

  return entries.map(([key, value]) => {
    if (key === 'reasoning') {
      if (value === 'plain') return { key, label: t('migrate.caps.reasoning.plain'), variant: 'success' };
      if (value === 'opaque') return { key, label: t('migrate.caps.reasoning.opaque'), variant: 'outline' };
      return { key, label: t('migrate.caps.reasoning.none'), variant: 'warning' };
    }
    if (key === 'toolResults') {
      if (value === 'inline') return { key, label: t('migrate.caps.toolResults.inline'), variant: 'success' };
      if (value === 'separate') return { key, label: t('migrate.caps.toolResults.separate'), variant: 'success' };
      return { key, label: t('migrate.caps.toolResults.none'), variant: 'warning' };
    }
    if (key === 'branching') {
      return {
        key,
        label: t(value === true ? 'migrate.caps.branching.true' : 'migrate.caps.branching.false'),
        variant: value === true ? 'success' : 'outline',
      };
    }
    if (key === 'subagents') {
      return {
        key,
        label: t(value === true ? 'migrate.caps.subagents.true' : 'migrate.caps.subagents.false'),
        variant: value === true ? 'success' : 'outline',
      };
    }
    if (key === 'modelPinned') {
      return {
        key,
        label: t(value === true ? 'migrate.caps.modelPinned.true' : 'migrate.caps.modelPinned.false'),
        variant: value === true ? 'warning' : 'secondary',
      };
    }
    if (key === 'nativeHistory') {
      return {
        key,
        label: t(value === true ? 'migrate.caps.nativeHistory.true' : 'migrate.caps.nativeHistory.false'),
        variant: value === true ? 'success' : 'warning',
      };
    }
    if (key === 'contextHandoff') {
      return {
        key,
        label: t(value === true ? 'migrate.caps.contextHandoff.true' : 'migrate.caps.contextHandoff.false'),
        variant: value === true ? 'success' : 'outline',
      };
    }
    if (key === 'createConversationApi') {
      return {
        key,
        label: t(value === true ? 'migrate.caps.createConversationApi.true' : 'migrate.caps.createConversationApi.false'),
        variant: value === true ? 'success' : 'outline',
      };
    }
    if (typeof value === 'boolean') {
      return {
        key,
        label: t(value ? 'migrate.caps.unknownTrue' : 'migrate.caps.unknownFalse', { key }),
        variant: value ? 'secondary' : 'outline',
      };
    }
    return { key, label: `${key}: ${String(value)}`, variant: 'outline' };
  });
}

function rowKey(row: SessionRow): string {
  return row.agent + '|' + row.sessionId + '|' + row.nativePath;
}

interface SelectionCtx {
  sourceKey: string | null;
  target: AgentId | null;
  version: number;
}

function UndoActionRow(props: {
  backupId?: string;
  undoData?: UndoResult;
  undoPending: boolean;
  undoError: unknown;
  onUndo: (backupId: string) => void;
}) {
  const { t, tError } = useT();
  if (!props.backupId) return null;
  const undoneThis = props.undoData?.opId === props.backupId ? props.undoData : undefined;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {!undoneThis ? (
        <Button
          size="sm"
          variant="outline"
          disabled={props.undoPending}
          onClick={() => props.onUndo(props.backupId!)}
        >
          {props.undoPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          {props.undoPending ? t('migrate.undoing') : t('migrate.undo')}
        </Button>
      ) : (
        <span className="text-caption text-fg-2">
          {t('migrate.undone', {
            id: undoneThis.opId,
            restored: undoneThis.restoredFiles.length,
            deleted: undoneThis.deletedFiles.length,
          })}
        </span>
      )}
      {props.undoError ? <span className="text-caption text-destructive">{tError(props.undoError)}</span> : null}
    </div>
  );
}

function LossesCard(props: { losses: LossEntry[] }) {
  const { t, tLoss } = useT();
  const warningLosses = props.losses.filter((loss) => loss.severity === 'warning');
  const infoLosses = props.losses.filter((loss) => loss.severity !== 'warning');

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-section text-fg-1">{t('migrate.losses.title')}</span>
        {props.losses.length > 0 ? (
          <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
            {t('migrate.losses.types', { count: props.losses.length })}
          </Badge>
        ) : null}
        {warningLosses.length > 0 ? (
          <Badge variant="warning" className="shrink-0 whitespace-nowrap">
            {t('migrate.losses.warnings', { count: warningLosses.length })}
          </Badge>
        ) : (
          <Badge variant="success" className="shrink-0 whitespace-nowrap">
            {t('migrate.losses.noWarnings')}
          </Badge>
        )}
        {infoLosses.length > 0 ? (
          <Badge variant="outline" className="shrink-0 whitespace-nowrap">
            {t('migrate.losses.infos', { count: infoLosses.length })}
          </Badge>
        ) : null}
      </div>

      {props.losses.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-4 text-caption text-fg-2">
          <CheckCircle2 className="h-4 w-4 text-success" />
          <span>{t('migrate.losses.empty')}</span>
        </div>
      ) : (
        <div>
          {warningLosses.length > 0 ? (
            <div>
              <div className="flex items-center gap-1.5 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-caption font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{t('migrate.losses.groupWarning', { count: warningLosses.length })}</span>
              </div>
              <div className="divide-y divide-border">
                {warningLosses.map((loss) => {
                  const message = tLoss(loss);
                  return (
                    <div key={loss.code + loss.message} className="flex items-start gap-3 px-4 py-2.5">
                      <Badge variant="warning" className="mt-0.5 shrink-0 tabular-nums">
                        ×{loss.count}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-body text-fg-1" title={message === loss.message ? undefined : loss.message}>
                          {message}
                        </div>
                        <div className="mt-0.5 font-mono text-3xs text-fg-3">{loss.code}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {infoLosses.length > 0 ? (
            <div className={cn(warningLosses.length > 0 && 'border-t border-border')}>
              <div className="flex items-center gap-1.5 border-b border-border bg-subtle px-4 py-1.5 text-caption font-medium text-fg-2">
                <Info className="h-3.5 w-3.5 shrink-0 text-fg-3" />
                <span>{t('migrate.losses.groupInfo', { count: infoLosses.length })}</span>
              </div>
              <div className="divide-y divide-border">
                {infoLosses.map((loss) => {
                  const message = tLoss(loss);
                  return (
                    <div key={loss.code + loss.message} className="flex items-start gap-3 px-4 py-2.5">
                      <Badge variant="outline" className="mt-0.5 shrink-0 tabular-nums">
                        ×{loss.count}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-body text-fg-2" title={message === loss.message ? undefined : loss.message}>
                          {message}
                        </div>
                        <div className="mt-0.5 font-mono text-3xs text-fg-3">{loss.code}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function OfficialGuidesCard(props: {
  rows: OfficialSupportRow[];
  source: SessionRow | null;
  open: boolean;
  onToggle: () => void;
  results: Partial<Record<OfficialTarget, OfficialVerifyRow>>;
  onVerifyResult: (target: OfficialTarget, result: OfficialVerifyRow) => void;
}) {
  const { t, tMechanism } = useT();
  const sourceMatchesOfficial =
    props.source !== null && props.rows.some((row) => row.supported && row.sources.includes(props.source!.agent));

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-subtle/70"
      >
        <BookOpen className="h-4 w-4 shrink-0 text-fg-2" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-section text-fg-1">{t('migrate.official.title')}</span>
            {sourceMatchesOfficial ? (
              <Badge variant="success" className="shrink-0 whitespace-nowrap">
                {t('migrate.official.sourceMatchHint')}
              </Badge>
            ) : null}
          </div>
          <div className="truncate text-caption text-fg-3">{t('migrate.official.subtitle')}</div>
        </div>
        <span className="shrink-0 text-caption text-fg-2">
          {props.open ? t('migrate.official.toggleHide') : t('migrate.official.toggleShow')}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('h-4 w-4 shrink-0 text-fg-3 transition-transform', props.open && 'rotate-180')}
        />
      </button>

      {props.open ? (
        <div className="grid gap-3 border-t border-border p-4 lg:grid-cols-3">
          {props.rows.map((row) => {
            const sourceOk = props.source !== null && row.sources.includes(props.source.agent);
            const verify = props.results[row.target];
            const copy = OFFICIAL_TEXT[row.target];
            // 以 core 的步骤/说明数量为准：core 增删步骤时回退到原文，避免漏展示
            const steps = row.steps.length === copy.steps.length ? copy.steps.map((key) => t(key)) : row.steps;
            const notes = row.notes.length === copy.notes.length ? copy.notes.map((key) => t(key)) : row.notes;
            return (
              <div key={row.target} className="flex flex-col gap-2 rounded-panel border border-border bg-subtle/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-body font-medium text-fg-1">{row.appName}</span>
                  {row.supported ? (
                    <Badge variant="success" className="shrink-0 whitespace-nowrap">
                      {t('migrate.official.supported')}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 whitespace-nowrap">
                      {t('migrate.official.unsupported')}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 text-3xs text-fg-3">
                  <span className="min-w-0 truncate font-mono" title={row.store}>
                    {row.store}
                  </span>
                  <span className="shrink-0 whitespace-nowrap">{tMechanism(row.mechanism)}</span>
                </div>
                {row.supported ? (
                  <ol className="list-inside list-decimal space-y-1 text-caption leading-relaxed text-fg-2">
                    {steps.slice(0, 3).map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                    {steps.length > 3 ? (
                      <li className="list-none text-3xs text-fg-3">{t('migrate.official.moreSteps')}</li>
                    ) : null}
                  </ol>
                ) : (
                  <ul className="list-inside list-disc space-y-1 text-caption leading-relaxed text-fg-2">
                    {notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
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
                    title={
                      sourceOk
                        ? t('migrate.official.verifyHint')
                        : t('migrate.official.sourceHint', { sources: row.sources.join(' / ') })
                    }
                    onClick={() => {
                      void api
                        .officialVerify(row.target, { cwd: props.source?.cwd, title: props.source?.title })
                        .then((result) => props.onVerifyResult(row.target, result))
                        .catch(() => undefined);
                    }}
                  >
                    {t('migrate.official.verify')}
                  </Button>
                </div>
                {verify ? (
                  <div
                    className={cn(
                      'rounded-control border px-2 py-1.5 text-caption',
                      verify.ok
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-warning/30 bg-warning/10 text-warning',
                    )}
                  >
                    {verify.ok ? t('migrate.official.found') : t('migrate.official.notFound')} ·{' '}
                    {t('migrate.official.matches', { count: verify.matches.length })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}

function BackupHistoryCard(props: {
  records: HistoryRecordSummary[];
  loading: boolean;
  fetching: boolean;
  error: unknown;
  undoData?: UndoResult;
  undoPending: boolean;
  undoVariable?: string;
  undoError: unknown;
  onRefresh: () => void;
  onUndo: (id: string) => void;
}) {
  const { t, tError, formatTime } = useT();

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <History className="h-4 w-4 shrink-0 text-fg-2" />
        <span className="text-section text-fg-1">{t('migrate.history.title')}</span>
        <span className="text-caption text-fg-3">{t('migrate.history.subtitle')}</span>
        <Button className="ml-auto" size="sm" variant="outline" disabled={props.fetching} onClick={props.onRefresh}>
          <RefreshCw className={cn('h-3.5 w-3.5', props.fetching && 'animate-spin')} />
          {t('migrate.history.refresh')}
        </Button>
      </div>

      {props.error || props.undoError ? (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-caption text-destructive">
          {tError(props.error ?? props.undoError)}
        </div>
      ) : null}
      {props.undoData ? (
        <div className="border-b border-border bg-success/10 px-4 py-2 text-caption text-success">
          {t('migrate.undone', {
            id: props.undoData.opId,
            restored: props.undoData.restoredFiles.length,
            deleted: props.undoData.deletedFiles.length,
          })}
        </div>
      ) : null}

      {props.loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-caption text-fg-2">
          <Spinner /> {t('migrate.loadingSessions')}
        </div>
      ) : props.records.length === 0 ? (
        <div className="px-4 py-4 text-caption text-fg-3">{t('migrate.history.empty')}</div>
      ) : (
        <div className="divide-y divide-border">
          {props.records.map((record) => {
            const isUndoing = props.undoPending && props.undoVariable === record.id;
            const isUndone = Boolean(record.undoneAt);
            return (
              <div
                key={record.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 px-4 py-2.5 transition-colors',
                  isUndone ? 'bg-subtle/40 opacity-75' : 'hover:bg-subtle/40',
                )}
              >
                <AgentGlyph agent={record.target} size="sm" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-body font-medium text-fg-1">{agentLabel(record.target)}</span>
                    <Badge variant="outline" className="shrink-0 whitespace-nowrap">
                      {t(HISTORY_ACTION_KEY[record.action])}
                    </Badge>
                    <span className="truncate font-mono text-3xs text-fg-3">{record.id}</span>
                    {record.caveats.length > 0 ? (
                      <span
                        title={`${t('migrate.history.caveats')}: ${record.caveats.join('; ')}`}
                        className="inline-flex items-center text-fg-3"
                      >
                        <Info className="h-3 w-3" />
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5 text-caption text-fg-2">
                    <span className="truncate font-mono" title={record.sourceKey}>
                      {record.sourceKey}
                    </span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-fg-3" />
                    <span className="truncate font-mono" title={record.targetId}>
                      {record.targetId}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-3xs text-fg-3">
                    <span className="tabular-nums">{formatTime(record.createdAt)}</span>
                    <span>·</span>
                    <span>
                      {record.cursor
                        ? t('migrate.history.cursorDb')
                        : t('migrate.history.files', { count: record.files.length })}
                    </span>
                  </div>
                </div>
                <div className="shrink-0">
                  {record.undoneAt ? (
                    <span title={formatTime(record.undoneAt)}>
                      <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
                        {t('migrate.history.undoneBadge')}
                      </Badge>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.undoPending}
                      onClick={() => props.onUndo(record.id)}
                    >
                      {isUndoing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                      {isUndoing ? t('migrate.undoing') : t('migrate.history.undo')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function MigratePage(props: { initial: SessionRow | null; enabledAgents: string[] }) {
  const { locale, t, tError, tDecision, tSyncDescription } = useT();
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
  const backupsQuery = useQuery({ queryKey: ['backups'], queryFn: () => api.listBackups({ limit: 15 }) });
  const officialQuery = useQuery({ queryKey: ['official'], queryFn: api.officialList });

  const [sourceKey, setSourceKey] = useState<string | null>(props.initial ? rowKey(props.initial) : null);
  const [target, setTarget] = useState<AgentId | null>(null);
  const [register, setRegister] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [normalizeTools, setNormalizeTools] = useState(true);
  const [dshMode, setDshMode] = useState<'full' | 'slim' | 'compact'>('compact');
  const [summaryEngine, setSummaryEngine] = useState<'off' | 'claude' | 'codex'>('off');
  const [agHandoffOnly, setAgHandoffOnly] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [mode, setMode] = useState<DivergedMode>('auto');
  const [guidesOpen, setGuidesOpen] = useState(false);
  const [officialResults, setOfficialResults] = useState<Partial<Record<OfficialTarget, OfficialVerifyRow>>>({});

  const copyTimerRef = useRef<number | null>(null);
  const initialKey = props.initial ? rowKey(props.initial) : null;
  const prevInitialRef = useRef<string | null>(initialKey);

  useEffect(() => {
    if (initialKey && initialKey !== prevInitialRef.current) {
      prevInitialRef.current = initialKey;
      setSourceKey(initialKey);
    }
  }, [initialKey]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const sessions = useMemo(() => {
    const enabled = (sessionsQuery.data?.sessions ?? []).filter(
      (row) => props.enabledAgents.length === 0 || props.enabledAgents.includes(row.agent),
    );
    const base = filterRootSessions(enabled);
    if (props.initial && !base.some((row) => rowKey(row) === rowKey(props.initial!))) {
      return [props.initial, ...base];
    }
    return base;
  }, [sessionsQuery.data?.sessions, props.enabledAgents, props.initial]);
  const source = useMemo(() => sessions.find((row) => rowKey(row) === sourceKey) ?? null, [sessions, sourceKey]);

  const writableAll = useMemo(() => capsQuery.data?.writable ?? [], [capsQuery.data?.writable]);
  const targets = useMemo(() => {
    const filtered = writableAll.filter(
      (agent) => props.enabledAgents.length === 0 || props.enabledAgents.includes(agent),
    );
    return filtered.length > 0 ? filtered : writableAll;
  }, [writableAll, props.enabledAgents]);

  useEffect(() => {
    if (target !== null && targets.includes(target)) return;
    const preset = window.sessionport?.initialTarget;
    if (preset !== null && preset !== undefined && targets.includes(preset as AgentId)) {
      setTarget(preset as AgentId);
      return;
    }
    if (targets.length > 0) {
      setTarget(targets[0] ?? null);
    } else if (target !== null) {
      setTarget(null);
    }
  }, [target, targets]);

  const selectionVersionRef = useRef(0);
  const prevSelectionRef = useRef<{ sourceKey: string | null; target: AgentId | null }>({ sourceKey, target });
  const previewActiveRef = useRef(false);

  const migrationOptions = (forTarget: AgentId) => ({
    register,
    includeChildren,
    normalizeTools,
    ...(forTarget === 'dsh'
      ? {
          slim: dshMode === 'slim',
          compact: dshMode === 'compact',
          ...(summaryEngine === 'off'
            ? {}
            : { summaryCommand: summaryEngine === 'claude' ? 'claude -p' : 'codex exec -' }),
        }
      : {}),
    ...(forTarget === 'antigravity' ? { handoffOnly: agHandoffOnly } : {}),
  });

  const preview = useMutation({
    mutationFn: (ctx: { source: SessionRow; target: AgentId; sourceKey: string; version: number }) =>
      api.previewMigration(ctx.source.agent, sessionRefOf(ctx.source), ctx.target, migrationOptions(ctx.target)),
  });

  const undo = useMutation({
    mutationFn: (opId: string) => api.undoBackup(opId),
    onSuccess: () => {
      if (previewActiveRef.current && source && target) {
        preview.mutate({
          source,
          target,
          sourceKey: rowKey(source),
          version: selectionVersionRef.current,
        });
      }
      void backupsQuery.refetch();
    },
  });

  const mergeBack = useMutation({
    mutationFn: (ctx: { source: SessionRow; target: AgentId; sourceKey: string; version: number; appendDiverged?: boolean }) =>
      api.runMergeBack({
        agent: ctx.source.agent,
        ref: sessionRefOf(ctx.source),
        target: ctx.target,
        normalizeTools,
        appendDiverged: ctx.appendDiverged,
      }),
    onMutate: () => {
      undo.reset();
    },
    onSuccess: (result, ctx) => {
      if (ctx.version !== selectionVersionRef.current) return;
      if (!result.refused) {
        preview.mutate({
          source: ctx.source,
          target: ctx.target,
          sourceKey: ctx.sourceKey,
          version: ctx.version,
        });
        void backupsQuery.refetch();
      }
    },
  });

  const run = useMutation({
    mutationFn: (ctx: { source: SessionRow; target: AgentId; sourceKey: string; version: number }) =>
      api.runMigration({
        agent: ctx.source.agent,
        ref: sessionRefOf(ctx.source),
        target: ctx.target,
        onDiverged: mode,
        ...migrationOptions(ctx.target),
      }),
    onMutate: () => {
      undo.reset();
      mergeBack.reset();
    },
    onSuccess: (result, ctx) => {
      if (ctx.version !== selectionVersionRef.current) return;
      if (!result.refused) {
        preview.mutate({
          source: ctx.source,
          target: ctx.target,
          sourceKey: ctx.sourceKey,
          version: ctx.version,
        });
        void backupsQuery.refetch();
      }
    },
  });

  const resetForSelectionChangeRef = useRef<() => void>(() => {});
  resetForSelectionChangeRef.current = () => {
    selectionVersionRef.current += 1;
    preview.reset();
    run.reset();
    mergeBack.reset();
    undo.reset();
    setCopiedPrompt(false);
    setMode('auto');
  };

  useEffect(() => {
    const prev = prevSelectionRef.current;
    if (prev.sourceKey !== sourceKey || prev.target !== target) {
      prevSelectionRef.current = { sourceKey, target };
      resetForSelectionChangeRef.current();
    }
  }, [sourceKey, target]);

  const matchesCurrentSelection = (ctx?: SelectionCtx): boolean =>
    ctx !== undefined &&
    ctx.sourceKey === sourceKey &&
    ctx.target === target &&
    ctx.version === selectionVersionRef.current;

  const activePreview = matchesCurrentSelection(preview.variables) ? preview.data : undefined;
  previewActiveRef.current = Boolean(activePreview);
  const activePreviewError = matchesCurrentSelection(preview.variables) ? preview.error : null;
  const activeRun = matchesCurrentSelection(run.variables) ? run.data : undefined;
  const activeRunError = matchesCurrentSelection(run.variables) ? run.error : null;
  const activeMergeBack = matchesCurrentSelection(mergeBack.variables) ? mergeBack.data : undefined;
  const activeMergeBackError = matchesCurrentSelection(mergeBack.variables) ? mergeBack.error : null;

  const formattedCaps = useMemo(
    () => (activePreview ? formatCapabilities(activePreview.caps, t) : []),
    [activePreview, t],
  );

  const refused = activeRun?.refused;
  const refusedText = refused
    ? locale === 'zh-CN' || refused.code !== 'migrate.diverged'
      ? refused.reason
      : t('migrate.refused.diverged')
    : '';

  const triggerPreview = (): void => {
    if (!source || !target) return;
    preview.mutate({
      source,
      target,
      sourceKey: rowKey(source),
      version: selectionVersionRef.current,
    });
  };

  const copyHandoffPrompt = (promptText: string): void => {
    void navigator.clipboard
      .writeText(promptText)
      .then(() => {
        setCopiedPrompt(true);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedPrompt(false);
          copyTimerRef.current = null;
        }, 1800);
      })
      .catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col">
      <Topbar
        icon={<ArrowLeftRight className="h-4 w-4" />}
        title={t('migrate.title')}
        subtitle={t('migrate.subtitle')}
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-5 py-6">
          <Card className="p-4">
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-caption font-medium text-fg-2">{t('migrate.source')}</div>
                <SourceSessionPicker
                  sessions={sessions}
                  value={sourceKey}
                  onChange={setSourceKey}
                  rowKey={rowKey}
                  loading={sessionsQuery.isLoading}
                />
              </div>

              <div className="flex items-center gap-2 text-fg-3">
                <div className="h-px flex-1 bg-border" />
                <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                <div className="h-px flex-1 bg-border" />
              </div>

              <div>
                <div className="mb-1.5 text-caption font-medium text-fg-2">{t('migrate.target')}</div>
                <TargetAgentSelector targets={targets} value={target} onChange={setTarget} />
              </div>
            </div>

            {target === 'dsh' ? (
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-control border border-border bg-subtle px-3 py-2 text-caption text-fg-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-medium text-fg-1">{t('migrate.importMode')}</span>
                  <div className="inline-flex items-center rounded-control border border-border bg-background/70 p-0.5">
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
                          'h-6 whitespace-nowrap rounded-control px-2 text-caption transition-colors',
                          dshMode === option.value ? 'bg-card font-medium text-fg-1 shadow-sm' : 'text-fg-2 hover:text-fg-1',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-medium text-fg-1">{t('migrate.summary')}</span>
                  <div className="inline-flex items-center rounded-control border border-border bg-background/70 p-0.5">
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
                          'h-6 whitespace-nowrap rounded-control px-2 text-caption transition-colors',
                          summaryEngine === option.value ? 'bg-card font-medium text-fg-1 shadow-sm' : 'text-fg-2 hover:text-fg-1',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {target === 'antigravity' ? (
              <div className="mt-4 space-y-2 rounded-control border border-border bg-subtle px-3 py-2.5 text-caption text-fg-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-fg-1">{t('migrate.antigravity.banner')}</span>
                  <Badge
                    variant={capsQuery.data?.antigravityApiAvailable && !agHandoffOnly ? 'success' : 'outline'}
                    className="shrink-0 whitespace-nowrap"
                  >
                    {capsQuery.data?.antigravityApiAvailable && !agHandoffOnly
                      ? t('migrate.antigravity.apiReady')
                      : t('migrate.antigravity.fileOnlyBadge')}
                  </Badge>
                </div>
                <div className="border-t border-border/60 pt-2">
                  <CheckboxRow checked={agHandoffOnly} onChange={setAgHandoffOnly}>
                    {t('migrate.antigravity.handoffOnly')}
                  </CheckboxRow>
                </div>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3.5">
              <CheckboxRow checked={register} onChange={setRegister}>
                {t('migrate.register')}
              </CheckboxRow>
              <CheckboxRow checked={includeChildren} onChange={setIncludeChildren}>
                {t('migrate.includeChildren')}
              </CheckboxRow>
              <CheckboxRow checked={normalizeTools} onChange={setNormalizeTools}>
                {t('migrate.normalizeTools')}
              </CheckboxRow>
              <Button
                className="ml-auto"
                size="sm"
                disabled={!source || !target || preview.isPending}
                onClick={triggerPreview}
              >
                {preview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                {t('migrate.preview')}
              </Button>
            </div>

            {activePreviewError ? (
              <div className="mt-3 flex items-center gap-2 rounded-control border border-destructive/30 bg-destructive/10 px-3 py-2 text-caption text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{tError(activePreviewError)}</span>
              </div>
            ) : null}
          </Card>

          {activePreview ? (
            <div className="space-y-4">
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2 text-body">
                  <AgentGlyph agent={activePreview.source.agent} size="sm" />
                  <span className="font-medium text-fg-1">{agentLabel(activePreview.source.agent)}</span>
                  <span className="min-w-0 truncate text-fg-2">
                    {activePreview.source.title ?? activePreview.source.sessionId}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-3" />
                  <AgentGlyph agent={activePreview.target} size="sm" />
                  <span className="font-medium text-fg-1">{agentLabel(activePreview.target)}</span>
                  <Badge variant={DECISION_TONE[activePreview.sync.decision]} className="ml-auto shrink-0 whitespace-nowrap">
                    {tDecision(activePreview.sync.decision)}
                  </Badge>
                </div>

                <div
                  className="mt-1.5 text-caption text-fg-2"
                  title={locale === 'en-US' ? activePreview.sync.description : undefined}
                >
                  {locale === 'zh-CN'
                    ? activePreview.sync.description
                    : tSyncDescription(activePreview.sync.decision, activePreview.sync.targetExtra)}
                </div>

                <div className="mt-3 grid gap-1 rounded-control border border-border bg-subtle px-3 py-2 font-mono text-3xs text-fg-2">
                  <div>{t('migrate.sync.sourceEvents', { count: activePreview.sync.sourceEvents })}</div>
                  <div>{t('migrate.sync.targetUnits', { count: activePreview.sync.targetUnits })}</div>
                  {activePreview.sync.targetPath ? (
                    <div className="truncate" title={activePreview.sync.targetPath}>
                      {t('migrate.sync.targetPath', { path: activePreview.sync.targetPath })}
                    </div>
                  ) : null}
                  <div className="truncate" title={activePreview.sync.stateFile}>
                    {t('migrate.sync.registry', { path: activePreview.sync.stateFile })}
                  </div>
                </div>

                {formattedCaps.length > 0 ? (
                  <div className="mt-3 border-t border-border pt-3">
                    <div className="mb-1.5 text-caption font-medium text-fg-2">{t('migrate.caps.title')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {formattedCaps.map((cap) => (
                        <Badge key={cap.key} variant={cap.variant} className="whitespace-nowrap">
                          {cap.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </Card>

              {activePreview.sync.decision === 'diverged' ? (
                <Card className="border-warning/30 bg-warning/10 p-4">
                  <div className="flex items-center gap-1.5 text-caption font-medium text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {t('migrate.diverged.count', { count: activePreview.sync.targetExtra ?? 0 })}
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
                          'rounded-control border px-3 py-2 text-left transition-colors',
                          mode === option.value ? 'border-ring bg-card shadow-sm' : 'border-border bg-card/60 hover:bg-card',
                        )}
                      >
                        <div className="text-body font-medium text-fg-1">{option.title}</div>
                        <div className="mt-0.5 text-caption text-fg-2">{option.hint}</div>
                      </button>
                    ))}
                  </div>
                  {source && target && writableAll.includes(source.agent) && source.agent !== 'antigravity' ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-warning/20 pt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mergeBack.isPending}
                        onClick={() =>
                          mergeBack.mutate({
                            source,
                            target,
                            sourceKey: rowKey(source),
                            version: selectionVersionRef.current,
                            appendDiverged: false,
                          })
                        }
                      >
                        {mergeBack.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
                        {mergeBack.isPending ? t('migrate.mergeBackAppending') : t('migrate.mergeBack')}
                      </Button>
                      {activeMergeBack?.refused ? (
                        <>
                          <span className="text-caption text-warning">{t('migrate.mergeBackDiverged')}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={mergeBack.isPending}
                            onClick={() =>
                              mergeBack.mutate({
                                source,
                                target,
                                sourceKey: rowKey(source),
                                version: selectionVersionRef.current,
                                appendDiverged: true,
                              })
                            }
                          >
                            {t('migrate.mergeBackConfirmDiverged')}
                          </Button>
                        </>
                      ) : null}
                      {activeMergeBack && !activeMergeBack.refused && activeMergeBack.decision === 'up-to-date' ? (
                        <span className="text-caption text-fg-2">{t('migrate.mergeBackNothing')}</span>
                      ) : null}
                      {activeMergeBackError ? (
                        <span className="text-caption text-destructive">{tError(activeMergeBackError)}</span>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              ) : null}

              <LossesCard losses={activePreview.losses} />

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!source || !target || run.isPending || preview.isPending}
                  onClick={() => {
                    if (!source || !target) return;
                    run.mutate({
                      source,
                      target,
                      sourceKey: rowKey(source),
                      version: selectionVersionRef.current,
                    });
                  }}
                >
                  {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('migrate.confirmWrite', { target: agentLabel(activePreview.target) })}
                </Button>
                <span className="text-caption text-fg-2">{t('migrate.writeHint')}</span>
              </div>

              {activeRunError ? (
                <Card className="border-destructive/30 bg-destructive/10 p-3 text-caption text-destructive">
                  {tError(activeRunError)}
                </Card>
              ) : null}

              {refused ? (
                <Card className="border-warning/30 bg-warning/10 p-3 text-caption text-warning">
                  <span title={refused.reason}>{refusedText}</span>
                </Card>
              ) : null}

              {activeRun && !activeRun.refused ? (
                <Card className="border-success/30 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                    <span className="text-body font-medium text-success">
                      {t('migrate.written', { target: agentLabel(activeRun.target) })}
                    </span>
                    <span className="truncate font-mono text-caption text-fg-2">{activeRun.sessionId}</span>
                    {activeRun.handoff ? (
                      <Badge
                        variant={activeRun.handoff.delivery === 'api' ? 'success' : 'outline'}
                        className="ml-auto shrink-0 whitespace-nowrap"
                      >
                        {activeRun.handoff.delivery === 'api'
                          ? t('migrate.antigravity.deliveryApi')
                          : t('migrate.antigravity.deliveryFile')}
                      </Badge>
                    ) : null}
                  </div>

                  {activeRun.handoff ? (
                    <div className="mt-3 space-y-3">
                      <div className="text-caption text-fg-2">
                        {activeRun.handoff.delivery === 'api'
                          ? t('migrate.antigravity.apiGuidance')
                          : t('migrate.antigravity.fileGuidance')}
                      </div>

                      <div className="space-y-1.5 rounded-control border border-border bg-subtle px-3 py-2 text-3xs">
                        {activeRun.handoff.conversationId ? (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 font-medium text-fg-2">{t('migrate.antigravity.conversationId')}</span>
                            <span className="truncate font-mono text-fg-1">{activeRun.handoff.conversationId}</span>
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 font-medium text-fg-2">{t('migrate.antigravity.mdPath')}</span>
                          <span className="truncate font-mono text-fg-2" title={activeRun.handoff.mdPath}>
                            {activeRun.handoff.mdPath}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 font-medium text-fg-2">{t('migrate.antigravity.irPath')}</span>
                          <span className="truncate font-mono text-fg-2" title={activeRun.handoff.irPath}>
                            {activeRun.handoff.irPath}
                          </span>
                        </div>
                      </div>

                      <div>
                        <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-fg-2">
                          <FileText className="h-3.5 w-3.5 text-fg-3" />
                          <span>{t('migrate.antigravity.promptLabel')}</span>
                        </div>
                        <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-subtle p-2.5 font-mono text-3xs text-fg-2">
                          {activeRun.handoff.promptText}
                        </pre>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant={activeRun.handoff.delivery === 'handoff-file' ? 'default' : 'outline'}
                          onClick={() => copyHandoffPrompt(activeRun.handoff!.promptText)}
                        >
                          {copiedPrompt ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                          {copiedPrompt ? t('migrate.antigravity.copied') : t('migrate.antigravity.copyPrompt')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void api.officialOpen('antigravity').catch(() => undefined)}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('migrate.antigravity.openApp')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <ul className="mt-2.5 space-y-1 rounded-control border border-border bg-subtle px-3 py-2 font-mono text-3xs text-fg-2">
                      {activeRun.paths.map((path) => (
                        <li key={path} className="truncate" title={path}>
                          {path}
                        </li>
                      ))}
                    </ul>
                  )}

                  <UndoActionRow
                    backupId={activeRun.backupId}
                    undoData={undo.data}
                    undoPending={undo.isPending}
                    undoError={undo.error}
                    onUndo={(id) => undo.mutate(id)}
                  />
                </Card>
              ) : null}

              {activeMergeBack && !activeMergeBack.refused && activeMergeBack.mergedEvents > 0 && target ? (
                <Card className="border-success/30 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-body font-medium text-success">
                    <GitMerge className="h-4 w-4 shrink-0" />
                    <span>{t('migrate.mergeBackDone', { target: agentLabel(target), count: activeMergeBack.mergedEvents })}</span>
                    {activeMergeBack.strategy ? (
                      <Badge variant="outline" className="ml-auto shrink-0 whitespace-nowrap font-mono text-3xs">
                        {activeMergeBack.strategy}
                      </Badge>
                    ) : null}
                  </div>
                  {activeMergeBack.sourcePath ? (
                    <div className="mt-2 truncate rounded-control border border-border bg-subtle px-3 py-1.5 font-mono text-3xs text-fg-2">
                      {activeMergeBack.sourcePath}
                    </div>
                  ) : null}
                  <UndoActionRow
                    backupId={activeMergeBack.backupId}
                    undoData={undo.data}
                    undoPending={undo.isPending}
                    undoError={undo.error}
                    onUndo={(id) => undo.mutate(id)}
                  />
                </Card>
              ) : null}
            </div>
          ) : sessionsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-body text-fg-2">
              <Spinner /> {t('migrate.loadingSessions')}
            </div>
          ) : null}

          <OfficialGuidesCard
            rows={officialQuery.data ?? []}
            source={source}
            open={guidesOpen}
            onToggle={() => setGuidesOpen((open) => !open)}
            results={officialResults}
            onVerifyResult={(officialTarget, result) =>
              setOfficialResults((current) => ({ ...current, [officialTarget]: result }))
            }
          />

          <BackupHistoryCard
            records={backupsQuery.data ?? []}
            loading={backupsQuery.isLoading}
            fetching={backupsQuery.isFetching}
            error={backupsQuery.error}
            undoData={undo.data}
            undoPending={undo.isPending}
            undoVariable={undo.variables}
            undoError={undo.error}
            onRefresh={() => void backupsQuery.refetch()}
            onUndo={(id) => undo.mutate(id)}
          />
        </div>
      </div>
    </div>
  );
}
