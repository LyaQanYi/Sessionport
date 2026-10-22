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
      // 冒烟时可选：切到某个导航页 / 打开第一个或指定标题的会话 / 再点进第一个子代理
      const nav = process.env['SESSIONPORT_SMOKE_NAV'];
      const openFirst = process.env['SESSIONPORT_SMOKE_OPEN_FIRST'] === '1';
      const openMatch = process.env['SESSIONPORT_SMOKE_OPEN_MATCH'];
      const openChild = process.env['SESSIONPORT_SMOKE_OPEN_CHILD'] === '1';
      const searchText = process.env['SESSIONPORT_SMOKE_SEARCH'];
      if (nav || openFirst || openMatch || searchText) {
        try {
          if (searchText !== undefined && searchText.length > 0) {
            // 会话列表是虚拟滚动的：先用搜索框把目标会话筛出来
            await window.webContents.executeJavaScript(
              `(() => {
                const input = document.querySelector('header input, input');
                if (!input) return false;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, ${JSON.stringify(searchText)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()`,
            );
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
          // 会话列表是异步加载的：轮询等待目标元素出现（最多 8 秒）
          const rowSelector = '[data-session-row]:not([disabled])';
          let clicked = false;
          for (let attempt = 0; attempt < 80 && !clicked; attempt += 1) {
            clicked = (await window.webContents.executeJavaScript(
              `(() => {
                const navView = ${JSON.stringify(nav ?? '')};
                if (navView) {
                  const target = document.querySelector('[data-nav="' + navView + '"]');
                  if (target) { target.click(); return true; }
                  return false;
                }
                const rows = Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)}));
                const wanted = ${JSON.stringify(openMatch ?? '')};
                const row = wanted.length > 0
                  ? rows.find((candidate) => (candidate.textContent || '').includes(wanted))
                  : rows[0];
                if (row) { row.click(); return true; }
                return false;
              })()`,
            )) as boolean;
            if (!clicked) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!clicked) console.error('[smoke] target not found:', nav ?? openMatch ?? rowSelector);
          await new Promise((resolve) => setTimeout(resolve, 1800));

          if (clicked && openChild) {
            let childClicked = false;
            for (let attempt = 0; attempt < 40 && !childClicked; attempt += 1) {
              childClicked = (await window.webContents.executeJavaScript(
                `(() => {
                  const child = document.querySelector('[data-child-row]');
                  if (child) { child.click(); return true; }
                  return false;
                })()`,
              )) as boolean;
              if (!childClicked) await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!childClicked) console.error('[smoke] child row not found');
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
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