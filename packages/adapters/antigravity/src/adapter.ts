import type { AgentAdapter } from '@sessionport/core';

import { readAntigravitySession } from './read.ts';
import { countAntigravityTarget, writeAntigravitySession } from './write.ts';

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  sourcePrefixes: ['antigravity', 'agy'],
  supportsInPlaceRewrite: false,
  read(input: string) {
    return readAntigravitySession(input);
  },
  write(bundle, opts) {
    return writeAntigravitySession(bundle, opts);
  },
  countTarget(outcome, opts) {
    return countAntigravityTarget(outcome, opts);
  },
};
