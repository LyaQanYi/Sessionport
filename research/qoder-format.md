# Qoder CN 会话格式（macOS，2026-10-20）

对象：Qoder CN 0.4.8（`/Applications/Qoder CN.app`，product.json `qoder-cn`，Electron 43.1.1）。
内置 qodercli 1.1.69、`@qoder-ai/qoder-cn-agent-sdk` 1.0.52（package.json 内 name 为 `@ali/qodercn-agent-sdk-next`）。

标记约定：**[实测]** 本机读到/跑通；**[推测]** 从 asar 代码或单一样本推断。

---

## 1. 存储位置 [实测]

```text
~/.qoder-cn/projects/<projectKey>/<sessionId>.jsonl          # 主会话
~/.qoder-cn/projects/<projectKey>/<sessionId>/subagents/agent-<agentId>.jsonl
~/.qoder-cn/projects/<projectKey>/<sessionId>/subagents/agent-<agentId>.meta.json
~/.qoder-cn/projects/<projectKey>/<sessionId>/subagents/task-*.json
```

- **没有 session 索引或 DB**：`~/.qoder-cn` 下没有 sqlite；SDK 的 `listSessions` 直接扫 `projects/*`。 [实测：反编译 + 运行 SDK]
- `projectKey` 规则（SDK 的 `N(cwd)`）[实测]：

```js
key = cwd.replace(/[^a-zA-Z0-9]/g, '-')
if (key.length > 200) key = key.slice(0, 200) + '-' + Math.abs(djb2(cwd)).toString(36)
```

- `sessionId` 必须是 UUID；SDK 的 `ke()` 用严格 UUID 正则，文件名不符合的文件不会被列出。
- 本机现有 3 个 UUID 会话，分布在 2 个项目目录；另有若干空项目目录（没有 jsonl）。

## 2. 行类型 [实测]

| type | 作用 | IR 映射 |
| --- | --- | --- |
| `workspace-directories` | 首行/续聊行，`directories:[cwd]` | 会话 cwd |
| `runtime-config` | `model`（本机全是 `qfmodel`）、reasoningEffort/contextWindow | 会话 model |
| `worktree-state` | worktree session | 忽略 |
| `user`（human） | `message.content:[{type:'text'}]` + `humanInput/origin/promptId` | `message(user)` |
| `user`（tool_result） | `message.content:[{type:'tool_result',tool_use_id,content}]` + `toolUseResult/sourceToolAssistantUUID` | `tool_result` |
| `assistant` | 每个 content block 一行：thinking / text / tool_use | reasoning / message / tool_call |
| `attachment` | `skill_listing` / `critical_system_reminder` / `agent_listing_delta` / `task_reminder` | 跳过（notice） |
| `active-leaf` | `leafUuid` + `explicit`，标记当前分支叶子 | 分支选择 |
| `last-prompt` | 最后一次用户输入，列表标题用 | meta/title |
| `custom-title` / `ai-title` | 用户重命名 / AI 标题；本机现有文件没有，但 SDK 会写/读 | 标题 |
| `system` (compact_boundary) / `progress` | 压缩边界 / 流式进度 | boundary(compact) / 跳过 |

时间戳：user/assistant 是 **ISO 字符串**；`active-leaf`/`runtime-config` 是 **毫秒数字**。

## 3. 分支模型（关键）[实测]

- 每条 user/assistant/attachment 有 `uuid` 和 `parentUuid`，构成一棵树。
- 每个 assistant content block 单独一行，**共享同一个 `message.id`**（如 `chatcmpl-...`），content 数组里只有一个 block。
- `tool_result` 的 `parentUuid` 指向包含对应 `tool_use` 的那一行，**不是上一行**。并行工具调用会形成多个旁支。
- `active-leaf` 在每轮 assistant 分组后、每个 tool_result 后写一行；最后一行通常是 `active-leaf`（或续聊时的 runtime-config/active-leaf）。
- **多个 `last-prompt`**：用户每轮都会追加；标题取**最后一个**（SDK `Kn()` 顺序覆盖）。
- 读取时从最后一个 `active-leaf` 沿 parentUuid 回溯，再把「parent 在当前分支里」的 tool_result 旁支补回来，最后按文件顺序排序。这样既剪掉旧分支，又不丢并行工具结果。

样例（裁剪）：

```json
{"type":"workspace-directories","sessionId":"692991a1-...","directories":["/Users/me/vscodefork"]}
{"type":"runtime-config","sessionId":"692991a1-...","model":"qfmodel","reasoningEffort":null,"contextWindow":null,"generation":null,"timestamp":1792129210050}
{"type":"user","uuid":"88c08467-...","timestamp":"2026-10-16T05:40:10.956Z","message":{"role":"user","content":[{"type":"text","text":"看看 VSCode 的自动补全..."}]},"humanInput":{"text":"...","mode":"prompt"},"origin":{"kind":"human"},"parentUuid":null,"sessionId":"692991a1-...","cwd":"/Users/me/vscodefork","version":"1.1.69","entrypoint":"cli"}
{"type":"assistant","uuid":"d6da65bf-...","parentUuid":"367053f8-...","timestamp":"2026-10-16T05:40:40.132Z","message":{"id":"chatcmpl-c4367f04-...","role":"assistant","model":"qfmodel","content":[{"type":"tool_use","id":"call_607e67823eaa4d03a245d6ba","name":"Bash","input":{"command":"ls"}}]},"requestTokenAnchor":{"request":"...","response":"...","requestId":"..."}}
{"type":"user","uuid":"7ec3ccf8-...","parentUuid":"d6da65bf-...","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_607e67823eaa4d03a245d6ba","content":"CONTRIBUTING.md\n..."}]},"toolUseResult":{"kind":"completed","stdout":"..."},"sourceToolAssistantUUID":"d6da65bf-...","promptId":"..."}
{"type":"active-leaf","sessionId":"692991a1-...","leafUuid":"7ec3ccf8-...","explicit":false,"timestamp":1792129211058}
```

## 4. Qoder 如何列出会话 [实测]

SDK 的 `listSessions()`（asar 内函数 `il`）：

1. `Oe()` = `<configDir>/projects`（`QODERCN_CONFIG_DIR` 可覆盖 configDir，默认 `~/.qoder-cn`）。
2. 遍历所有项目目录，读每个 `*.jsonl`。
3. 对每份文件扫全量行，取：
   - `custom-title` / `ai-title` → 标题（custom 优先）
   - 任意行上的 `lastPrompt`（最后一个生效）→ 标题
   - `summary` 字段 → 标题
   - 首条真实 user 文本 → 标题兜底
4. `updatedAt = mtime`；按 mtime 倒序；同 sessionId 只留最新。
5. 没有任何标题/首问的文件不返回（`Kn()` 返回 undefined）。

**没有 SQLite/索引文件可查**；桌面端和 CLI 走同一套 SDK。

本机实测：adapter 的 `listQoderSessions` 与真实 SDK 输出逐条一致：

| sessionId | SDK summary | adapter title | cwd |
| --- | --- | --- | --- |
| `80f03e81…` | 需要中英文对照 | 需要中英文对照 | /Users/…/Qoder/2026-10-16/80f03e81 |
| `692991a1…` | 有用户反映过吗 | 有用户反映过吗 | /Users/…/vscodefork |
| `c9de23df…` | 帮我看看 VSCode 的自动补全… | 同左 | /Users/…/vscodefork |

## 5. 写入格式 [实测 + 构造]

`writeQoderSession(bundle,{home?,dryRun?,sessionId?,cwd?,model?,title?,overwrite?})` 生成：

1. `workspace-directories`（directories=[cwd]）
2. `runtime-config`（model 默认 `qfmodel`）
3. `worktree-state`（null）
4. `custom-title`（有 title 时）
5. 按 IR 事件：
   - user → user 行 + `active-leaf`
   - reasoning(plain) → assistant `thinking` block
   - assistant text → assistant `text` block
   - tool_call → assistant `tool_use` block，记录 callId→uuid
   - tool_result → user `tool_result` 行，parent 指回 tool_use 行，`sourceToolAssistantUUID` 同值；每个结果后 `active-leaf`
6. 同一轮 assistant block 共用一个 `message.id`；每个 block 一行、uuid 链式 parent。
7. 结尾 `last-prompt` + 最终 `active-leaf`。

写入策略：

- 默认 **只新增**；目标文件存在直接抛错。`overwrite:true` 时先 `rename` 成 `.bak-<ms>` 再写。
- 临时文件 + rename 原子落盘，文件 mode 0600，目录自动创建。
- `dryRun:true` 只返回 rows/path，不建目录不写文件。
- 模型固定 `qfmodel`（Qoder CN 只认自己的模型 id），源模型不同记 loss。
- synthetic user / synthetic assistant / boundary / opaque reasoning / 图片内联数据 / 子代理 → loss 或文本化。

## 6. 验证（本机真实证据）[实测]

1. **reader 回读**：117 条事件的 WorkBuddy 会话写入后，`readQoderSession` 读回 117 条，逐事件比对 `verifyQoderRoundTrip` 全通过。
2. **真实 Qoder SDK**（同一份 asar 内代码，用 Electron 的 Node 跑）：
   ```sh
   ELECTRON_RUN_AS_NODE=1 '/Applications/Qoder CN.app/Contents/MacOS/Qoder CN' script.mjs
   ```
   - 临时 home：`listSessions()` 返回 1 条，`getSessionMessages()` 返回 117 条。
   - 真实 home 写入新会话 `78e4368e-e67f-4d12-92ea-b5e4b69bfd4b`（425272 bytes）后：
     - `listSessions()` 第 1 条就是它：summary=分析项目架构、cwd=…/neko-auth-platform、created 正确。
     - `getSessionInfo()`：`customTitle=分析项目架构`、`firstPrompt=分析一下项目架构`、117 条消息。
     - `getSessionMessages()`：117 条，首条 user、末条 assistant text。
3. 说明：桌面端主进程 import 的就是这个 SDK；因此 SDK 能列/能读 = **app 会话列表可见**。GUI 未强启，人工确认步骤见 §8。

## 7. CLI / resume [实测 + 推测]

- 本机 **没有** `qoderclicn` / `qodercn` 在 PATH；`~/.qoder-cn/entry/qoder-cn` 是 dispatcher，会提示 CLI not installed。
- App 内 qodercli 以 worker runtime 方式运行（SDK runtime-manifest：`defaultTransport: "worker"`，URL 模板下载），没有可直接执行的独立二进制。
- SDK 的 `buildArgs()` 明确支持 `--resume <sessionId>`、`--continue`、`--session-id` [实测，asar 反编译]。
- **[推测]** 安装官方 Qoder CN CLI 后，`qoderclicn --resume <uuid>` 可在终端续聊同一会话；未安装前只能用 IDE/App。
- adapter 的 `resumeHint` 写成 `qodercn --resume <uuid>`，仅作提示。

## 8. 人工确认步骤（GUI）

1. 打开 Qoder CN。
2. 打开（或切换）项目 `/Users/lyaqanyi/Documents/GitHub/neko-auth-platform`。
3. 会话列表应出现标题「分析项目架构」，首条用户消息「分析一下项目架构」。
4. 双击进入，应看到 13 条 user/assistant 文本、20 条 thinking、42 组工具调用/结果（Read/Bash/Grep/Glob 等）。
5. 若列表没刷新：退出并重开 Qoder CN（[推测] 会话列表可能按项目缓存，需重进项目）。

## 9. 丢失项

| 源端内容 | 目标端处理 |
| --- | --- |
| attachment（skill/系统提醒/agent 列表） | 不写；目标端自己注入 |
| synthetic user / 被打断的 assistant | 丢弃（loss） |
| boundary（fork/undo/compact/cancel） | 丢弃（loss） |
| opaque reasoning | 丢弃（Qoder 只吃明文 thinking） |
| 子代理 transcript | reader 读进 IR children；writer 丢弃（loss） |
| 图片二进制 | 只保留 `image: ref` 文本 |
| 源模型 id | 固定 `qfmodel`（loss） |
| token usage / cost / requestTokenAnchor 语义 | 生成占位 hash，不保留统计 |

## 10. 坑

1. **没有索引**：不要找 DB；直接扫目录。文件 mtime 就是排序依据。
2. **文件名必须 UUID**；非 UUID 文件会被 Qoder 忽略。
3. **多个 last-prompt**：取最后一个，否则标题错。
4. **active-leaf 可能指向 attachment**：回溯链要包含 attachment 行，否则首条 user 会断。
5. **tool_result 的 parent 不是上一行**：按「上一行」重建树会丢并行工具结果。
6. **同一 message.id 多行**：每个 block 一行；直接按行读即可，但写的时候要共用 id。
7. **custom-title 行位置不定**：可能在头部（导入）或尾部（重命名）；标题要同时扫头尾。
8. **写真实目录前先 dryRun**：只新增文件；覆盖要先备份；不要动已有 jsonl。
9. **子代理是独立文件**：主 jsonl 里只有 Agent tool_use，没有子代理正文；需要单独读 `subagents/agent-*.jsonl` + `.meta.json`。
10. **时间戳两种单位**：ISO 字符串 vs 毫秒数字，统一 ISO 时别把 1792… 当秒。

## 11. 复现命令

```sh
# 离线 fixture + 真实数据门控（含 WorkBuddy -> Qoder 端到端；只写临时 home）
SESSIONPORT_WORKBUDDY_HOME="$HOME/.workbuddy" \
SESSIONPORT_QODER_HOME="$HOME/.qoder-cn" \
  node --test packages/adapters/qoder/test/*.test.ts

# 直接 import：写 + reader 读回（dryRun 先看目标）
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { writeQoderSession, readQoderSession } from './packages/adapters/qoder/src/index.ts';
const bundle = JSON.parse(readFileSync('.tmp/ir.json', 'utf8'));
const dry = await writeQoderSession(bundle, { home: '.tmp/qoder-out', dryRun: true });
console.log('target', dry.path, 'rows', dry.rows.length);
const result = await writeQoderSession(bundle, { home: '.tmp/qoder-out' });
const back = await readQoderSession(result.sessionId, { home: '.tmp/qoder-out' });
console.log('events', back.root.events.length, 'title', back.root.meta.title);
"
```

Qoder 自己的 SDK（app.asar 内，Electron 的 Node 可读 asar）：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/Qoder CN.app/Contents/MacOS/Qoder CN' -e "
const sdk = await import('/Applications/Qoder CN.app/Contents/Resources/app.asar/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/index.js');
console.log(await sdk.listSessions({ limit: 10 }));
"
```
