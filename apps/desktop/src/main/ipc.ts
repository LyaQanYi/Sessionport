import { app, ipcMain, shell } from 'electron';
import { z } from 'zod';

import { detectHomes, listSessions, pathsInfo, previewMigration, readSession, readableAgents, runMigration, writableAgents } from './services.ts';

const agentSchema = z.enum(['claude-code', 'command-code', 'dsh', 'codex', 'opencode', 'kimi-code']);

const channelSchemas = {
  'sessions:list': z.object({}).default({}),
  'sessions:read': z.object({
    agent: agentSchema,
    nativePath: z.string().optional(),
    sessionId: z.string().optional(),
    limit: z.number().int().positive().max(2000).optional(),
  }),
  'migrate:preview': z.object({
    agent: agentSchema,
    nativePath: z.string().optional(),
    sessionId: z.string().optional(),
    target: agentSchema,
    home: z.string().optional(),
    model: z.string().optional(),
    register: z.boolean().optional(),
    includeChildren: z.boolean().optional(),
    stateHome: z.string().optional(),
    onDiverged: z.enum(['auto', 'force', 'fork']).optional(),
  }),
  'migrate:run': z.object({
    agent: agentSchema,
    nativePath: z.string().optional(),
    sessionId: z.string().optional(),
    target: agentSchema,
    register: z.boolean().optional(),
    includeChildren: z.boolean().optional(),
    home: z.string().optional(),
    model: z.string().optional(),
    stateHome: z.string().optional(),
    onDiverged: z.enum(['auto', 'force', 'fork']).optional(),
  }),
  'app:capabilities': z.object({}).default({}),
  'app:paths': z.object({}).default({}),
  'app:openPath': z.object({ key: z.enum(['kimi', 'claude', 'commandCode', 'dsh', 'codex', 'opencode', 'registry']) }),
} as const;

type Channel = keyof typeof channelSchemas;

/** 每个 IPC handler 先 zod 校验，再执行；错误统一转成 { ok:false, error } */
export function registerIpc(): void {
  ipcMain.handle('sessions:list', async () => wrap(() => listSessions()));
  ipcMain.handle('sessions:read', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['sessions:read'].parse(payload);
    return readSession(input.agent, { nativePath: input.nativePath, sessionId: input.sessionId }, input.limit);
  }));
  ipcMain.handle('migrate:preview', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['migrate:preview'].parse(payload);
    return previewMigration(input.agent, { nativePath: input.nativePath, sessionId: input.sessionId }, input.target, {
      home: input.home,
      model: input.model,
      register: input.register,
      includeChildren: input.includeChildren,
      stateHome: input.stateHome,
      onDiverged: input.onDiverged,
    });
  }));
  ipcMain.handle('migrate:run', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['migrate:run'].parse(payload);
    return runMigration(input.agent, { nativePath: input.nativePath, sessionId: input.sessionId }, input.target, {
      register: input.register,
      includeChildren: input.includeChildren,
      home: input.home,
      model: input.model,
      stateHome: input.stateHome,
      onDiverged: input.onDiverged,
    });
  }));
  ipcMain.handle('app:capabilities', async () => wrap(() => ({
    readable: readableAgents(),
    writable: writableAgents(),
    homes: detectHomes(),
  })));
  ipcMain.handle('app:paths', async () => wrap(() => {
    const info = pathsInfo();
    return { ...info, version: app.getVersion(), electron: process.versions.electron ?? '' };
  }));
  ipcMain.handle('app:openPath', async (_event, payload: unknown) => wrap(async () => {
    const input = channelSchemas['app:openPath'].parse(payload);
    const info = pathsInfo();
    const target = input.key === 'registry' ? info.registryDir : info.homes[input.key]?.path;
    if (!target) throw new Error('未知目录: ' + input.key);
    if (!existsSync(target)) throw new Error('目录不存在: ' + target);
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { opened: target };
  }));
}

async function wrap<T>(run: () => Promise<T> | T): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type IpcChannel = Channel;