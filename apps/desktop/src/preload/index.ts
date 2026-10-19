import { contextBridge, ipcRenderer } from 'electron';

/** 允许 renderer 调用的渠道白名单（主进程里还有 zod 校验兜底） */
const CHANNELS = new Set([
  'sessions:list',
  'sessions:read',
  'migrate:preview',
  'migrate:run',
  'app:capabilities',
]);

const api = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error('未授权的 IPC 渠道: ' + channel));
    return ipcRenderer.invoke(channel, payload ?? {});
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('sessionport', api);
