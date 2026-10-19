import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerIpc } from './ipc.ts';

const dirname = fileURLToPath(new URL('.', import.meta.url));

function createWindow(): void {
  const smoke = process.env['SESSIONPORT_SMOKE'] === '1';
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: !smoke,
    title: 'sessionport',
    backgroundColor: '#0b0c0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // renderer 不允许自己开新窗口，外链交给系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(dirname, '../renderer/index.html'));

  // CI / 本地冒烟：不开窗口，等页面加载成功后退出
  if (smoke) {
    const timer = setTimeout(() => {
      console.error('[smoke] timeout waiting for renderer');
      app.exit(1);
    }, 20_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      console.log('[smoke] renderer loaded');
      app.exit(0);
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      console.error('[smoke] load failed:', code, description);
      app.exit(1);
    });
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});