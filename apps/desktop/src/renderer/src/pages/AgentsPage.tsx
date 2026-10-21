import { useQuery } from '@tanstack/react-query';
import { Blocks, Check, Eye, EyeOff, FolderOpen, MessageSquare, X } from 'lucide-react';

import { api } from '../api.ts';
import { AgentGlyph, AGENT_META, agentLabel } from '../agents.tsx';
import type { AgentPreferences } from '../preferences.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import { Badge, Button, EmptyState, Spinner, Topbar, cn } from '../ui.tsx';

/** 有无头 resume 冒烟（结构化校验之外）的 agent */
const RESUME_SMOKE_AGENTS = new Set(['claude-code', 'codex', 'command-code', 'dsh', 'opencode']);

const HOME_KEY: Record<string, string> = {
  'kimi-code': 'kimi',
  'claude-code': 'claude',
  'command-code': 'commandCode',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
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
  const counts = new Map<string, number>();
  for (const row of sessions) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
  const readable = new Set<string>(capsQuery.data?.readable ?? []);
  const writable = new Set<string>(capsQuery.data?.writable ?? []);
  const homes = pathsQuery.data?.homes ?? {};

  const agents = Object.keys(AGENT_META);

  return (
    <div className="flex h-full flex-col">
      <Topbar
        icon={<Blocks className="h-4 w-4" />}
        title={t('agents.title')}
        subtitle={t('agents.subtitle')}
        actions={
          <Button variant="outline" size="sm" onClick={() => { void pathsQuery.refetch(); void capsQuery.refetch(); }}>
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
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => {
                const homeKey = HOME_KEY[agent] ?? '';
                const home = homes[homeKey];
                const count = counts.get(agent) ?? 0;
                return (
                  <div key={agent} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4">
                    <div className="flex items-start gap-3">
                      <AgentGlyph agent={agent} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-section text-fg-1">{agentLabel(agent)}</span>
                          {home?.exists ? <Badge variant="success">{t('agents.detected')}</Badge> : <Badge variant="outline">{t('agents.notInstalled')}</Badge>}
                          {props.prefs.enabled.includes(agent) ? null : <Badge variant="secondary">{t('agents.hidden')}</Badge>}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-3xs text-fg-3">{agent}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-section text-fg-1">{count}</div>
                        <div className="text-3xs text-fg-3">{t('agents.sessions')}</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Capability ok={readable.has(agent)} label={t('agents.read')} />
                      <Capability ok={writable.has(agent)} label={t('agents.write')} />
                      <Capability ok={RESUME_SMOKE_AGENTS.has(agent)} label={t('agents.headlessResume')} />
                    </div>

                    <div className="min-w-0 rounded-control border border-border bg-subtle px-2.5 py-1.5">
                      <div className="truncate font-mono text-3xs text-fg-2" title={home?.path ?? t('agents.notConfigured')}>
                        {home?.path ?? t('agents.noDataDir')}
                      </div>
                    </div>

                    <div className="mt-auto flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={!home?.exists} onClick={() => void api.openPath(homeKey).catch(() => undefined)}>
                        <FolderOpen className="h-3.5 w-3.5" />
                        {t('agents.openDir')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => props.prefs.toggle(agent)}
                        title={props.prefs.enabled.includes(agent) ? t('agents.hideFromSidebar') : t('agents.showInSidebar')}
                      >
                        {props.prefs.enabled.includes(agent) ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" disabled={count === 0} onClick={() => props.onOpenAgent(agent)} className="ml-auto">
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