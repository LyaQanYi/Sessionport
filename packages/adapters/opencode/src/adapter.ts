import type { AdapterWriteOptions, AdapterWriteOutcome, AgentAdapter } from '@sessionport/core';

import { exportOpencodeSession, readOpencodeSession } from './read.ts';
import { countOpencodeTarget } from './verify.ts';
import { writeOpencodeSession } from './write.ts';

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  displayName: 'opencode',
  sourcePrefixes: ['opencode'],
  read(input: string) {
    return readOpencodeSession(input);
  },
  async write(bundle, opts: AdapterWriteOptions): Promise<AdapterWriteOutcome> {
    const id = typeof opts.id === 'string' ? opts.id : undefined;
    const opencodeHome = typeof opts.home === 'string' ? opts.home : undefined;
    const report = await writeOpencodeSession(bundle, {
      ...(opts as object),
      id,
      dryRun: opts.dryRun === true,
      runCwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
      ...(opencodeHome !== undefined ? { env: { XDG_DATA_HOME: opencodeHome } } : {}),
    });
    return {
      target: 'opencode',
      targetId: report.sessionId,
      paths: report.jsonPath ? [report.jsonPath] : [],
      unit: 'rows',
      units: report.exportData.messages?.length ?? 0,
      report: report as unknown as AdapterWriteOutcome['report'],
    };
  },
  async countTarget(outcome, opts) {
    try {
      const opencodeHome = typeof opts.home === 'string' ? opts.home : undefined;
      // 目标端不落 JSON 文件（import 后临时文件会清理），通过 export 数消息
      const raw = await exportOpencodeSession(outcome.targetId, {
        ...(opencodeHome !== undefined ? { env: { XDG_DATA_HOME: opencodeHome } } : {}),
      });
      return countOpencodeTarget(raw);
    } catch {
      return { exists: false, units: 0 };
    }
  },
};
