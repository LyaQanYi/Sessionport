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
  countTarget?(outcome: AdapterWriteOutcome, opts: AdapterWriteOptions): Promise<{ exists: boolean; units: number }>;
}
