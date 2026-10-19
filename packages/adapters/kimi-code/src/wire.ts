/**
 * Kimi Code wire.jsonl 的宽松类型 + 解析。
 *
 * 事实来源：本机 ~/.kimi-code（CLI 2.1.1 / 桌面端 1.1.0）与真实导出 bundle（2026-10-19）。
 * wire 事件共 29 种，这里只描述与对话内容相关的部分，其余按 unknown 跳过并计数。
 */

export interface KimiState {
  id: string;
  version: number;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
  title?: string;
  titleKind?: string;
  lastPrompt?: string;
  lastTurnReason?: string;
  isCustomTitle?: boolean;
  agents?: Record<string, KimiAgentState>;
}

export interface KimiAgentState {
  homedir?: string;
  type?: 'main' | 'sub' | string;
  parentAgentId?: string;
  labels?: { parentAgentId?: string; profileName?: string };
}

export interface KimiManifest {
  sessionId?: string;
  exportedAt?: string;
  kimiCodeVersion?: string;
  wireProtocolVersion?: string;
  os?: string;
  nodejsVersion?: string;
  sessionFirstActivity?: string;
  sessionLastActivity?: string;
  title?: string;
  workspaceDir?: string;
  desktopVersion?: string;
}

export interface KimiWireLine {
  type?: string;
  time?: number;
  kind?: string;
  agentId?: string;
  [key: string]: unknown;
}

/** 一条 loop event（context.append_loop_event 里的 event） */
export interface KimiLoopEvent {
  type?: string;
  uuid?: string;
  turnId?: string | number;
  step?: number;
  parentUuid?: string;
  toolCallId?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  part?: { type?: string; text?: string; think?: string; reasoningKey?: string };
  [key: string]: unknown;
}

export interface ParsedWire {
  lines: KimiWireLine[];
  badLines: number;
}

export function parseWireJsonl(text: string): ParsedWire {
  const lines: KimiWireLine[] = [];
  let badLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object') lines.push(value as KimiWireLine);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines };
}

/** epoch 毫秒 -> ISO 8601；非法值返回 undefined */
export function msToIso(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}
