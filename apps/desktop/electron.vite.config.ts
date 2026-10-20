import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 构建产物：out/main, out/preload, out/renderer
export default defineConfig({
  main: {
    // workspace 内的 @sessionport/* 是源码包，必须让 electron-vite 打进去
    plugins: [externalizeDepsPlugin({ exclude: ['@sessionport/core', '@sessionport/adapter-kimi-code', '@sessionport/adapter-claude-code', '@sessionport/adapter-command-code', '@sessionport/adapter-dsh', '@sessionport/adapter-codex', '@sessionport/adapter-opencode', '@sessionport/adapter-cursor', '@sessionport/adapter-qoder', '@sessionport/adapter-workbuddy'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});