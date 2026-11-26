import { resolve } from 'node:path';

import type { AgentAdapter } from '@sessionport/core';

import { readKimiBundle } from './read.ts';

export const kimiCodeAdapter: AgentAdapter = {
  id: 'kimi-code',
  displayName: 'Kimi Code',
  sourcePrefixes: ['kimi'],
  read(input: string) {
    return readKimiBundle(resolve(input));
  },
};
