import type { AgentId, IrBundle } from './ir.ts';
import type { LossEntry } from './loss.ts';

export type AdapterWriteOptions = Record<string, unknown>;

export interface AdapterWriteOutcome {
  target: AgentId;
  targetId: string;
  paths: string[];
  unit: 'rows' | 'events';
  units: number;
  report: {
    written?: {
      events: number;
      messages: number;
      toolCalls: number;
      toolResults: number;
      reasoning: number;
    };
    losses?: LossEntry[];
    [k: string]: unknown;
  };
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly sourcePrefixes: readonly string[];
  read?(input: string): Promise<IrBundle>;
  write?(bundle: IrBundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome>;
  /** 对已有原生会话文件执行无损尾部追加（仅追加新增 delta 行，保留既有字节与特定元数据） */
  appendDelta?(
    targetPath: string,
    deltaBundle: IrBundle,
    opts: AdapterWriteOptions,
  ): Promise<AdapterWriteOutcome>;
  countTarget?(outcome: AdapterWriteOutcome, opts: AdapterWriteOptions): Promise<{ exists: boolean; units: number }>;
}
