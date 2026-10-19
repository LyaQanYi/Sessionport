import type { AgentId } from './ir.ts';

export type LossSeverity = 'info' | 'warning';

export interface LossEntry {
  code: string;
  message: string;
  count: number;
  severity: LossSeverity;
}

/** 目标端能力声明：导出前就知道会丢什么，写报告时逐条核对 */
export interface ExportCaps {
  agent: AgentId;
  /** reasoning 能否保留 */
  reasoning: 'plain' | 'opaque' | 'none';
  /** 工具结果能否内联到目标端原生结构 */
  toolResults: 'separate' | 'inline' | 'none';
  /** 是否支持 fork / undo 语义 */
  branching: boolean;
  /** 是否支持子代理会话树 */
  subagents: boolean;
  /** 目标端是否只认自己的模型 id */
  modelPinned: boolean;
}

export interface WriteReport {
  target: AgentId;
  sessionId: string;
  paths: string[];
  /** 写入的事件统计 */
  written: {
    events: number;
    messages: number;
    toolCalls: number;
    toolResults: number;
    reasoning: number;
  };
  losses: LossEntry[];
  caps: ExportCaps;
}

export class LossCollector {
  private entries: LossEntry[];

  constructor() {
    this.entries = [];
  }

  add(code: string, message: string, opts: { count?: number; severity?: LossSeverity } = {}): void {
    const existing = this.entries.find((e) => e.code === code && e.message === message);
    if (existing) {
      existing.count += opts.count ?? 1;
      return;
    }
    this.entries.push({
      code,
      message,
      count: opts.count ?? 1,
      severity: opts.severity ?? 'warning',
    });
  }

  entries_(): LossEntry[] {
    return this.entries;
  }

  sorted(): LossEntry[] {
    const rank = (s: LossSeverity): number => (s === 'warning' ? 0 : 1);
    return [...this.entries].sort((a, b) => rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code));
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
