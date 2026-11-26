import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { readCursorSession } from './read.ts';
import { countCursorTarget } from './verify.ts';
import { writeCursorSession } from './write.ts';

export const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  sourcePrefixes: ['cursor'],
  read(input: string) {
    return readCursorSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const composerId = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await writeCursorSession(bundle, {
      ...(opts as object),
      composerId,
      dryRun: opts.dryRun === true,
      confirmReal: Boolean(opts.confirmReal),
      keepSynthetic: opts.keepInjected === true || opts.keepSynthetic === true,
    });
    const bubbles = report.rows.filter((row: { kind: string }) => row.kind === 'bubble').length;
    return {
      target: 'cursor',
      targetId: report.composerId,
      paths: [report.dbPath],
      unit: 'rows',
      units: bubbles,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async countTarget(outcome, opts) {
    return countCursorTarget({
      home: typeof opts.home === 'string' ? opts.home : undefined,
      sessionId: outcome.targetId,
    });
  },
};
