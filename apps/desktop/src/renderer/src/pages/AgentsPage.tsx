import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Blocks, Check, Eye, EyeOff, FolderOpen, MessageSquare, RefreshCw, X } from 'lucide-react';

import { api } from '../api.ts';
import { AgentGlyph, AGENT_META, agentLabel } from '../agents.tsx';
import type { AgentPreferences } from '../preferences.ts';
import { countRootSessionsByAgent } from '../sessionTree.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import { Badge, Button, EmptyState, Spinner, Topbar, cn } from '../ui.tsx';

/** 有无头 resume 冒烟（结构化校验之外）的 agent */
const RESUME_SMOKE_AGENTS = new Set(['claude-code', 'codex', 'command-code', 'dsh', 'opencode']);

const HOME_KEY: Record<string, string> = {
  'kimi-code': 'kimi',
  'claude-code': 'claude',
  'claude-desktop': 'claudeDesktop',
  'command-code': 'commandCode',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
  antigravity: 'antigravity',
};

function Capability(props: { ok: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-caption', props.ok ? 'text-fg-2' : 'text-fg-3 line-through')}>
      {props.ok ? <Check className="h-3 w-3 text-success" /> : <X className="h-3 w-3" />}
      {props.label}
    </span>
  );
}

export function AgentsPage(props: { onOpenAgent: (agent: string) => void; prefs: AgentPreferences }) {
  const { t } = useT();
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
  const pathsQuery = useQuery({ queryKey: ['paths'], queryFn: api.paths });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const counts = countRootSessionsByAgent(sessions);
  const readable = new Set<string>(capsQuery.data?.readable ?? []);
  const writable = new Set<string>(capsQuery.data?.writable ?? []);
  const antigravityApiAvailable = Boolean(capsQuery.data?.antigravityApiAvailable);
  const homes = pathsQuery.data?.homes ?? {};
  const redetecting = pathsQuery.isFetching || capsQuery.isFetching;

  const agents = Object.keys(AGENT_META);

  return (
    <div className="flex h-full flex-col">
      <Topbar
        icon={<Blocks className="h-4 w-4" />}
        title={t('agents.title')}
        subtitle={t('agents.subtitle')}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={redetecting}
            onClick={() => {
              void pathsQuery.refetch();
              void capsQuery.refetch();
            }}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', redetecting && 'animate-spin')} />
            {t('agents.redetect')}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-5 py-6">
          {capsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-body text-fg-2">
              <Spinner /> {t('agents.detecting')}
            </div>
          ) : (
            <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => {
                const homeKey = HOME_KEY[agent] ?? '';
                const home = homes[homeKey];
                const count = counts.get(agent) ?? 0;
                const isAntigravity = agent === 'antigravity';
                const canWrite = writable.has(agent);
                const enabledInSidebar = props.prefs.enabled.includes(agent);
                return (
                  <div key={agent} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4">
                    <div className="flex items-start gap-3">
                      <AgentGlyph agent={agent} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-section text-fg-1">{agentLabel(agent)}</span>
                          {home?.exists ? <Badge variant="success">{t('agents.detected')}</Badge> : <Badge variant="outline">{t('agents.notInstalled')}</Badge>}
                          {enabledInSidebar ? null : <Badge variant="secondary">{t('agents.hidden')}</Badge>}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-3xs text-fg-3">{agent}</div>
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <div className="text-section text-fg-1">{count}</div>
                        <div className="text-3xs text-fg-3">{t('agents.sessions')}</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Capability ok={readable.has(agent)} label={t('agents.read')} />
                      {isAntigravity && canWrite ? (
                        <span
                          className="inline-flex items-center gap-1 text-caption text-warning"
                          title={t('agents.writeHandoffHint')}
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          {t('agents.writeHandoff')}
                        </span>
                      ) : (
                        <Capability ok={canWrite} label={t('agents.write')} />
                      )}
                      <Capability ok={RESUME_SMOKE_AGENTS.has(agent)} label={t('agents.headlessResume')} />
                    </div>

                    {isAntigravity && canWrite ? (
                      <div className="flex flex-wrap items-center gap-1.5" title={t('agents.writeHandoffHint')}>
                        <Badge variant="warning">{t('agents.handoffBadge')}</Badge>
                        <Badge variant={antigravityApiAvailable ? 'success' : 'outline'}>
                          {antigravityApiAvailable ? t('agents.antigravityApiReady') : t('agents.antigravityFileOnly')}
                        </Badge>
                      </div>
                    ) : null}

                    <div className="min-w-0 rounded-control border border-border bg-subtle px-2.5 py-1.5">
                      <div
                        className={cn('truncate font-mono text-3xs', home?.exists ? 'text-fg-2' : 'text-fg-3')}
                        title={home?.path ?? t('agents.notConfigured')}
                      >
                        {home?.path ?? t('agents.noDataDir')}
                      </div>
                    </div>

                    <div className="mt-auto flex items-center gap-2 pt-0.5">
                      <Button size="sm" variant="outline" disabled={!home?.exists} onClick={() => void api.openPath(homeKey).catch(() => undefined)}>
                        <FolderOpen className="h-3.5 w-3.5" />
                        {t('agents.openDir')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => props.prefs.toggle(agent)}
                        title={enabledInSidebar ? t('agents.hideFromSidebar') : t('agents.showInSidebar')}
                        aria-label={enabledInSidebar ? t('agents.hideFromSidebar') : t('agents.showInSidebar')}
                      >
                        {enabledInSidebar ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        size="sm"
                        variant={count === 0 ? 'outline' : 'default'}
                        disabled={count === 0}
                        onClick={() => props.onOpenAgent(agent)}
                        className="ml-auto"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        {t('agents.viewSessions')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!capsQuery.isLoading && sessions.length === 0 ? (
            <EmptyState title={t('agents.emptyTitle')} hint={t('agents.emptyHint')} />
          ) : null}
        </div>
      </div>
    </div>
  );
}