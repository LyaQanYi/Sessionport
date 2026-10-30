#!/usr/bin/env node
/**
 * Qoder 原生校验探针：用 Qoder 桌面端自带的 SDK 读一个会话，证明「桌面 app 能看到」。
 *
 * 桌面端主进程 import 的就是这套 SDK，所以 listSessions/getSessionMessages/listSubagents 能读 =
 * app 的会话列表/子代理视图能看到。GUI 不需要启动。
 *
 * 用法（必须用 Qoder 自带的 Electron Node 跑，因为 SDK 在 app.asar 里）：
 *   Q='/Applications/Qoder CN.app/Contents/MacOS/Qoder CN'
 *   ELECTRON_RUN_AS_NODE=1 "$Q" scripts/qoder-sdk-probe.mjs <configDir> <sessionId>
 *
 * <configDir> 会被写进 QODERCN_CONFIG_DIR，用于隔离（矩阵写的是 .tmp 下的 home）。
 * 输出一行 JSON：{ sessionCount, found, firstSummary, messages, subagents }。
 */
import { pathToFileURL } from 'node:url';

const [configDir, sessionId] = process.argv.slice(2);
if (typeof configDir !== 'string' || typeof sessionId !== 'string') {
  process.stderr.write('用法: qoder-sdk-probe.mjs <configDir> <sessionId>\n');
  process.exit(2);
}
process.env.QODERCN_CONFIG_DIR = configDir;

const entry =
  process.env.QODER_SDK_ENTRY ??
  '/Applications/Qoder CN.app/Contents/Resources/app.asar/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/index.js';
const sdk = await import(pathToFileURL(entry).href);

const toArray = (value) =>
  Array.isArray(value)
    ? value
    : Array.isArray(value?.messages)
      ? value.messages
      : Array.isArray(value?.sessions)
        ? value.sessions
        : Array.isArray(value?.subagents)
          ? value.subagents
          : [];

const sessions = toArray(await sdk.listSessions());
const found = sessions.some((item) => item?.sessionId === sessionId || item?.id === sessionId);
const messages = toArray(await sdk.getSessionMessages(sessionId));
const subagents = toArray(await sdk.listSubagents(sessionId));
const first = sessions[0];
process.stdout.write(
  JSON.stringify({
    sessionCount: sessions.length,
    found,
    firstSummary: first?.summary ?? first?.customTitle ?? null,
    messages: messages.length,
    subagents: subagents.length,
  }) + '\n',
);
