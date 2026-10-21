# Cursor 会话格式（Cursor 3.25.9 / macOS）

> 标注约定：**[实测]** = 在本机真实数据/真实运行上观察到的；**[仓库]** = 从
> /Applications/Cursor.app 内未压缩 JS（out/main.js、out/vs/workbench/workbench.glass.main.js、
> extensions/cursor-agent-host/dist/main.js）读到的实现；**[推测]** = 由前两者推断但未单独验证。
>
> 本机环境：Cursor 3.25.9（Electron 42.10.0，glass UI，`storage.json` 里 `glassMode: true`）、
> cursor-agent CLI 2026.07.16-899851b、macOS 27、Node v24.15.0；
> 主库 state.vscdb 约 3.83 GB（WAL 模式），composerHeaders 564 行、cursorDiskKV 323959 键
> （bubbleId 187812 / agentKv 121447 / composerData 552 / checkpointId 949）。

## 1. 数据位置

| 路径 | 内容 | 结论 |
| --- | --- | --- |
| `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | app 的主 SQLite 库：会话列表 + 会话内容 + 设置 | **读写目标** [实测] |
| `.../User/workspaceStorage/<workspaceId>/workspace.json` | 单根 workspace 的 folder URI；多根是 .code-workspace | 用来把 workspaceId 映射成 cwd [实测] |
| `.../User/workspaceStorage/<workspaceId>/state.vscdb` | 每个 workspace 的旧版 ItemTable；`composer.composerData` 现在只剩 selectedComposerIds 等 | 不是列表数据源（glass 模式）[实测+仓库] |
| `.../User/globalStorage/conversation-search.db` | 会话搜索索引（FTS），由 shared process 从 state.vscdb 派生 | 不是列表数据源；不写 [实测+仓库] |
| `~/.cursor/chats/<hash>/<uuid>/{store.db,meta.json}` | **cursor-agent CLI** 的聊天存储（blobs/meta 两张表，meta 有 schemaVersion/cwd/时间） | 与 app composer 列表无关，不读不写 [实测+仓库] |
| `~/.cursor/projects/<ts>/` | 云端/后台 agent 的本地工程投影 | 未使用 [实测] |
| `~/.cursor/acp-sessions/`（1080 个） | ACP agent 会话目录 | 未使用 [实测] |
| `~/.cursor/agent-cli-state.json` / `cli-config.json` | CLI 状态/模型配置 | 只读可参考，不写 [实测] |
| `.../Cursor/logs/<ts>/main.log` | 主进程日志；含 `[LocalAgentStorage] Scanned ... found N agent headers` | app 冒烟证据 [实测] |

## 2. SQLite schema [实测+仓库]

```sql
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
  isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,
  value TEXT, subagentTypeName TEXT
);
CREATE INDEX idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency);
CREATE INDEX idx_composerHeaders_1 ON composerHeaders (recency, composerId);
```

仓库：`out/main.js` 的 storage.js 建表 SQL 与 `PRAGMA journal_mode=WAL; synchronous=NORMAL;
wal_autocheckpoint=1000`；写入方是 app 主进程，读方是 renderer（通过 storage service）
与 shared process / conversation-search。表结构自带 `ON CONFLICT REPLACE`，但**我们不用
REPLACE，而是 INSERT 前做冲突检查**，避免误覆盖。

### 2.1 composerHeaders 是否 canonical：两个开关 [实测+仓库]

- `cursorDiskKV['composer.composerHeaders.migratedToTable'] === '1'` → 以 **composerHeaders 表**为准。
  本机实测为 '1'。
- 旧格式：`ItemTable['composer.composerHeaders']` 是 `{allComposers: [head...],
  selectedComposerIds...}` 单条 JSON。app 启动时 `_migrateHeadersToTableIfNeeded()` 会把它导入表并删除 blob。
- `ItemTable['composer.composerHeaders.version']`（哨兵，形如 `1792465031946-1`）：
  app 写表后会 bump 它；非 glass 窗口监听它触发 header 重新同步。glass 模式不做 live 同步 [仓库]。
- `ItemTable['composer.composerHeaders.tableGateEnabled']`（len=4）是旧实验开关，3.25.9 代码里已不再读取 [实测+仓库]。

读 adapter 两种都支持：表不存在时回退读 ItemTable blob（`readHeaderRows`）。

## 3. composerHeaders 行 [实测+仓库]

app 侧由 `composerHeaderStorageUtils.js` 的 `rxn(composerData)` 生成：

```js
{pk: composerData.composerId,
 columns: {workspaceId: workspaceIdentifier?.id ?? null,
   createdAt, lastUpdatedAt,
   isArchived: isArchived ? 1 : 0,
   isSubagent: (composerId.startsWith('task-') || subagentInfo?.parentComposerId) ? 1 : 0,
   recency: lastUpdatedAt ?? createdAt ?? 0,
   checkpointAt: conversationCheckpointLastUpdatedAt ?? null,
   subagentTypeName: subagentInfo?.subagentTypeName ?? ""},
 value: JSON.stringify(headObject)}
```

实测示例（真库一行，value 截断）：

```json
{"composerId":"8b130de0-5b69-4719-bd3a-74e598c882bb","workspaceId":"9d1f55ff...","createdAt":1791632155745,
 "lastUpdatedAt":1792400151402,"isArchived":0,"isSubagent":0,"recency":1792400151402,
 "checkpointAt":1792400435919,"subagentTypeName":"",
 "value":"{\"type\":\"head\",\"composerId\":\"8b130de0-...\",\"name\":\"SSH connection with id_ed25519\",\"lastUpdatedAt\":1792400151402,\"...}
```

**时间戳都是毫秒**（13 位），不是秒。列表 UI 按 `recency DESC`（= lastUpdatedAt）。

## 4. value（head JSON）[实测+仓库]

app 的 `getComposerHeaderData(composerData)`（minified `_Ce`）生成：

`type:"head", composerId, name, lastUpdatedAt, unfinishedRunAt, conversationCheckpointLastUpdatedAt,
createdAt, unifiedMode:"agent"|"chat"|"background", forceMode:"edit"|"chat", hasUnreadMessages,
lastReadAtMs, contextUsagePercent, totalLinesAdded, totalLinesRemoved, filesChangedCount, subtitle,
hasBlockingPendingActions, hasPendingPlan, isArchived, isDraft, draftTarget, isWorktree,
worktreeStartedReadOnly, isSpec, isProject, projectIcon, projectAppearance, subagentInfo,
isBestOfNSubcomposer, isEphemeral, numSubComposers, createdFromBackgroundAgent,
createdFromLocalScheduledTask, cloudAgentStartPhase, authoredPlan, referencedPlans, prUrl,
trackedGitRepos, workspaceIdentifier, agentLocation, agentLocationHistory`。

可选项说明 [实测]：
- `name`：会话标题。本机非子代理 174 行里 58 行有 name、116 行没有（旧会话），**没有 name 的行
  会被主进程 LocalAgentStorage 的 zod schema 过滤**（扫描计数 448 ≈ 564 - 116 个无 name 行），
  但 renderer 的玻璃列表不按这个 schema 过滤。**写新会话必须带 name**。
- `agentLocation`：可选，形如
  `{"type":"local","environment":{"id":"<workspaceId>","uri":{$mid:1,fsPath,external,path,scheme:"file"}},"status":"active"}`；
  本机约 18/174 有，新旧混杂；老会话没有也能显示 [实测]。
  当前 write 实现默认也会写它 + 一条 `agentLocationHistory:[{id,timestamp,destination:{type:"local"},location,reason:"created"}]`
  （用于 Agents 窗口的本地项目分组）。**它不是"能被枚举"的必要条件**：
  隔离 profile 里一条没有 agentLocation 的测试 composer（d92bcea6）同样被
  `LocalAgentStorage` 计入扫描数（见 §10）。
- `agentLocationHistory`：`[{id, timestamp, destination:{type:"local"}, location:{...}, reason?}]`。
- `workspaceIdentifier`：`{id: workspaceId, uri: {$mid:1, fsPath, external, path, scheme:"file"}}`，
  在 header value 和 composerData 里都出现 [实测]。
- `isArchived` 只在归档时出现；未归档时 JSON 里没有这个字段（`JSON.stringify(undefined)` 丢弃）。

## 5. 会话内容 composerData [实测+仓库]

key：`cursorDiskKV['composerData:<composerId>']`，单条 JSON（本机最大 2.24 MB）。

版本：`_v` 本机分布 16:2 / 17:282 / 18:268；**当前版本 18**（仓库 `$ts=18`）。app 有
版本 1→18 的迁移链 `sXm`：`_v>=16` 的会话基本只走轻量迁移；缺失 `_v` 会被当成 0 触发重迁移，
所以我们写入时**必须显式 `_v:18`**。

关键字段（app `createEmptyComposer()` 的默认值 + 实际数据）：

```json
{
 "_v": 18, "composerId": "<uuid>", "richText": "", "hasLoaded": true, "text": "",
 "fullConversationHeadersOnly": [ /* 顺序 = 渲染顺序 */ ],
 "conversationMap": {},              // 实测 552/552 都是 {}
 "status": "completed",              // none | completed | generating | aborted
 "context": { ...空上下文对象，含 mentions... },
 "generatingBubbleIds": [], "codeBlockData": {}, "originalFileStates": {},
 "newlyCreatedFiles": [], "newlyCreatedFolders": [],
 "lastUpdatedAt": <ms>, "conversationCheckpointLastUpdatedAt": <ms>, "createdAt": <ms>,
 "hasChangedContext": false, "capabilities": [],
 "name": "标题", "unifiedMode": "agent", "forceMode": "edit", "isAgentic": true,
 "modelConfig": {"modelName":"grok-4.7","maxMode":true,"selectedModels":[...]},
 "usageData": {}, "contextUsagePercent": 41.36, "totalLinesAdded": 0, "totalLinesRemoved": 0,
 "filesChangedCount": 0, "subtitle": "Read x.py, y.py",
 "subComposerIds": [], "subagentComposerIds": ["<childId>"], "subagentInfo": {...},
 "todos": [], "queueItems": [], "trackedGitRepos": [], "workspaceIdentifier": {...},
 "conversationState": "~<base64>",   // protobuf 二进制
 "blobEncryptionKey": "<base64 32B>", "speculativeSummarizationEncryptionKey": "<base64 32B>"
}
```

- `conversationMap` 只用于内存加载态，**落库永远是 {}** [实测 552/552]。
- `subagentComposerIds`：子代理 composer id；父 id 在子 composerData 的
  `subagentInfo.parentComposerId`，`toolCallId` 也在这里 [实测+仓库]。
- `conversationState` 是 protobuf（base64，前缀 `~`）；空值可写 `"~"`。
- 加密 key 两字段是 Uint8Array 的 base64 形态；实测存在，可随机生成占位（未验证发送时是否必须原值）。

### 5.1 fullConversationHeadersOnly 条目 [实测+仓库]

由 `createComposerMessageHeaderData(bubble)`（`_R`）生成：

```json
{"bubbleId":"<uuid>","type":1|2,"grouping":{...},"contentHeightHint":68,
 "createdAt":"2026-09-12T12:01:48.801Z","startedAtMs":1789214513407,"completedAtMs":...}
```

`grouping` 由 `createComposerMessageHeaderGroupingData(bubble)`（`Lts`）生成，字段包括
`isRenderable, capabilityType, toolFormerTool, toolFormerStatus, toolCallCase, toolCallId,
hasText, hasThinking, isShortPlainText, textPreview, toolDisplayComputed,
isKeptFinalAiVisibleOutsideWorkedForGroup, thinkingDurationMs, turnDurationMs ...`。
app 打开会话时会用已加载气泡重算 grouping（`JEk`），只在不一致时替换，所以 grouping
写近似值不会导致加载失败 [仓库]。

## 6. 气泡 bubbleId [实测+仓库]

key：`cursorDiskKV['bubbleId:<composerId>:<bubbleId>']`，单条 JSON。本机版本 `_v:3`。
类型分布（抽样 5000）：type=1（用户）49 / type=2（助手）4951。

用户气泡（实测，字段极多，读时只依赖少数）：

```json
{"_v":3,"type":1,"bubbleId":"...","text":"用 @id_ed25519 连接 ssh ...",
 "richText":"{\"type\":\"doc\",\"content\":[...]}",   // ProseMirror/Tiptap doc JSON 字符串
 "createdAt":"2026-09-12T12:01:48.801Z","requestId":"...","unifiedMode":2,
 "images":[{"uuid":"...","dimension":{"width":1024,"height":898}}],  // 只有元数据，无二进制
 "isSimulatedMsg":true,"simulatedMsgReason":3,   // 运行时注入消息（后台任务通知等）
 "interpreterResults":[], "attachedCodeChunks":[], "tokenCount":{...},"conversationState":"~"}
```

助手气泡：
- 文本：`text` 非空；thinking 气泡 `text:""` 且 `thinking:{text,signature:"",...}`。
- 工具调用：`toolFormerData:{toolCallId,name,rawArgs,params,result,status,tool,toolCall}`，
  `capabilityType:15`。实测工具名/枚举：`read_file_v2=40`、`ripgrep_raw_search=41`、
  `glob_file_search=42`、`run_terminal_command_v2=15`、`edit_file_v2=38`、`todo_write=35`、
  `get_mcp_tools=63`、`task_v2=48`、`await=62`、`read_lints=30`、`update_current_step=0`…
  `status`：completed | error | cancelled | loading。
- 思考：`thinking.text` 有明文；`allThinkingBlocks` 通常为空数组。

读映射（adapter 实现）：
- type=1 → `message(role:user)`；`text` 优先，空则 richText 拍平；images → `image` part
  （ref=`cursor-image:<uuid>`，本地无二进制 → notice）；`isSimulatedMsg` → `synthetic:true`。
- type=2 → `thinking.text` → `reasoning(plain)`；`text` → `message(assistant)`；
  `toolFormerData` → `tool_call` + `tool_result`（result 是 JSON 字符串，尽量 parse 成 json 内容，
  status=error → isError）；`interpreterResults` → 孤立 `tool_result`。
- 空占位气泡、坏 JSON、header 有但库里缺的气泡 → 只记 notices，不中断。
- `isDisplayOnly` 气泡跳过。

## 7. workspaceId 与 cwd 映射 [实测+仓库]

`workspaceStorage/<workspaceId>/workspace.json`：

```json
{"folder":"file:///Users/example/Documents/Coding/00N.E.K.O.Verse-top"}
// 多根：{"workspace":"file:///.../xxx.code-workspace"}
```

**workspaceId 推导算法 [实测]**：目录名 = `md5(fsPath + birthtimeMs)`（darwin；linux 用 inode，
win32 用 birthtimeMs）。本机 78 个 workspace.json 中可 stat 的目录全部命中；Cursor
自身的 cursor-agent bundle 里也有同款 `md5(path + stat 时间)` 代码 [仓库]。

同一 cwd 可能有多条 workspaceStorage（目录被重建导致 birthtime 变），取 state.vscdb mtime 最新的。

## 8. app 侧读取路径（决定“可见性”的代码）[仓库]

1. **renderer 会话列表**（glass）：`ComposerDataService` 初始化时
   `EIk(storageService, ...)`：
   - 先 `collectionQuery('composerHeaders', {orderByDesc:'recency', limit:50})` 做首屏，
   - 再全量 `collectionQuery('composerHeaders', ...)`（glass 模式不按 workspaceId 过滤），
   - `JSON.parse(value)` → 去重排序（lastUpdatedAt desc）→ `allComposers`。
   → 只要 composerHeaders 行存在且 value 是 JSON，就会进列表（不做 zod 校验）。
2. **打开会话**：读 `composerData:<id>`，`_v<18` 走迁移；然后
   `getInitialMessages(composerId, fullConversationHeadersOnly)`：从尾部倒序加载
   （所有 user 气泡 + 最近若干 AI 气泡），批量读 `bubbleId:<id>:<bubbleId>`；
   每个气泡 JSON 与默认气泡 `createDefaultConversationMessage()` 合并（缺字段可容忍，
   但 `_v` 需存在）。缺失气泡会被跳过（不崩）。
3. **主进程 LocalAgentStorage**：启动时若 canonical flag=1 则
   `SELECT value FROM composerHeaders` 全表扫描（zod 要求 composerId+name，过滤 draft/ephemeral），
   再扫最近 2 天 mtime 的 workspace DB 的旧 blob；写 `main.log` 的
   `[LocalAgentStorage] Scanned ... found N agent headers`。
4. **conversation-search**：shared process 扫 `composerData:` + join composerHeaders，
   更新 `conversation-search.db`（搜索用，不影响列表）。

## 9. 写入实现（adapter 的 writeCursorSession）

只新增 key，单事务，绝不 update/delete：

1. `composerHeaders` 一行：composerId/workspaceId/createdAt/lastUpdatedAt/isArchived=0/
   isSubagent=0/recency=lastUpdatedAt/checkpointAt=lastUpdatedAt/subagentTypeName=""/value=head JSON。
2. `cursorDiskKV['composerData:<id>']`：`_v:18`、`conversationMap:{}`、`unifiedMode:"agent"`、
   `forceMode:"edit"`、`isAgentic:true`、`status:"completed"`、`fullConversationHeadersOnly`（事件顺序）、
   `modelConfig`（默认沿用库里最近 composer 的配置；可显式指定）、`workspaceIdentifier`、
   `conversationState:"~"`、随机 base64 加密 key。
3. 每个消息一个 `bubbleId:<id>:<uuid>`：user 带 `text` + ProseMirror richText；
   assistant 带 `text`；reasoning → type=2 thinking 气泡（`thinking:{text,signature:""}`，
   `capabilityType:30`）；tool_call/tool_result → 一个 type=2 工具气泡
   （`capabilityType:15` + `toolFormerData`，结果内联在同一个气泡；字段/映射见
   [cursor-toolformer.md](./cursor-toolformer.md)）。
4. `lastUpdatedAt/recency`：**默认用写入时刻 now**（列表按 recency 倒序，导入会话应出现在顶部），
   header 的 `createdAt` 和气泡 `createdAt` 仍保留源时间；`preserveUpdatedAt:true` 可改为使用源时间。
5. 安全：`PRAGMA busy_timeout=5000`；`BEGIN IMMEDIATE`/COMMIT（失败 ROLLBACK）；
   WAL；写前把计划 key 的现值备份到 `.tmp/cursor-write-backup-<ts>-<id>.json`；
   任何计划 key 已存在 → 抛错拒绝覆盖；事务内二次检查冲突，cursorDiskKV 用
   `INSERT OR ABORT` 显式覆盖列的 `ON CONFLICT REPLACE` 默认策略（并发下也不会静默替换）；
   默认真实用户库路径必须显式 `confirmReal:true`（先 dryRun）。

**没有写**：`toolCallBinary`（agent.v1.ToolCall 的 protobuf；当前只写 params/result，
UI 渲染需人工确认）、edit 的 `precomputedDiff`/`beforeContentId`/`afterContentId`、
子代理 composer、图片二进制、conversationState protobuf、checkpoint/diff 数据。
工具映射的已确认/推测边界见 [cursor-toolformer.md](./cursor-toolformer.md)。

### 9.1 真实库写入证据（2026-10-20，实测）

数据源：真实 Claude Code 会话 `dc19c90e-...`（cwd=neko-auth-platform，标题
「如何清理当前已经归档的对话？」），IR 32 events（15 条 message 可写，9 tool_call + 8 tool_result 丢弃）。
先 `dryRun:true` 看计划（rows=17、workspaceId=4062677a…、losses 3 条），再显式
`confirmReal:true` 写入，composerId=`9ac31713-02c9-46bd-aff3-e3ccf84d068a`。

写前/写后计数（同一台机器、同一次连接内查询）：

| 指标 | 写前 | 写后 | 差 |
| --- | --- | --- | --- |
| composerHeaders | 564 | 565 | +1 |
| composerData: 前缀 | 552 | 553 | +1 |
| bubbleId: 前缀 | 187812 | 187827 | +15 |
| agentKv: 前缀 | 121447 | 121447 | 0 |
| cursorDiskKV 总计 | 323959 | 323975 | +16（composerData 1 + bubble 15） |

未改动旧数据的证据：对写前全部 564 行 composerHeaders 按
`composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt,
subagentTypeName, value` 计算 sha256 =
`11ff0cfe0914dfdaee2f86b07b3174ec5e13aed742802bfe80caa8bba4b27adc`；
写后排除新 composerId 再算，sha256 完全相同。

`verifyCursorSession({sessionId, expected:{bubbles:15}})` 输出（全 PASS）：
`db-exists, header-table, header-row, header-value-parses, header-composer-id, header-name,
header-workspace-id, workspace-uri-fspath, timestamps-sane, header-table-canonical,
composer-data-row, composer-data-parses, composer-version (_v=18), conversation-headers (15),
headers-shape, headers-order, bubbles-complete, bubble-json-parses, bubble-types-match,
no-orphan-bubbles, bubble-count, expected-bubbles, readback-events, readback-messages`；
readback = 15 events / 7 user / 8 assistant，标题与 cwd 正确。

备份：`.tmp/cursor-write-backup-2026-10-20T09-57-23-122Z-9ac31713-02c9-46bd-aff3-e3ccf84d068a.json`
（写入前计划 key 的现值：全部不存在，existing={}）。

> 注意：这次真实写入发生在本文档后续两个改动之前——(a) 默认 recency 改成 now；
> (b) header 增加 agentLocation。因此 9ac31713 这条在用户列表里按源时间
> （2026-09-24）排序、且 header 没有 agentLocation。按 Lead 决定保留该条，供用户人工打开确认。

### 9.2 第二条真实写入：Claude Code → Cursor（含 agentLocation / 完整气泡字段）

- 源：真实 Claude Code transcript `219e0e77-b848-47f3-aa66-f6930c31dcfe.jsonl`（40 行，cwd 是
  neko-auth-platform 的 worktree），转成 IR 后 8 events：2 message 可写，3 tool_call + 3 tool_result
  被丢弃并记 losses。
- 目标 cwd 选主仓 `/Users/example/Documents/GitHub/neko-auth-platform`，复用已存在的
  workspaceId `161b097fe314c56623925ee7c9e5f2fe`；标题
  「Claude Code 导入：main 分支最新代码」；composerId `bcd042da-8c54-4a1b-9af8-d36ec4a8ff74`。
- 先 dryRun：rows=4（composerData 1 + header 1 + bubble 2），4 个 key 全部不存在；
  再 `confirmReal:true` 写入。
- 计数：composerHeaders 565 → 566（+1）；cursorDiskKV 323975 → 323978（+3：composerData 1 +
  bubble 2）；未新增 agentKv/checkpoint。
- `verifyCursorSession` 全 PASS（readback：2 events，1 user + 1 assistant），
  `listCursorSessions` 首条即该会话，cwd/title 正确。
- header 现在包含 `agentLocation` + 一条 `agentLocationHistory`；bubble 补齐了真实气泡的
  空数组字段（images/toolResults/context 等），降低 renderer 对 undefined 调 map 的风险。
- 备份：`.tmp/cursor-real-backup/cursor-write-backup-2026-10-20T10-02-19-704Z-bcd042da-8c54-4a1b-9af8-d36ec4a8ff74.json`。

## 10. app 可见性 / 续聊验证结论

**Cursor app 的 composer 没有 headless 的 list/resume 入口。**
- `cursor-agent --help` 有 `ls`、`resume`、`--resume <chatId>`、`create-chat`，但 CLI bundle 里
  没有任何 `composerHeaders`/`composerData`/`bubbleId` 字符串；CLI 会话存在
  `~/.cursor/chats/<hash>/<uuid>/store.db`（blobs/meta），与 app 的 composer 库是两套 [实测+仓库]。
- 因此“写完能否在 app 列表里看到/继续聊”只能通过重启 app 验证。隔离 user-data-dir 实测
  （`.tmp/cursor-app-test`，真实库副本；这条链路由 Lead 的隔离冒烟 + 本文档的日志/索引复核组成）：

  1. **[实测] 主进程枚举**：无 agentLocation 的测试 composer（d92bcea6，17:55 写入）存在时，
     `main.log` 为 `LocalAgentStorage ... found 449`；17:57 删除它后重启为 `found 448`；
     17:58 再写一条 dddbb5eb 后重启又为 `found 449`。→ composerHeaders 行会被 app 启动扫描枚举。
  2. **[实测] 搜索索引**：app 运行后 `conversation-search.db` 出现
     `conversations.id="dddbb5eb-…", title="Sessionport 导入测试（可见性验证）", source="local"`，
     且 `conversation_fts` 的 body 正好是我们写入的两条消息文本。→ shared process 能从
     state.vscdb 读出 composerData + 气泡并建索引（说明 header 与内容都被 app 认可）。
  3. **[实测] app 打开会话**：18:00:51 的 `main.log`：
     `[MainThreadCursorAgentHost] ensureLoaded: transcript without checkpoint-backed conversationState
     for dddbb5eb-… {"resolutionSource":"top-level-fallback","headerCount":3}`，
     紧接着 `created host session dddbb5eb-… {"turnCount":0,"coldBootstrap":false,
     "workspacePaths":["/Users/example/Documents/Coding/0auth-neko"]}`。
     → app 打开并 hydrate 了导入会话（3 条 header = 3 个气泡），workspace 路径解析正确；
     `turnCount:0` 表示还没发新消息。
  4. **[推测] glass 列表可见**：列表代码与上述扫描/索引同源于 composerHeaders（§8.1），
     且上述 ensureLoaded 只可能由 UI 打开触发；但“列表里那一行长什么样”没有截图级验证。
  5. **未验证：继续聊天**。app 没有 headless 的发送入口；需要人工在 Cursor 里打开会话并
     发一条消息，才能验证续聊（后端是否接受本地构造的历史）。
  6. **本机真实库**的 9ac31713 写入发生在 Cursor 未运行时，磁盘结构 verify 全 PASS；
     真实库的 UI 可见性/续聊同样**需人工在 app 里确认**；bcd042da（含 agentLocation/完整气泡字段）的
     verify 与 CLI `list` 首条已通过；2026-10-20 18:07 重启真实 Cursor 后，
     `main.log` 为 `[LocalAgentStorage] ... found 451 agent headers`，`conversation-search.db`
     出现 bcd042da 行且正文正是写入的两条消息。→ 真实 app 进程枚举并索引了导入会话；
     列表 UI 目视与“继续聊天”仍需人工确认。

**关于 agentLocation 的判定依据（Lead 专门要求）**：
- **[实测]** 不写 `agentLocation/agentLocationHistory` 的 d92bcea6 也被 `LocalAgentStorage`
  枚举（扫描计数 +1）。因此“能被 app 枚举”不依赖 agentLocation。
- **[推测]** 因此 glass 列表能加载它（同一张表、同一段 JSON 解析；value 是合法 JSON）。
- 但当前代码仍默认写 agentLocation（用于 Agents 窗口按本地项目分组，更贴近新版 app 自己写的
  数据；新版 header 约 10% 带它）。本机个别旧会话没有它也能显示，属于可选字段。

## 11. 未验证 / 已知风险

- UI 渲染与续聊未做人工确认（尤其 thinking/richText 的展示、发送消息后后端是否接受本地构造的历史）。
- **默认 recency=写入时刻 now**（导入会话排列表顶部，`preserveUpdatedAt:true` 可保留源时间）；
  本机真实库的 9ac31713 与 bcd042da 都是改动前写的，仍按源时间排序。
- 写入默认带 `agentLocation/agentLocationHistory`；[实测] 不带也能被 app 枚举与索引，
  [推测] 列表可见不受影响，但 Agents 窗口的本地项目分组可能更依赖它。
- toolFormerData 已写回常见工具（shell/read/edit/write/grep/glob/list/delete/todo），
  写入 `params`/`result`/`additionalData` 与 `_sessionport` 往返扩展；但
  `toolCallBinary` 未写、edit diff 不可用、UI 渲染仍需人工确认。证据/字段表/未验证项见
  [cursor-toolformer.md](./cursor-toolformer.md)。
- 图片只有 uuid/尺寸，没有本地二进制，读写都只能占位。
- `conversationState`、`blobEncryptionKey`、`speculativeSummarizationEncryptionKey` 用占位值；
  发送新消息后 app 可能重写这些字段（未验证是否影响首条续聊）。
- 版本漂移：字段形状来自 3.25.9；`_v` 提高后需要重新核对（app 有迁移链，写入前应检查 `_v`）。
- 写入时 app 若正在运行：glass 模式不会 live 同步 composerHeaders，需要重启 app 才出现在列表；
  app 退出时的保存只 upsert 它自己内存里的行，不会删除新增行（9ac 写入时 app 未运行；
  bcd 写入时 app 在运行，未重启，UI 未验证并发写）。
- 子代理 composer 只读不写；`children` 读取默认最多 32 个。
- 旧版无 composerHeaders 表的库：读有兜底（ItemTable blob），写会建表（不改旧数据）。

## 12. 复现命令（本仓库）

```bash
# 离线测试
node --test packages/adapters/cursor/test/*.test.ts

# 只读真实库
node -e "import('./packages/adapters/cursor/src/index.ts').then(async m => {
  console.log(await m.listCursorSessions({limit:5}));
  const b = await m.readCursorSession('last', {includeChildren:false});
  console.log(b.root.meta, b.root.events.length, b.root.notices);
})"

# gated 真实库测试（只读）
SESSIONPORT_CURSOR_HOME="$HOME/Library/Application Support/Cursor" \
  node --test packages/adapters/cursor/test/gated.test.ts

# 写真实库前必须先 dryRun，再 confirmReal
# writeCursorSession(bundle, { dryRun: true })  → 检查 rows/losses/workspaceId
# writeCursorSession(bundle, { confirmReal: true }) → 真正写入（只新增 key + .tmp 备份）
```
