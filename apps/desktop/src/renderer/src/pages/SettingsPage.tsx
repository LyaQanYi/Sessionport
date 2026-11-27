import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FolderOpen, Info, Monitor, Moon, RefreshCw, Settings2, Sun } from 'lucide-react';

import { api } from '../api.ts';
import type { ThemeMode } from '../App.tsx';
import { AgentGlyph, agentLabel } from '../agents.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { AGENT_TO_HOME, ALL_AGENTS, type AgentPreferences } from '../preferences.ts';
import { Badge, Button, SettingsBlock, SettingsCard, SettingsRow, SegmentedControl, Spinner, Switch, Topbar, cn } from '../ui.tsx';

export function SettingsPage(props: { theme: ThemeMode; onThemeChange: (mode: ThemeMode) => void; prefs: AgentPreferences }) {
  const { t, preference, setPreference } = useT();
  const [semanticsOpen, setSemanticsOpen] = useState(false);
  const pathsQuery = useQuery({ queryKey: ['paths'], queryFn: api.paths });
  const paths = pathsQuery.data;

  return (
    <div className="flex h-full flex-col">
      <Topbar icon={<Settings2 className="h-4 w-4" />} title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-6">
          <SettingsBlock title={t('settings.appearance')} description={t('settings.appearance.desc')}>
            <SettingsCard>
              <SettingsRow label={t('settings.theme')} description={t('settings.theme.desc')}>
                <SegmentedControl
                  value={props.theme}
                  onChange={props.onThemeChange}
                  options={[
                    { value: 'system', label: <span className="flex items-center gap-1"><Monitor className="h-3 w-3" />{t('theme.system')}</span> },
                    { value: 'light', label: <span className="flex items-center gap-1"><Sun className="h-3 w-3" />{t('theme.light')}</span> },
                    { value: 'dark', label: <span className="flex items-center gap-1"><Moon className="h-3 w-3" />{t('theme.dark')}</span> },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock title={t('settings.language')} description={t('settings.language.desc')}>
            <SettingsCard>
              <SettingsRow label={t('settings.language.row')} description={t('settings.language.desc')}>
                <SegmentedControl
                  value={preference}
                  onChange={setPreference}
                  options={[
                    { value: 'system' as const, label: t('settings.language.system') },
                    { value: 'zh-CN' as const, label: t('settings.language.zh') },
                    { value: 'en-US' as const, label: t('settings.language.en') },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock
            title={t('settings.harness')}
            description={t('settings.harness.desc')}
            actions={
              <Button
                variant="ghost"
                size="sm"
                disabled={pathsQuery.isFetching}
                onClick={() => void pathsQuery.refetch()}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', pathsQuery.isFetching && 'animate-spin')} />
                {t('common.redetect')}
              </Button>
            }
          >
            <SettingsCard>
              {ALL_AGENTS.map((agent) => {
                const homeKey = AGENT_TO_HOME[agent];
                const home = homeKey ? paths?.homes?.[homeKey] : undefined;
                const loadingHome = pathsQuery.isLoading && !home;
                const detected = home ? home.exists : props.prefs.detected.includes(agent);
                const enabled = props.prefs.enabled.includes(agent);
                return (
                  <SettingsRow
                    key={agent}
                    label={
                      <span className="flex items-center gap-2">
                        <AgentGlyph agent={agent} />
                        {agentLabel(agent)}
                      </span>
                    }
                    description={
                      loadingHome ? (
                        <span className="inline-flex items-center gap-1.5 text-fg-3">
                          <Spinner className="h-3 w-3" />
                          {t('common.detecting')}
                        </span>
                      ) : home ? (
                        <span className="block truncate font-mono text-3xs" title={home.path}>
                          {home.path}
                        </span>
                      ) : detected ? (
                        t('settings.harness.detected')
                      ) : (
                        t('settings.harness.notDetected')
                      )
                    }
                  >
                    {loadingHome ? null : detected ? (
                      <Badge variant="success">{t('settings.paths.detected')}</Badge>
                    ) : (
                      <Badge variant="outline">{t('settings.harness.notDetectedBadge')}</Badge>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!homeKey || !home?.exists}
                      title={home?.path}
                      onClick={() => {
                        if (homeKey) void api.openPath(homeKey).catch(() => undefined);
                      }}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t('settings.paths.open')}
                    </Button>
                    <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
                    <Switch
                      checked={enabled}
                      onChange={() => props.prefs.toggle(agent)}
                      label={agentLabel(agent)}
                      title={enabled ? t('settings.harness.showInSidebar') : t('settings.harness.hide')}
                    />
                  </SettingsRow>
                );
              })}
              <SettingsRow
                label={t('settings.harness.policy')}
                description={props.prefs.customized ? t('settings.harness.customized') : t('settings.harness.followDetected')}
              >
                <Button variant="outline" size="sm" disabled={!props.prefs.customized} onClick={props.prefs.resetToDetected}>
                  {t('settings.harness.reset')}
                </Button>
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock title={t('settings.sync')} description={t('settings.sync.desc')}>
            <SettingsCard>
              <SettingsRow label="registry" description={<span className="font-mono text-3xs">{paths?.registryFile ?? '—'}</span>}>
                <Button variant="outline" size="sm" onClick={() => void api.openPath('registry').catch(() => undefined)}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('settings.paths.open')}
                </Button>
              </SettingsRow>
              <SettingsRow label={t('settings.sync.stateDir')} description={<span className="font-mono text-3xs">{paths?.registryDir ?? '—'}</span>}>
                <Badge variant="outline">registry.json</Badge>
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock title={t('settings.about')}>
            <SettingsCard>
              <SettingsRow label="Sessionport Desktop" description={t('settings.about.desc')}>
                <Badge variant="outline">v{paths?.version ?? '0.0.0'}</Badge>
              </SettingsRow>
              <SettingsRow label={t('settings.about.runtime')} description={'Electron ' + (paths?.electron ?? '—') + ' · ' + (window.sessionport?.platform ?? '—')}>
                <Info className="h-3.5 w-3.5 text-fg-3" />
              </SettingsRow>
              <SettingsRow label={t('settings.about.semantics')} description={t('settings.about.semanticsDesc')}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={semanticsOpen}
                  onClick={() => setSemanticsOpen((open) => !open)}
                >
                  <span>{semanticsOpen ? t('common.collapse') : t('settings.about.semanticsView')}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', semanticsOpen && 'rotate-180')} />
                </Button>
              </SettingsRow>
              {semanticsOpen ? (
                <div className="space-y-2 bg-subtle/60 px-4 py-3 text-caption text-fg-2">
                  <div className="flex items-start gap-2">
                    <Badge variant="default">fresh</Badge>
                    <span>{t('settings.about.semanticsFresh')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <Badge variant="success">up-to-date</Badge>
                    <span>{t('settings.about.semanticsUpToDate')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <Badge variant="default">refresh</Badge>
                    <span>{t('settings.about.semanticsRefresh')}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <Badge variant="warning">diverged</Badge>
                    <span>{t('settings.about.semanticsDiverged')}</span>
                  </div>
                </div>
              ) : null}
            </SettingsCard>
          </SettingsBlock>
        </div>
      </div>
    </div>
  );
}
