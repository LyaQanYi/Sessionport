import { readFileSync } from 'node:fs';

import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { readQoderSession } from './read.ts';
import { writeQoderSession } from './write.ts';

export const qoderAdapter: AgentAdapter = {
  id: 'qoder',
  displayName: 'Qoder',
  sourcePrefixes: ['qoder'],
  read(input: string) {
    return readQoderSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const sessionId = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await writeQoderSession(bundle, {
      ...(opts as object),
      sessionId,
      dryRun: opts.dryRun === true,
    });
    return {
      target: 'qoder',
      targetId: report.sessionId,
      paths: [report.path],
      unit: 'rows',
      units: report.rows.length,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async countTarget(outcome) {
    try {
      const text = readFileSync(outcome.paths[0]!, 'utf8');
      return { exists: true, units: text.split('\n').filter((line) => line.trim().length > 0).length };
    } catch {
      return { exists: false, units: 0 };
    }
  },
};
