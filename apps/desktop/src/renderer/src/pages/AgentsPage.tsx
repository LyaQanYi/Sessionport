import { useQuery } from '@tanstack/react-query';
import { Blocks, Check, Eye, EyeOff, FolderOpen, MessageSquare, X } from 'lucide-react';

import { api } from '../api.ts';
import { AgentGlyph, AGENT_META, agentLabel } from '../agents.tsx';
import type { AgentPreferences } from '../preferences.ts';
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
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions });
  const capsQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
  const pathsQuery = useQuery({ queryKey: ['paths'], queryFn: api.paths });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const counts = new Map<string, number>();
  for (const row of sessions) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
  const readable = new Set(capsQuery.data?.readable ?? []);
  const writable = new Set(capsQuery.data?.writable ?? []);
  const homes = pathsQuery.data?.homes ?? {};

  const agents = Object.keys(AGENT_META);

  return (
    <div className="flex h-full flex-col">
      <Topbar
        icon={<Blocks className="h-4 w-4" />}
        title="适配器"
        subtitle="每个 agent 的读写能力与本机数据目录"
        actions={
          <Button variant="outline" size="sm" onClick={() => { void pathsQuery.refetch(); void capsQuery.refetch(); }}>
            重新检测
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-5 py-6">
          {capsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-body text-fg-2">
              <Spinner /> 检测中…
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
                          {home?.exists ? <Badge variant="success">已检测</Badge> : <Badge variant="outline">未安装</Badge>}
                          {props.prefs.enabled.includes(agent) ? null : <Badge variant="secondary">已隐藏</Badge>}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-3xs text-fg-3">{agent}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-section text-fg-1">{count}</div>
                        <div className="text-3xs text-fg-3">会话</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Capability ok={readable.has(agent)} label="读取" />
                      <Capability ok={writable.has(agent)} label="写入" />
                      <Capability ok={RESUME_SMOKE_AGENTS.has(agent)} label="headless resume" />
                    </div>

                    <div className="min-w-0 rounded-control border border-border bg-subtle px-2.5 py-1.5">
                      <div className="truncate font-mono text-3xs text-fg-2" title={home?.path ?? '未配置'}>
                        {home?.path ?? '未配置数据目录'}
                      </div>
                    </div>

                    <div className="mt-auto flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={!home?.exists} onClick={() => void api.openPath(homeKey).catch(() => undefined)}>
                        <FolderOpen className="h-3.5 w-3.5" />
                        打开目录
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => props.prefs.toggle(agent)}
                        title={props.prefs.enabled.includes(agent) ? '从侧栏隐藏' : '在侧栏显示'}
                      >
                        {props.prefs.enabled.includes(agent) ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" disabled={count === 0} onClick={() => props.onOpenAgent(agent)} className="ml-auto">
                        <MessageSquare className="h-3.5 w-3.5" />
                        查看会话
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!capsQuery.isLoading && sessions.length === 0 ? (
            <EmptyState title="还没有扫描到会话" hint="检查各 agent 的数据目录，或先在本机使用一段时间对应的 CLI" />
          ) : null}
        </div>
      </div>
    </div>
  );
}