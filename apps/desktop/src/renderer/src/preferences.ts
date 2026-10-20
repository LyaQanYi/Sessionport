import { useCallback, useMemo, useState } from 'react';

const KEY = 'sessionport.enabledAgents';

/** 本机数据目录 key → agent id */
export const HOME_TO_AGENT: Record<string, string> = {
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

export const ALL_AGENTS = ['claude-code', 'codex', 'command-code', 'dsh', 'opencode', 'kimi-code', 'cursor', 'qoder', 'workbuddy'];

function readStored(): string[] | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === 'string' && ALL_AGENTS.includes(value));
  } catch {
    return null;
  }
}

export interface AgentPreferences {
  /** 当前用于侧栏/会话/迁移的 agent 列表 */
  enabled: string[];
  /** 本机检测到数据目录的 agent */
  detected: string[];
  /** 用户是否自定义过（false 表示跟随检测） */
  customized: boolean;
  toggle: (agent: string) => void;
  setAll: (agents: string[]) => void;
  resetToDetected: () => void;
}

export function useAgentPreferences(detected: string[]): AgentPreferences {
  const [stored, setStored] = useState<string[] | null>(readStored);

  const enabled = useMemo(() => {
    const base = stored ?? detected;
    // 保持稳定顺序：按 ALL_AGENTS 的顺序输出
    return ALL_AGENTS.filter((agent) => base.includes(agent));
  }, [stored, detected]);

  const save = useCallback((next: string[] | null) => {
    setStored(next);
    try {
      if (next === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用时仅内存生效
    }
  }, []);

  const toggle = useCallback(
    (agent: string) => {
      const current = stored ?? detected;
      const next = current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent];
      save(next);
    },
    [stored, detected, save],
  );

  return {
    enabled,
    detected,
    customized: stored !== null,
    toggle,
    setAll: (agents: string[]) => save(agents),
    resetToDetected: () => save(null),
  };
}
