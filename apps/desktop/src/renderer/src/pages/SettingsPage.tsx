import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FolderOpen, Info, Monitor, Moon, Settings2, Sun } from 'lucide-react';

import { api } from '../api.ts';
import type { ThemeMode } from '../App.tsx';
import { AgentGlyph, agentLabel } from '../agents.tsx';
import { ALL_AGENTS, type AgentPreferences } from '../preferences.ts';
import { Badge, Button, SettingsBlock, SettingsCard, SettingsRow, SegmentedControl, Spinner, Topbar } from '../ui.tsx';

const AGENT_FOR_HOME: Record<string, string> = {
  kimi: 'kimi-code',
  claude: 'claude-code',
  commandCode: 'command-code',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
};

export function SettingsPage(props: { theme: ThemeMode; onThemeChange: (mode: ThemeMode) => void; prefs: AgentPreferences }) {
  const pathsQuery = useQuery({ queryKey: ['paths'], queryFn: api.paths });
  const paths = pathsQuery.data;

  return (
    <div className="flex h-full flex-col">
      <Topbar icon={<Settings2 className="h-4 w-4" />} title="设置" subtitle="外观、数据目录与同步状态" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-6">
          <SettingsBlock title="外观" description="主题会跟随系统变化，也可以手动固定">
            <SettingsCard>
              <SettingsRow label="主题" description="浅色 / 深色 / 跟随系统">
                <SegmentedControl
                  value={props.theme}
                  onChange={props.onThemeChange}
                  options={[
                    { value: 'system', label: <span className="flex items-center gap-1"><Monitor className="h-3 w-3" />跟随系统</span> },
                    { value: 'light', label: <span className="flex items-center gap-1"><Sun className="h-3 w-3" />浅色</span> },
                    { value: 'dark', label: <span className="flex items-center gap-1"><Moon className="h-3 w-3" />深色</span> },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock title="Harness" description="只列出你实际会用到的；开关会影响侧栏、会话列表和迁移目标">
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
                    description={detected ? '本机已检测到数据目录' : '本机未检测到数据目录'}
                  >
                    {detected ? <Badge variant="success">已安装</Badge> : <Badge variant="outline">未检测</Badge>}
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => props.prefs.toggle(agent)}
                      className="h-4 w-4 rounded border-input accent-[hsl(var(--ring))]"
                      title={enabled ? '在侧栏显示' : '隐藏'}
                    />
                  </SettingsRow>
                );
              })}
              <SettingsRow
                label="显示策略"
                description={props.prefs.customized ? '已自定义（点右侧恢复自动检测）' : '跟随本机检测结果'}
              >
                <Button variant="outline" size="sm" onClick={props.prefs.resetToDetected}>
                  恢复自动检测
                </Button>
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock
            title="数据目录"
            description="只读扫描，不会修改这些目录"
            actions={
              <Button variant="ghost" size="sm" onClick={() => void pathsQuery.refetch()}>
                重新检测
              </Button>
            }
          >
            <SettingsCard>
              {pathsQuery.isLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-caption text-fg-2">
                  <Spinner /> 检测中…
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
                    {home.exists ? <Badge variant="success">已检测</Badge> : <Badge variant="outline">未检测到</Badge>}
                    <Button variant="outline" size="sm" disabled={!home.exists} onClick={() => void api.openPath(key).catch(() => undefined)}>
                      <FolderOpen className="h-3.5 w-3.5" />
                      打开
                    </Button>
                  </SettingsRow>
                ))
              )}
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock title="同步状态" description="sessionport 自己的状态目录（不含会话正文）">
            <SettingsCard>
              <SettingsRow label="registry" description={<span className="font-mono text-3xs">{paths?.registryFile ?? '—'}</span>}>
                <Button variant="outline" size="sm" onClick={() => void api.openPath('registry').catch(() => undefined)}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  打开
                </Button>
              </SettingsRow>
              <SettingsRow label="状态目录" description={<span className="font-mono text-3xs">{paths?.registryDir ?? '—'}</span>}>
                <Badge variant="outline">registry.json</Badge>
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>

          <SettingsBlock title="关于">
            <SettingsCard>
              <SettingsRow label="sessionport desktop" description="本地优先，无遥测；会话正文只在本机流动">
                <Badge variant="outline">v{paths?.version ?? '0.0.0'}</Badge>
              </SettingsRow>
              <SettingsRow label="运行环境" description={'Electron ' + (paths?.electron ?? '—') + ' · ' + (window.sessionport?.platform ?? '—')}>
                <Info className="h-3.5 w-3.5 text-fg-3" />
              </SettingsRow>
              <SettingsRow label="迁移语义" description="fresh / up-to-date / refresh / diverged（目标端有新增默认拒绝）">
                <ExternalLink className="h-3.5 w-3.5 text-fg-3" />
              </SettingsRow>
            </SettingsCard>
          </SettingsBlock>
        </div>
      </div>
    </div>
  );
}