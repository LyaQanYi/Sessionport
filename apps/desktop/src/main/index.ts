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
    window.webContents.once('did-finish-load', async () => {
      clearTimeout(timer);
      console.log('[smoke] renderer loaded');
      // 冒烟时可选：自动点进第一个可读会话 / 切到某个导航页，便于给 UI 截图
      const nav = process.env['SESSIONPORT_SMOKE_NAV'];
      const openFirst = process.env['SESSIONPORT_SMOKE_OPEN_FIRST'] === '1';
      if (nav || openFirst) {
        try {
          // 会话列表是异步加载的：轮询等待目标元素出现（最多 8 秒）
          const selector = openFirst ? '[data-session-row]:not([disabled])' : 'nav button';
          let clicked = false;
          for (let attempt = 0; attempt < 80 && !clicked; attempt += 1) {
            clicked = (await window.webContents.executeJavaScript(
              `(() => {
                const navLabel = ${JSON.stringify(nav ?? '')};
                if (navLabel) {
                  const target = [...document.querySelectorAll('nav button')].find((el) => (el.textContent || '').includes(navLabel));
                  if (target) { target.click(); return true; }
                  return false;
                }
                const row = document.querySelector(${JSON.stringify(selector)});
                if (row) { row.click(); return true; }
                return false;
              })()`,
            )) as boolean;
            if (!clicked) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!clicked) console.error('[smoke] target not found:', nav ?? selector);
          await new Promise((resolve) => setTimeout(resolve, 1800));
        } catch (error) {
          console.error('[smoke] auto navigation failed:', String(error));
        }
      }

      const shot = process.env['SESSIONPORT_SMOKE_SHOT'];
      if (shot) {
        // 给 React 一点时间挂载并完成首屏数据加载，再截图
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try {
          const image = await window.webContents.capturePage();
          const { writeFile } = await import('node:fs/promises');
          await writeFile(shot, image.toPNG());
          console.log('[smoke] screenshot saved:', shot);
        } catch (error) {
          console.error('[smoke] screenshot failed:', String(error));
        }
      }
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