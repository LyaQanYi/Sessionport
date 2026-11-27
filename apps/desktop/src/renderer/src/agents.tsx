import { Hexagon } from 'lucide-react';

import {
  AntigravityIcon,
  ClaudeCodeIcon,
  ClaudeDesktopIcon,
  CodexIcon,
  CommandCodeIcon,
  CursorIcon,
  DeepSeekIcon,
  KimiCodeIcon,
  OpenCodeIcon,
  QoderIcon,
  WorkBuddyIcon,
  type HarnessIconComponent,
} from './icons/HarnessIcons.tsx';
import { cn } from './ui.tsx';

export interface AgentMeta {
  label: string;
  short: string;
  icon: HarnessIconComponent;
  tile: string;
  dot: string;
}

const OFFICIAL_TILE = 'border border-border/70 bg-card text-fg-1 dark:border-border/80 dark:bg-subtle';

export const AGENT_META: Record<string, AgentMeta> = {
  'kimi-code': { label: 'Kimi Code', short: 'Kimi', icon: KimiCodeIcon, tile: OFFICIAL_TILE, dot: 'bg-[#1783FF]' },
  'claude-code': { label: 'Claude Code', short: 'Claude', icon: ClaudeCodeIcon, tile: OFFICIAL_TILE, dot: 'bg-[#D97757]' },
  'claude-desktop': { label: 'Claude Desktop', short: 'Desktop', icon: ClaudeDesktopIcon, tile: OFFICIAL_TILE, dot: 'bg-[#B85432]' },
  'command-code': { label: 'Command Code', short: 'Command', icon: CommandCodeIcon, tile: OFFICIAL_TILE, dot: 'bg-fg-2' },
  dsh: { label: 'DeepSeek Harness', short: 'DSH', icon: DeepSeekIcon, tile: OFFICIAL_TILE, dot: 'bg-[#4D6BFE]' },
  codex: { label: 'Codex', short: 'Codex', icon: CodexIcon, tile: OFFICIAL_TILE, dot: 'bg-[#7A9DFF]' },
  opencode: { label: 'opencode', short: 'opencode', icon: OpenCodeIcon, tile: OFFICIAL_TILE, dot: 'bg-fg-2' },
  cursor: { label: 'Cursor', short: 'Cursor', icon: CursorIcon, tile: OFFICIAL_TILE, dot: 'bg-fg-2' },
  qoder: { label: 'Qoder', short: 'Qoder', icon: QoderIcon, tile: OFFICIAL_TILE, dot: 'bg-[#2ADB5C]' },
  workbuddy: { label: 'WorkBuddy', short: 'WorkBuddy', icon: WorkBuddyIcon, tile: OFFICIAL_TILE, dot: 'bg-[#01C886]' },
  antigravity: { label: 'Antigravity', short: 'Antigravity', icon: AntigravityIcon, tile: OFFICIAL_TILE, dot: 'bg-[#3186FF]' },
};

export function agentLabel(agent: string): string {
  return AGENT_META[agent]?.label ?? agent;
}

export function AgentGlyph(props: { agent: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const meta = AGENT_META[props.agent];
  const Icon = meta?.icon ?? Hexagon;
  const sizeClass = props.size === 'lg' ? 'h-9 w-9 rounded-panel' : props.size === 'md' ? 'h-7 w-7 rounded-control' : 'h-6 w-6 rounded-sm';
  const iconClass = props.size === 'lg' ? 'h-5 w-5' : props.size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center', sizeClass, meta?.tile ?? 'bg-muted text-fg-2', props.className)}
    >
      <Icon className={iconClass} />
    </span>
  );
}
