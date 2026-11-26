import type { AgentAdapter } from '@sessionport/core';

import { readAntigravitySession } from './read.ts';

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  sourcePrefixes: ['antigravity', 'agy'],
  read(input: string) {
    return readAntigravitySession(input);
  },
};
