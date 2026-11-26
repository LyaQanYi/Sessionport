import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { readCommandCodeSession } from './read.ts';
import { countCommandCodeTarget } from './verify.ts';
import { appendCommandCodeDelta, writeCommandCodeSession } from './write.ts';

export const commandCodeAdapter: AgentAdapter = {
  id: 'command-code',
  displayName: 'Command Code',
  sourcePrefixes: ['commandcode', 'cmd'],
  read(input: string) {
    return readCommandCodeSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const id = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await writeCommandCodeSession(bundle, {
      ...(opts as object),
      id,
      dryRun: opts.dryRun === true,
    });
    return {
      target: 'command-code',
      targetId: report.sessionId,
      paths: report.paths,
      unit: 'rows',
      units: report.rows.length + 1,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async appendDelta(targetPath, deltaBundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const report = await appendCommandCodeDelta(targetPath, deltaBundle, {
      ...(opts as object),
      dryRun: opts.dryRun === true,
    });
    return {
      target: 'command-code',
      targetId: report.sessionId,
      paths: [targetPath],
      unit: 'rows',
      units: report.totalLines,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async countTarget(outcome) {
    return countCommandCodeTarget(outcome.paths[0]!);
  },
};
