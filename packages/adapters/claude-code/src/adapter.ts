import { readFileSync } from 'node:fs';

import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { readClaudeSession } from './read.ts';
import { writeClaudeSession } from './write.ts';

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  sourcePrefixes: ['claude', 'claudecode'],
  read(input: string) {
    return readClaudeSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const configDir = typeof opts.home === 'string' ? opts.home : undefined;
    const sessionId = typeof opts.id === 'string' ? opts.id : undefined;
    const report = await writeClaudeSession(bundle, {
      ...(opts as object),
      ...(configDir !== undefined ? { configDir } : {}),
      sessionId,
      dryRun: opts.dryRun === true,
    });
    return {
      target: 'claude-code',
      targetId: report.sessionId,
      paths: report.paths,
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
