import { Braces, Briefcase, Hexagon, Moon, MousePointer2, Sparkles, SquareTerminal, Wand2, Waves, type LucideIcon } from 'lucide-react';

import { cn } from './ui.tsx';

export interface AgentMeta {
  label: string;
  short: string;
  icon: LucideIcon;
  tile: string;
  dot: string;
}

export const AGENT_META: Record<string, AgentMeta> = {
  'kimi-code': { label: 'Kimi Code', short: 'Kimi', icon: Moon, tile: 'bg-violet-500/15 text-violet-600 dark:text-violet-400', dot: 'bg-violet-500' },
  'claude-code': { label: 'Claude Code', short: 'Claude', icon: Sparkles, tile: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  'command-code': { label: 'Command Code', short: 'Command', icon: SquareTerminal, tile: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  dsh: { label: 'DeepSeek Harness', short: 'DSH', icon: Waves, tile: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', dot: 'bg-sky-500' },
  codex: { label: 'Codex', short: 'Codex', icon: Hexagon, tile: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400', dot: 'bg-zinc-400' },
  opencode: { label: 'opencode', short: 'opencode', icon: Braces, tile: 'bg-rose-500/15 text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
  cursor: { label: 'Cursor', short: 'Cursor', icon: MousePointer2, tile: 'bg-teal-500/15 text-teal-600 dark:text-teal-400', dot: 'bg-teal-500' },
  qoder: { label: 'Qoder', short: 'Qoder', icon: Wand2, tile: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', dot: 'bg-blue-500' },
  workbuddy: { label: 'WorkBuddy', short: 'WorkBuddy', icon: Briefcase, tile: 'bg-orange-500/15 text-orange-600 dark:text-orange-400', dot: 'bg-orange-500' },
};

export function agentLabel(agent: string): string {
  return AGENT_META[agent]?.label ?? agent;
}

export function AgentGlyph(props: { agent: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const meta = AGENT_META[props.agent];
  const Icon = meta?.icon ?? Hexagon;
  const sizeClass = props.size === 'lg' ? 'h-9 w-9 rounded-panel' : props.size === 'md' ? 'h-7 w-7 rounded-control' : 'h-6 w-6 rounded-sm';
  const iconClass = props.size === 'lg' ? 'h-4.5 w-4.5' : props.size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center', sizeClass, meta?.tile ?? 'bg-muted text-muted-foreground', props.className)}
    >
      <Icon className={iconClass} />
    </span>
  );
}
