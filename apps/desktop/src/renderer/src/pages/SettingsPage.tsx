import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FolderOpen, Info, Monitor, Moon, Settings2, Sun } from 'lucide-react';

import { api } from '../api.ts';
import type { ThemeMode } from '../App.tsx';
import { AgentGlyph, agentLabel } from '../agents.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { ALL_AGENTS, type AgentPreferences } from '../preferences.ts';
import { Badge, Button, SettingsBlock, SettingsCard, SettingsRow, SegmentedControl, Spinner, Topbar } from '../ui.tsx';

const AGENT_FOR_HOME: Record<string, string> = {
  kimi: 'kimi-code',
  claude: 'claude-code',
  commandCode: 'command-code',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
};

export function SettingsPage(props: { theme: ThemeMode; onThemeChange: (mode: ThemeMode) => void; prefs: AgentPreferences }) {
  const { t, preference, setPreference } = useT();
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

          <SettingsBlock title={t('settings.harness')} description={t('settings.harness.desc')}>
            <SettingsCard>
              {ALL_AGENTS.map((agent) => {
                const detected = props.prefs.detected.includes(agent);
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
                    description={detected ? t('settings.harness.detected') : t('settings.harness.notDetected')}
                  >
                    {detected ? <Badge variant="success">{t('settings.harness.installed')}</Badge> : <Badge variant="outline">{t('settings.harness.notDetectedBadge')}</Badge>}
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => props.prefs.toggle(agent)}
                      className="h-4 w-4 rounded border-input accent-[hsl(var(--ring))]"
                      title={enabled ? t('settings.harness.showInSidebar') : t('settings.harness.hide')}
                    />
                  </SettingsRow>
                );
              })}
              <SettingsRow
                label={t('settings.harness.policy')}
                description={props.prefs.customized ? t('settings.harness.customized') : t('settings.harness.followDetected')}
              >
                <Button variant="outline" size="sm" onClick={props.prefs.resetToDetected}>
                  {t('settings.harness.reset')}
                </Button>
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock
            title={t('settings.paths')}
            description={t('settings.paths.desc')}
            actions={
              <Button variant="ghost" size="sm" onClick={() => void pathsQuery.refetch()}>
                {t('common.redetect')}
              </Button>
            }
          >
            <SettingsCard>
              {pathsQuery.isLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-caption text-fg-2">
                  <Spinner /> {t('common.detecting')}
                </div>
              ) : (
                Object.entries(paths?.homes ?? {}).map(([key, home]) => (
                  <SettingsRow
                    key={key}
                    label={
                      <span className="flex items-center gap-2">
                        <AgentGlyph agent={AGENT_FOR_HOME[key] ?? key} />
                        {home.label}
                      </span>
                    }
                    description={<span className="font-mono text-3xs">{home.path}</span>}
                  >
                    {home.exists ? <Badge variant="success">{t('settings.paths.detected')}</Badge> : <Badge variant="outline">{t('settings.paths.notDetected')}</Badge>}
                    <Button variant="outline" size="sm" disabled={!home.exists} onClick={() => void api.openPath(key).catch(() => undefined)}>
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t('settings.paths.open')}
                    </Button>
                  </SettingsRow>
                ))
              )}
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
              <SettingsRow label="sessionport desktop" description={t('settings.about.desc')}>
                <Badge variant="outline">v{paths?.version ?? '0.0.0'}</Badge>
              </SettingsRow>
              <SettingsRow label={t('settings.about.runtime')} description={'Electron ' + (paths?.electron ?? '—') + ' · ' + (window.sessionport?.platform ?? '—')}>
                <Info className="h-3.5 w-3.5 text-fg-3" />
              </SettingsRow>
              <SettingsRow label={t('settings.about.semantics')} description={t('settings.about.semanticsDesc')}>
                <ExternalLink className="h-3.5 w-3.5 text-fg-3" />
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>
        </div>
      </div>
    </div>
  );
}
