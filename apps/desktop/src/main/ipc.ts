import { app, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';

import { AppError } from './errors.ts';
import { detectHomes, listSessions, officialImports, officialVerify, pathsInfo, previewMigration, readSession, readableAgents, runMigration, writableAgents } from './services.ts';

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
    slim: z.boolean().optional(),
    compact: z.boolean().optional(),
    compactBudgetChars: z.number().int().positive().optional(),
    compactKeepRecentSteps: z.number().int().positive().optional(),
    summaryCommand: z.string().optional(),
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
    slim: z.boolean().optional(),
    compact: z.boolean().optional(),
    compactBudgetChars: z.number().int().positive().optional(),
    compactKeepRecentSteps: z.number().int().positive().optional(),
    summaryCommand: z.string().optional(),
  }),
  'app:capabilities': z.object({}).default({}),
  'app:paths': z.object({}).default({}),
  'app:openPath': z.object({ key: z.enum(['kimi', 'claude', 'commandCode', 'dsh', 'codex', 'opencode', 'registry']) }),
  'official:list': z.object({}).default({}),
  'official:verify': z.object({ target: z.enum(['zcode', 'qoder', 'cursor']), cwd: z.string().optional(), title: z.string().optional() }),
  'official:open': z.object({ target: z.enum(['zcode', 'qoder', 'cursor']) }),
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
      slim: input.slim,
      compact: input.compact,
      compactBudgetChars: input.compactBudgetChars,
      compactKeepRecentSteps: input.compactKeepRecentSteps,
      summaryCommand: input.summaryCommand,
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
  ipcMain.handle('official:list', async () => wrap(() => officialImports()));
  ipcMain.handle('official:verify', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['official:verify'].parse(payload);
    return officialVerify(input.target, { cwd: input.cwd, title: input.title });
  }));
  ipcMain.handle('official:open', async (_event, payload: unknown) => wrap(() => {
    const input = channelSchemas['official:open'].parse(payload);
    const appName = input.target === 'zcode' ? 'ZCode' : input.target === 'qoder' ? 'Qoder CN' : 'Cursor';
    return new Promise<{ opened: boolean }>((resolve) => {
      const child = spawn('open', ['-a', appName], { stdio: 'ignore' });
      child.on('exit', (code) => resolve({ opened: code === 0 }));
      child.on('error', () => resolve({ opened: false }));
    });
  }));
  ipcMain.handle('app:paths', async () => wrap(() => {
    const info = pathsInfo();
    return { ...info, version: app.getVersion(), electron: process.versions.electron ?? '' };
  }));
  ipcMain.handle('app:openPath', async (_event, payload: unknown) => wrap(async () => {
    const input = channelSchemas['app:openPath'].parse(payload);
    const info = pathsInfo();
    const target = input.key === 'registry' ? info.registryDir : info.homes[input.key]?.path;
    if (!target) throw new AppError('path.unknown', '未知目录: ' + input.key, { key: input.key });
    if (!existsSync(target)) throw new AppError('path.notFound', '目录不存在: ' + target, { path: target });
    const error = await shell.openPath(target);
    if (error) throw new AppError('path.openFailed', error, { message: error });
    return { opened: target };
  }));
}

interface IpcFailure {
  ok: false;
  error: string;
  code?: string;
  params?: Record<string, unknown>;
}

async function wrap<T>(run: () => Promise<T> | T): Promise<{ ok: true; data: T } | IpcFailure> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        ...(error.params === undefined ? {} : { params: error.params }),
      };
    }
    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => (issue.path.length > 0 ? issue.path.join('.') + ': ' : '') + issue.message)
        .join('; ');
      return {
        ok: false,
        error: '请求参数不合法: ' + details,
        code: 'ipc.invalidPayload',
        params: { issues: details },
      };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type IpcChannel = Channel;