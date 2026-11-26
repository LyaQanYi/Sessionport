import { readFileSync } from 'node:fs';

import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { readCodexSession } from './read.ts';
import { appendCodexDelta, writeCodexSession } from './write.ts';

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  sourcePrefixes: ['codex'],
  read(input: string) {
    return readCodexSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const forcedPath = typeof opts.targetPath === 'string' ? opts.targetPath : undefined;
    const id = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await writeCodexSession(bundle, {
      ...(opts as object),
      id,
      dryRun: opts.dryRun === true,
      filePath: forcedPath,
    });
    return {
      target: 'codex',
      targetId: report.sessionId,
      paths: report.paths,
      unit: 'rows',
      units: report.rows.length + 1,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async appendDelta(targetPath, deltaBundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const id = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await appendCodexDelta(targetPath, deltaBundle, {
      ...(opts as object),
      id,
      dryRun: opts.dryRun === true,
      filePath: targetPath,
    });
    return {
      target: 'codex',
      targetId: report.sessionId,
      paths: [targetPath],
      unit: 'rows',
      units: report.totalLines,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async countTarget(outcome, opts) {
    const forcedPath = typeof opts.targetPath === 'string' ? opts.targetPath : undefined;
    try {
      const text = readFileSync(forcedPath ?? outcome.paths[0]!, 'utf8');
      return { exists: true, units: text.split('\n').filter((line) => line.trim().length > 0).length };
    } catch {
      return { exists: false, units: 0 };
    }
  },
};
