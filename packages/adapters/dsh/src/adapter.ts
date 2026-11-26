import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { readDshSession } from './read.ts';
import { countDshTarget } from './verify.ts';
import { writeDshSession } from './write.ts';

export const dshAdapter: AgentAdapter = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  sourcePrefixes: ['dsh'],
  read(input: string) {
    return readDshSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const id = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await writeDshSession(bundle, {
      ...(opts as object),
      id,
      dryRun: opts.dryRun === true,
    });
    return {
      target: 'dsh',
      targetId: report.sessionId,
      paths: report.paths,
      unit: 'events',
      units: report.written.events,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async countTarget(outcome, opts) {
    const result = await countDshTarget({
      home: typeof opts.home === 'string' ? opts.home : undefined,
      sessionId: outcome.targetId,
    });
    return { exists: result.exists, units: result.units };
  },
};
