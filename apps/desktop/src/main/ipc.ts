import { ipcMain } from 'electron';
import { z } from 'zod';

import { detectHomes, listSessions, previewMigration, readSession, readableAgents, runMigration, writableAgents } from './services.ts';

const agentSchema = z.enum(['claude-code', 'command-code', 'dsh', 'codex', 'opencode', 'kimi-code']);

const channelSchemas = {
  'sessions:list': z.object({}).default({}),
  'sessions:read': z.object({ agent: agentSchema, nativePath: z.string().min(1), limit: z.number().int().positive().max(2000).optional() }),
  'migrate:preview': z.object({ agent: agentSchema, nativePath: z.string().min(1), target: agentSchema }),
  'migrate:run': z.object({
    agent: agentSchema,
    nativePath: z.string().min(1),
    target: agentSchema,
    register: z.boolean().optional(),
    includeChildren: z.boolean().optional(),
    home: z.string().optional(),
    model: z.string().optional(),
  }),
  'app:capabilities': z.object({}).default({}),
} as const;

type Channel = keyof typeof channelSchemas;

/** 每个 IPC handler 先 zod 校验，再执行；错误统一转成 { ok:false, error } */
export function registerIpc(): void {
  ipcMain.handle('sessions:list', async () => wrap(() => listSessions()));
  ipcMain.handle('sessions:read', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['sessions:read'].parse(payload);
    return readSession(input.agent, input.nativePath, input.limit);
  }));
  ipcMain.handle('migrate:preview', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['migrate:preview'].parse(payload);
    return previewMigration(input.agent, input.nativePath, input.target);
  }));
  ipcMain.handle('migrate:run', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['migrate:run'].parse(payload);
    return runMigration(input.agent, input.nativePath, input.target, {
      register: input.register,
      includeChildren: input.includeChildren,
      home: input.home,
      model: input.model,
    });
  }));
  ipcMain.handle('app:capabilities', async () => wrap(() => ({
    readable: readableAgents(),
    writable: writableAgents(),
    homes: detectHomes(),
  })));
}

async function wrap<T>(run: () => Promise<T> | T): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type IpcChannel = Channel;
