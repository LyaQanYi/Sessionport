import type { AgentAdapter } from '@sessionport/core';

import { readWorkBuddySession } from './read.ts';

export const workbuddyAdapter: AgentAdapter = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  sourcePrefixes: ['workbuddy', 'wb'],
  read(input: string) {
    return readWorkBuddySession(input);
  },
};
