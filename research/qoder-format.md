# Qoder CN 会话格式（macOS，2026-10-20）

对象：Qoder CN 0.4.8（`/Applications/Qoder CN.app`，product.json `qoder-cn`，Electron 43.1.1）。
内置 qodercli 1.1.69、`@qoder-ai/qoder-cn-agent-sdk` 1.0.52（package.json 内 name 为 `@ali/qodercn-agent-sdk-next`）。

标记约定：**[实测]** 本机读到/跑通；**[推测]** 从 asar 代码或单一样本推断。

> 2026-10-28 补充：核对真实子代理样本（`~/.qoder-cn/projects/-Users-lyaqanyi-Documents-GitHub-vscodefork/c9de23df-ba7f-4a33-9680-72496730b4f5/subagents/`）、
> asar 内 SDK 读取代码，并实现 writer/verify 的子代理写回。新增 §5，其余章节顺延。

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
- 2026-10-20 核对时本机有 3 个 UUID 会话，分布在 2 个项目目录；另有若干空项目目录（没有 jsonl）。
- 子代理文件在 `<sessionId>/` 子目录里，`listSessions` 只扫项目目录顶层的 `*.jsonl`，所以子代理文件不会变成独立会话。

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

## 5. 子代理（subagents）格式 [实测]

真实样本：`~/.qoder-cn/projects/-Users-lyaqanyi-Documents-GitHub-vscodefork/c9de23df-ba7f-4a33-9680-72496730b4f5/subagents/`
（qodercli 1.1.69，2026-10-16，会话里有 2 个 `Explore` 子代理）。

### 5.1 文件与命名

```text
<sessionId>/subagents/agent-aExplore-3e452d8269ce3c04.jsonl       197726 B, mode 0600
<sessionId>/subagents/agent-aExplore-3e452d8269ce3c04.meta.json     168 B, mode 0644
<sessionId>/subagents/task-a2b53a0a6938f8f9e.json                   878 B
```

- `agentId` 就是文件名里 `agent-` 与 `.jsonl` 之间的部分，**没有单独的 agentId 字段**。
  实测形如 `aExplore-<16 位十六进制>`：`a` + agentType + `-` + 16 hex。
  SDK 只要求 `agent-` 前缀 + `.jsonl` 后缀（`agent-<id>` 的 id 原样作为 agentId），
  所以 UUID 形式的 id 也能被读（我们的 writer 在源端没有 Qoder 风格 id 时沿用 nativeSessionId）。
- `<sessionId>/` 目录下还可以有 `compression-v2/`（压缩快照），与子代理无关。
- 子代理文件不会出现在 `listSessions` 里（它只扫项目目录顶层的 `*.jsonl`）。

### 5.2 meta.json（SDK 读取关联信息的唯一来源）

真实内容（原样）：

```json
{"agentType":"Explore","toolUseId":"call_95ffccbc6a0c484585487d82","description":"Explore core inline completions vs suggest","invocationName":"Explore","color":"cyan"}
```

- `toolUseId`：父会话里触发该子代理的 `Agent` tool_use id；**SDK 用它填 `parent_tool_use_id`**。
- `description`：展示用描述（父会话 `Agent` 调用的 `input.description`）。
- `agentType` / `invocationName`：子代理类型（本例 `Explore`；父调用 `input.subagent_type` 同值）。
- `color`：UI 颜色（`cyan`），不影响读取。
- **没有** `agentId`、`requestShape`、`requestNonInteractive`、`spawnDepth`（这些是 Claude 的 meta 字段）。
- SDK 还识别可选的 `parentAgentId`（嵌套子代理的父 agent），IR 不建模。

SDK 源码（`.tmp/qoder-sdk-index.js`，从 app.asar 提取）：

```js
async function Jc(n){ // read meta
  const t = JSON.parse(await readFile(n.replace(/\.jsonl$/, ".meta.json")));
  return {
    parentToolUseId: typeof t.toolUseId === "string" && t.toolUseId.length > 0 ? t.toolUseId : null,
    parentAgentId:  typeof t.parentAgentId === "string" && t.parentAgentId.length > 0 ? t.parentAgentId : null
  };
}
```

### 5.3 agent-<id>.jsonl 的行格式

样本 60 行（user 25 / assistant 35），**只有 user/assistant**，没有
`workspace-directories` / `runtime-config` / `worktree-state` / `active-leaf` /
`last-prompt` / `custom-title`。

每条用户/助手行共同字段：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `sessionId` | **父会话 UUID** | 不是 agentId |
| `agentId` | 文件名里的 agentId | 全行一致 |
| `isSidechain` | `true` | 每行都有 |
| `parent_tool_use_id` | 父 `Agent` 的 tool_use id | 与 meta.toolUseId 相同 |
| `cwd` / `version` / `gitBranch` | 父会话同值 | |
| `userType` / `entrypoint` | `external` / `cli` | |

- **首条 user 的 `message.content` 是字符串**（不是 block 数组）：

  ```json
  {"type":"user","uuid":"788fe4c0-...","timestamp":"2026-10-16T05:35:34.375Z","message":{"role":"user","content":"Context: this repo ..."},"origin":{"kind":"human"},"businessModelKey":"qfmodel","humanInput":{"text":"...","mode":"prompt"},"promptId":"c9de23df-ba7f-4a33-9680-72496730b4f5","sessionId":"c9de23df-...","parent_tool_use_id":"call_95ff...","isSidechain":true,"agentId":"aExplore-3e452d8269ce3c04","cwd":"/Users/.../vscodefork","userType":"external","entrypoint":"cli","version":"1.1.69","gitBranch":"main"}
  ```

- assistant 行**额外带 `session_id`（snake_case）**，其余与主会话 assistant 行同构
  （`message.id` 每轮共用一个，content 里只有一个 block，`requestTokenAnchor` 占位 hash）。
- tool_result 行与主会话同构：`message.content:[{type:'tool_result',tool_use_id,content}]` +
  `toolUseResult:{kind:'completed'}` + `sourceToolAssistantUUID`；`parentUuid` 指向 tool_use 行。
- 样本里 **25/25 个 user 行的 `promptId` 都是父 sessionId**（子代理没有自己的 prompt id）。
- `parentUuid` 从 null 开始线性成链；工具结果行指向对应 tool_use 行（父链可回溯）。

### 5.4 task-*.json 是什么，必需吗

```json
{"taskId":"a2b53a0a6938f8f9e","sessionId":"c9de23df-...","executionId":2000000001,"agentId":"aExplore-3e452d8269ce3c04","agentType":"Explore","resolvedModel":"qfmodel","description":"Explore core inline completions vs suggest","invocationName":"Explore","parentToolUseId":"call_95ff...","outputPath":"/var/folders/.../tasks/a2b53a0a6938f8f9e.output","transcriptPath":".../subagents/agent-aExplore-3e452d8269ce3c04.jsonl","completionBehavior":"notify","status":"running","summary":"Agent \"...\" started","createdAt":1792128934352,"updatedAt":1792128934372}
```

- 这是 CLI 的**运行时任务登记**（`outputPath` 指向 `/var/folders` 临时目录，`status` 停在 `running`），
  不是会话内容。
- SDK 的 `listSubagents()` / `getSubagentMessages()` **完全不读 task-*.json**：
  前者递归扫 `agent-*.jsonl`，后者只读 `.jsonl` + `.meta.json`。
- 结论：**写子代理不需要 task-*.json**；我们的 writer 不写，并在损失清单里说明。

### 5.5 SDK 如何读子代理（决定写入的最小要求）

asar 内函数（`.tmp/qoder-sdk-index.js`）：

```js
// listSubagents(sessionId, {dir})
async function dl(n, e) {
  ...
  for (const s of projectDirs) {
    const r = await dr(join(s, n, "subagents"));   // 递归找 agent-*.jsonl
    return [...new Set(r.map(i => i.agentId))];     // agentId = name.slice(6, -6)
  }
}

// getSubagentMessages(sessionId, agentId, {dir})
async function Vc(filePath, sessionId, opts) {
  const [text, sidecar] = await Promise.all([
    readFile(filePath),
    Jc(filePath)                                    // meta.json: toolUseId / parentAgentId
  ]);
  const rows = text.split("\n").filter(Boolean).flatMap(parse).filter(lr); // 只认 type user/assistant + uuid
  const chain = pr(rows);                            // 从**最后一行**沿 parentUuid 回溯（不用 active-leaf）
  return chain.map(d => ({
    type: d.type, uuid: d.uuid,
    session_id: d.sessionId ?? sessionId,
    message: d.message,
    parent_tool_use_id: sidecar.parentToolUseId,     // 来自 meta.json
    parent_agent_id: sidecar.parentAgentId,
    ...
  }));
}
```

因此写子代理的最小要求：

1. `<sessionId>/subagents/agent-<agentId>.jsonl`：user/assistant 行带 `uuid`，`parentUuid` 成链；
   最后一行必须是想展示的分支末端（SDK 从最后一行回溯，**不需要 active-leaf**）。
2. `agent-<agentId>.meta.json`：至少 `toolUseId`（关联父调用）+ `agentType`/`description`（展示）。
3. 行内 `sessionId` 建议写父会话 id（SDK 缺省时才用参数补）；`agentId`/`isSidechain` 不是 SDK 硬要求，
   但真实数据每行都有，写入方应保持一致（verify 也按此检查）。

## 6. 写入格式 [实测 + 构造]

`writeQoderSession(bundle,{home?,dryRun?,sessionId?,cwd?,model?,title?,overwrite?,includeChildren?})` 生成：

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
- synthetic user / synthetic assistant / boundary / opaque reasoning / 图片内联数据 → loss 或文本化。

### 6.1 子代理写回（`includeChildren:true`）

对每个 `bundle.children` 写：

```text
<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
<projectDir>/<sessionId>/subagents/agent-<agentId>.meta.json
```

- **agentId**：优先沿用 `child.session.source.nativeSessionId`（Qoder→Qoder 稳定）；
  不满足 `^[A-Za-z0-9][A-Za-z0-9_-]*$`（≤64 字符）或同 bundle 冲突时，
  用 `sha256(child.id + nativeId + salt)` 前 17 位十六进制，冲突再加盐。
  真实 Qoder 的 `aExplore-<hex16>` 能原样沿用。
- **meta.json**（字段顺序对齐真实样本）：
  `{agentType, toolUseId?, description, invocationName}`
  - `agentType` = child `meta.profile`，缺省 `general-purpose`
  - `description` = child `meta.title`，缺省 `label` / agentType
  - `toolUseId` **只在主会话里确实存在对应 tool_use 时才写**（`viaToolCallId` 悬空则不写，
    否则 Qoder 会关联到不存在的调用）
  - 不写 `color`（UI 装饰，无真实来源）、不写 Claude 的 `requestShape/spawnDepth`；
  - 不写 `gitBranch`（IR 没有该字段；SDK 读取不依赖，父会话的 `gitBranch` 也不会自动继承）
- **行**：与 §5.3 一致
  - `sessionId` = 父会话 id；`agentId` + `isSidechain:true` 每行都有
  - 关联成功时每行带 `parent_tool_use_id`（= meta.toolUseId）
  - 首条 user 的 `message.content` 用字符串；tool_result 用 block 数组
  - assistant 行额外带 `session_id`（snake）
  - `promptId` 固定为父 sessionId
  - 不写任何控制行（`active-leaf` / `last-prompt` / `workspace-directories` …）
- **synthetic user**：主会话照旧丢弃（目标端会注入上下文）；**子代理保留**并写 `isMeta:true` +
  `origin.kind:'system'`（Qoder 不会给子代理注入任务提示，丢了首条 user 就没有任务描述；
  `isMeta` 让 reader 再读回时仍标记 synthetic）。
- 主会话 transcript **不变**（不会把子代理行混进主 jsonl）。
- 不写 `subagents/task-*.json`（运行时登记，见 §5.4）。
- 没有任何可写事件的空 child 跳过并记 `qoder.subagent-empty-skipped`（info）。
- `includeChildren:false`（默认）时仍记 `qoder.subagents-dropped` + `qoder.subagent-events-dropped`。
- CLI 的 `--include-children` 已经会透传给 Qoder（`packages/cli` 用通用 opts），
  但 `sessionport --help` 里该选项的说明仍只列 dsh/claude-code/command-code（本次约束未改 CLI 包）。

## 7. 验证（本机真实证据）[实测]

### 7.1 主会话

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
3. 说明：桌面端主进程 import 的就是这个 SDK；因此 SDK 能列/能读 = **app 会话列表可见**。GUI 未强启，人工确认步骤见 §9。

### 7.2 子代理（2026-10-28）

1. **单元测试**：`children.test.ts` 7 项（写 2 个 child → 文件/meta/行形状 → reader 读回 title/profile/via；
   `includeChildren:false` 的损失；dryRun；verify PASS/破坏 FAIL；overwrite 清理旧 child；空 child；agentId 冲突）。
   `pnpm test` 206 个测试 / 199 pass / 7 skip（原 199/192/7，新增 7）。
2. **真实 WorkBuddy → Qoder（隔离 home）**：源 `workbuddy:f022affa-196f-4fc4-a789-2439bdbd3a37`（682 事件、11 个子代理）
   → `.tmp/dogfood/qoder-children-home`（会话 `f0f0f0f0-2222-4222-8222-222222222222`）：
   - 写入 11 个 `agent-<uuid>.jsonl` + meta；主会话 661 个可回放事件（682 − 20 synthetic − 1 boundary）。
   - `readQoderSession` 读回 **11 个 children**，标题/profile 与源一致（10×`WorkBuddy session` + 1×摘要标题），
     `viaToolCallId` 全部为空（WorkBuddy reader 不提供 via）。
   - `verifyQoderSession` 104 项检查全 PASS（15 项主会话 + 1 项文件发现 + 每个 child 8 项：
     jsonl 可解析 / 有对话行 / isSidechain+agentId / parentUuid 链 / 父 sessionId / tool 配对 /
     meta 字段 / meta.toolUseId ↔ parent_tool_use_id ↔ 父会话 tool_use）。tool-pairing 只把
     orphan（结果找不到调用）判失败，missing（调用没有结果）只报告——真实源会话里确实有未完成调用。
     损失：`qoder.subagent-native-writeback x11`（info）、
     `qoder.subagent-unlinked x11`（warning，源端没有父 Agent 调用可关联）。
   - **真实 Qoder SDK**（`QODERCN_CONFIG_DIR` 指向隔离 home）：
     `listSessions` 找到父会话（summary=系统工程审查与事故响应演练）；`listSubagents` 返回 11；
     `getSubagentMessages` 返回 250 / 315 条（与写入事件数一致），`session_id`=父会话，`parentToolUseId`=null。
3. **真实 Qoder → Qoder（带关联）**：源 `c9de23df…`（2 个 `Explore` 子代理，meta.toolUseId 分别是
   `call_95ff…`/`call_feb5…`）→ `.tmp/dogfood/qoder-children-native-home`（会话 `f1f1f1f1-…`）：
   - `agentId` 原样沿用 `aExplore-3e452d8269ce3c04` / `aExplore-488e894370362532`；
   - verify PASS（`parent-tool-use (toolUseId=call_95ff…)`）；
   - **真实 SDK**：`listSubagents` 返回 2，`getSubagentMessages` 返回 60 / 105 条，
     `parentToolUseId` 分别为 `call_95ff…` / `call_feb5…`（meta 关联生效）。
4. **原生样本回归**：直接 `verifyQoderSession` 真实 `c9de23df…` 文件 PASS（2 个原生 child）；
   reader 现在能从 meta 读出标题/profile（之前只有首条 user 文本、无 profile）。

## 8. CLI / resume [实测 + 推测]

- 本机 **没有** `qoderclicn` / `qodercn` 在 PATH；`~/.qoder-cn/entry/qoder-cn` 是 dispatcher，会提示 CLI not installed。
- App 内 qodercli 以 worker runtime 方式运行（SDK runtime-manifest：`defaultTransport: "worker"`，URL 模板下载），没有可直接执行的独立二进制。
- SDK 的 `buildArgs()` 明确支持 `--resume <sessionId>`、`--continue`、`--session-id` [实测，asar 反编译]。
- **[推测]** 安装官方 Qoder CN CLI 后，`qoderclicn --resume <uuid>` 可在终端续聊同一会话；未安装前只能用 IDE/App。
- adapter 的 `resumeHint` 写成 `qodercn --resume <uuid>`，仅作提示。

## 9. 人工确认步骤（GUI）

1. 打开 Qoder CN。
2. 打开（或切换）项目 `/Users/example/Documents/GitHub/neko-auth-platform`。
3. 会话列表应出现标题「分析项目架构」，首条用户消息「分析一下项目架构」。
4. 双击进入，应看到 13 条 user/assistant 文本、20 条 thinking、42 组工具调用/结果（Read/Bash/Grep/Glob 等）。
5. 若列表没刷新：退出并重开 Qoder CN（[推测] 会话列表可能按项目缓存，需重进项目）。
6. **子代理（未做人工确认）**：进入带 `Agent` 调用的会话，看子代理是否在父会话下展开；
   SDK 的 `listSubagents`/`getSubagentMessages` 已验证可读，但桌面端 UI 是否展示、如何展示未人工确认。

## 10. 丢失项

| 源端内容 | 目标端处理 |
| --- | --- |
| attachment（skill/系统提醒/agent 列表） | 不写；目标端自己注入 |
| synthetic user / 被打断的 assistant | 主会话丢弃（loss）；**子代理保留 synthetic user**（否则首条任务提示丢失） |
| boundary（fork/undo/compact/cancel） | 丢弃（loss） |
| opaque reasoning | 丢弃（Qoder 只吃明文 thinking） |
| 子代理 transcript | `includeChildren:true` 写原生 `subagents/agent-*.jsonl` + meta；false 时记 `qoder.subagents-dropped` |
| 子代理的父调用关联 | 只有 `viaToolCallId` 能在主会话找到对应 tool_use 时才写 `meta.toolUseId`；否则 `qoder.subagent-unlinked`（warning） |
| `subagents/task-*.json` | 不写（运行时任务登记，SDK 读取子代理不依赖） |
| 子代理嵌套（meta.parentAgentId） | IR 只建模一层，不写回 |
| 图片二进制 | 只保留 `image: ref` 文本 |
| 源模型 id | 固定 `qfmodel`（loss） |
| token usage / cost / requestTokenAnchor 语义 | 生成占位 hash，不保留统计 |

## 11. 坑

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
11. **子代理首条 user 是字符串 content**：按 block 数组解析会丢掉整条任务提示。
12. **子代理没有 active-leaf**：SDK 从最后一行沿 parentUuid 回溯；写 `active-leaf` 反而多出非原生行。
13. **子代理 assistant 行有 `session_id`（snake）**：和 `sessionId`（camel）并存，验证时别把 snake 当成会话 id。
14. **子代理 meta.toolUseId 必须指向真实存在的主会话 tool_use**：悬空 id 会让 SDK 返回 `parent_tool_use_id` 但父会话里找不到调用。

## 12. 复现命令

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
const dry = await writeQoderSession(bundle, { home: '.tmp/qoder-out', dryRun: true, includeChildren: true });
console.log('target', dry.path, 'rows', dry.rows.length, 'children', dry.children.length);
const result = await writeQoderSession(bundle, { home: '.tmp/qoder-out', includeChildren: true });
const back = await readQoderSession(result.sessionId, { home: '.tmp/qoder-out' });
console.log('events', back.root.events.length, 'title', back.root.meta.title, 'children', back.children.length);
"

# 真实 WorkBuddy -> Qoder（隔离 home；11 个子代理）
node packages/cli/src/index.ts push 'workbuddy:f022affa-196f-4fc4-a789-2439bdbd3a37' \
  --to qoder --home .tmp/dogfood/qoder-children-home --include-children \
  --id f0f0f0f0-2222-4222-8222-222222222222
node packages/cli/src/index.ts verify --agent qoder --home .tmp/dogfood/qoder-children-home \
  --file .tmp/dogfood/qoder-children-home/projects/-Users-lyaqanyi-Documents-GitHub-neko-auth-platform/f0f0f0f0-2222-4222-8222-222222222222.jsonl
```

Qoder 自己的 SDK（app.asar 内，Electron 的 Node 可读 asar；用 `QODERCN_CONFIG_DIR` 指向隔离 home）：

```sh
QODERCN_CONFIG_DIR="$PWD/.tmp/dogfood/qoder-children-home" \
ELECTRON_RUN_AS_NODE=1 '/Applications/Qoder CN.app/Contents/MacOS/Qoder CN' -e "
const sdk = await import('/Applications/Qoder CN.app/Contents/Resources/app.asar/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/index.js');
const id = 'f0f0f0f0-2222-4222-8222-222222222222';
const dir = '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform';
console.log(await sdk.listSubagents(id, { dir }));
console.log((await sdk.getSubagentMessages(id, (await sdk.listSubagents(id, { dir }))[0], { dir })).length);
"
```
