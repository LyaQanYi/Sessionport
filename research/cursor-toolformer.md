# Cursor toolFormerData 逆向与写回（Cursor 3.25.9 / macOS）

> 标注约定：**[实测]** = 本机真实库/真实样本上验证；**[仓库]** = 从
> `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`
> （39 MB，minified 单行）读到的实现；**[推测]** = 由前两者推断但未单独验证。

## 0. 先纠正一个前提：bubble 不是 protobuf

任务背景里写“bubble value 是 protobuf（agent.v1.*）”，这**不适用于 state.vscdb**：

- `cursorDiskKV['bubbleId:<composerId>:<bubbleId>']` 的 value 是 **JSON 文本**，
  `toolFormerData` 是其中一个普通 JSON 对象。[实测]
- protobuf 只出现在两个地方：
  1. `toolFormerData.toolCallBinary`：base64(`agent.v1.ToolCall`)；[仓库+实测]
  2. `composerData.conversationState` / Chat export 的 `conversationState`。[实测]
- `params`、`result` 是 **JSON 字符串**，字符串里面是 `aiserver.v1.*` 消息的
  protobuf JSON 形态；app 用 `Xxx.fromJsonString(e.params)` / `Xxx.fromJsonString(e.result)`
  解码。[仓库]

证据（bundle 搜索关键词与位置）：

| 关键词 | bundle 内位置（byte offset） | 结论 |
| --- | ---: | --- |
| `toolCallBinary` | 15,981,704 | 只有一处：`if(e.toolCallBinary){const u=iN(e.toolCallBinary);o=ng.fromBinary(u.buffer)}`，`iN` 是 base64 解码 |
| `function wQd(` | 15,984,709 | 持久化工具数据的解码/编码总入口；按 `tool` 枚举调用 `Xxx.fromJsonString(e.params)` / `e.result` |
| `serializeToolformerBubbleData.js` | ~15,983,xxx | `wQd` 所在模块；持久化时把 `toolCall` 序列化成 `toolCallBinary`，并删掉 `toolCall` |
| `makeMessageType("agent.v1.ToolCall"` | 14,473,617 | `ng`：oneof 工具调用（shell/delete/glob/grep/read/todos/edit/ls/...） |
| `makeEnum("aiserver.v1.ClientSideToolV2"` | ~13,585,000 | `ct`：工具枚举（0..66） |
| `makeMessageType("aiserver.v1.ReadFileV2Params"` | 13,670,319 | 读参数 schema |
| `makeMessageType("aiserver.v1.RunTerminalCommandV2Result"` | 13,650,890 | shell 结果 schema |
| `function $5n(` | ~17,826,000 | 把 `agent.v1.ToolCall` 转成 `toolFormerData` 的 12 个字段 |
| `function fgo(` / `function fYv(` | ~15,987,xxx | grep/list 结果在落库前被剪成 `additionalData` 摘要 |
| `function BKi(` | 16,051,572 | 打开会话时 `bQd(toolFormerData)` → `yQd`，再挂回 bubble |

## 1. toolFormerData 字段表（JSON，非 protobuf）

真实样本（本机 `.tmp/cursor-app-test/User/globalStorage/state.vscdb`，3.6 GB 副本，
抽样 5000 个 bubble 中 3198 个带 toolFormerData）：

```json
{
  "toolCallId": "tool_7c5d83af-3881-4c43-8f42-5e5657c6311",
  "toolIndex": 0,
  "modelCallId": "tool_7c5d83af-3881-4c43-8f42-5e5657c6311",
  "status": "completed",
  "name": "read_file_v2",
  "rawArgs": "{\"path\":\"/Users/...\",\"offset\":450,\"limit\":150}",
  "tool": 40,
  "params": "{\"targetFile\":\"/Users/...\",\"offset\":450,\"limit\":150,\"charsLimit\":1000000,\"effectiveUri\":\"/Users/...\"}",
  "result": "{\"contents\":\"...\",\"totalLinesInFile\":845}",
  "additionalData": { "...": "工具特有" },
  "error": "{\"clientVisibleErrorMessage\":\"...\",\"modelVisibleErrorMessage\":\"...\"}",
  "toolCallBinary": "<base64(agent.v1.ToolCall)>",
  "_sessionport": { "v": 1, "name": "Read", "input": { "...": "..." } }
}
```

| 字段 | JSON 类型 | 出现（3198 个样本） | 说明 / 证据 | 本 adapter 写 |
| --- | --- | ---: | --- | --- |
| `toolCallId` | string | 3198 | 源工具调用 id；可含换行（MCP/Cursor 原生） | 源 `callId`（空则生成） |
| `toolIndex` | number | 3198 | 同一次 model call 内的序号；实测通常 0 | 0 |
| `modelCallId` | string | 3198 | 实测通常等于 toolCallId；少数为空 | = toolCallId |
| `status` | enum string | 3198 | `completed` / `error` / `cancelled` / `loading` | 见 §4 |
| `name` | string | 3198 | Cursor 规范工具名（`read_file_v2` 等） | 规范名 |
| `rawArgs` | string | 3098 | 模型原始参数 JSON；shell 常为 `""` | 源 input 的 JSON |
| `tool` | number | 3198 | `aiserver.v1.ClientSideToolV2` 枚举 | 见 §3 |
| `params` | string | 3130 | 工具参数消息的 **protobuf JSON**（camelCase） | 按 schema 生成 |
| `result` | string | 2271 | 结果消息的 **protobuf JSON**；grep/list 落库时可能被剪成 additionalData | 按 schema 生成/省略 |
| `additionalData` | object | 1545 | 非 protobuf 的 UI 数据：shell 状态、grep/list 摘要、edit precomputedDiff | shell/grep/list/delete 等 |
| `error` | string | 59 | `ToolResultError` 的 protobuf JSON | 错误态 |
| `toolCallBinary` | string | 3198 | base64(`agent.v1.ToolCall`)；app 打开时 `ng.fromBinary` | **不写**（见 §6） |
| `userDecision` | string | 少量 | 如 delete 的 `accepted` | 不写 |

`params`/`result` 的 JSON 字符串是 **紧凑 JSON**：对 13 个有 params 的样本、
11 个有 result 的样本做 `JSON.parse` 再 `JSON.stringify`，字节完全一致（13/13、11/11）。[实测]

### 1.1 为什么 params/result 是字符串而不是对象

`wQd` 里：

```js
case ct.READ_FILE_V2:
  return {params: e.params ? Rkt.fromJsonString(e.params) : void 0,
          result: e.result ? JPe.fromJsonString(e.result) : void 0};
```

相反方向 `$5n` 返回的对象字段是 `params: h`、`result: g`（protoString 序列化后的字符串），
落库前再走 `wQd({forStorage:true})`，把 `toolCall` 转成 `toolCallBinary` 并删除 `toolCall`。
所以 UI 侧拿到的是解码后的 message 对象，存储侧是 JSON 字符串。

## 2. aiserver.v1.ClientSideToolV2 枚举（实测 bundle）

```text
0  UNSPECIFIED
1  READ_SEMSEARCH_FILES
3  RIPGREP_SEARCH
5  READ_FILE
6  LIST_DIR
7  EDIT_FILE
8  FILE_SEARCH
9  SEMANTIC_SEARCH_FULL
11 DELETE_FILE
12 REAPPLY
15 RUN_TERMINAL_COMMAND_V2
16 FETCH_RULES
18 WEB_SEARCH
19 MCP
23 SEARCH_SYMBOLS
24 BACKGROUND_COMPOSER_FOLLOWUP
25 KNOWLEDGE_BASE
26 FETCH_PULL_REQUEST
27 DEEP_SEARCH
28 CREATE_DIAGRAM
29 FIX_LINTS
30 READ_LINTS
31 GO_TO_DEFINITION
32 TASK
33 AWAIT_TASK
34 TODO_READ
35 TODO_WRITE
38 EDIT_FILE_V2
39 LIST_DIR_V2
40 READ_FILE_V2
41 RIPGREP_RAW_SEARCH
42 GLOB_FILE_SEARCH
43 CREATE_PLAN
44 LIST_MCP_RESOURCES
45 READ_MCP_RESOURCE
46 READ_PROJECT
47 UPDATE_PROJECT
48 TASK_V2
49 CALL_MCP_TOOL
50 APPLY_AGENT_DIFF
51 ASK_QUESTION
52 SWITCH_MODE
53 GENERATE_IMAGE
54 COMPUTER_USE
55 WRITE_SHELL_STDIN
56 RECORD_SCREEN
57 WEB_FETCH
58 REPORT_BUGFIX_RESULTS
59 AI_ATTRIBUTION
60 MCP_AUTH
61 REFLECT
62 AWAIT
63 GET_MCP_TOOLS
65 SEND_TO_USER
66 CONNECT_SCM
```

真实库工具名分布（前 5000 bubble）：`read_file_v2` 1878、`ripgrep_raw_search` 1432、
`run_terminal_command_v2` 913、`edit_file_v2` 473、`glob_file_search` 219、
`todo_write` 41、`get_mcp_tools` 41、`task_v2` 5、`read_lints` 7、`await` 14 等。[实测]

## 3. toolCallBinary 的 wire 结构（只读验证，不写）

`toolCallBinary` = base64(`agent.v1.ToolCall`)。`agent.v1.ToolCall` 是 oneof：

| toolFormerData.name | tool 枚举 | agent.v1.ToolCall 字段 | 真实样本首字节（base64 解码后） |
| --- | ---: | ---: | --- |
| `run_terminal_command_v2` | 15 | 1 `shell_tool_call` | `0a c2 0f` |
| `delete_file` | 11 | 3 `delete_tool_call` | `1a b5 04 0a ae 01 …` |
| `glob_file_search` | 42 | 4 `glob_tool_call` | `22 f2 d8 0c` |
| `ripgrep_raw_search` | 41 | 5 `grep_tool_call` | `2a f4 e6 0a` |
| `read_file_v2` | 40 | 8 `read_tool_call` | `42 ff 01` |
| `todo_write` | 35 | 9 `update_todos_tool_call` | `4a 87 04` |
| `edit_file_v2` | 38 | 12 `edit_tool_call` | `62 c6 03` |
| `list_dir_v2` | 39 | 13 `ls_tool_call` | （本机库无 list_dir_v2 样本，schema 已确认） |
| `read_lints` | 30 | 14 `read_lints_tool_call` | `72 7e` |
| `task_v2` | 48 | 19 `task_tool_call` | `9a 01 9e 0c` |
| `get_mcp_tools` | 63 | 44（实测样本字段 44） | `e2 02 e8 04` |

字段号来自 `ng=S.makeMessageType("agent.v1.ToolCall", ...)`：[仓库]

```js
[
 {no:1,name:"shell_tool_call",kind:"message",T:Soe,oneof:"tool"},
 {no:3,name:"delete_tool_call",kind:"message",T:kwt,oneof:"tool"},
 {no:4,name:"glob_tool_call",kind:"message",T:hNn,oneof:"tool"},
 {no:5,name:"grep_tool_call",kind:"message",T:C8e,oneof:"tool"},
 {no:8,name:"read_tool_call",kind:"message",T:_Le,oneof:"tool"},
 {no:9,name:"update_todos_tool_call",kind:"message",T:fNn,oneof:"tool"},
 {no:12,name:"edit_tool_call",kind:"message",T:koe,oneof:"tool"},
 {no:13,name:"ls_tool_call",kind:"message",T:Ewt,oneof:"tool"},
 ...
]
```

> 注意：`aiserver.v1.ToolCall`（`y8i`，field 1 builtin / field 2 custom）是另一套旧结构，
> 不是 `toolCallBinary` 用的消息。toolFormerData 用的是 `agent.v1.ToolCall`（`ng`）。

## 4. 写回映射（packages/adapters/cursor/src/toolformer.ts）

| IR 工具名（别名） | Cursor name | tool | params（protobuf JSON） | result / additionalData |
| --- | --- | ---: | --- | --- |
| `Bash`, `shell`, `exec_command`, `run_terminal_command` | `run_terminal_command_v2` | 15 | `command`, `cwd`, `options.timeout`, `commandDescription`, `isBackground` | result: `output`, `exitCode`, `rejected`, `notInterrupted`, `outputRaw`；additionalData: `{status,startedAtMs}` |
| `Read`, `read`, `read_file` | `read_file_v2` | 40 | `targetFile`, `offset`, `limit`, `charsLimit`(默认 1e6), `effectiveUri` | result: `contents`（+ 可选 `totalLinesInFile`） |
| `Edit`, `str_replace`, `str_replace_editor` | `edit_file_v2` | 38 | `relativeWorkspacePath`, `contentsAfterEdit` 或 `streamingContent`, `noCodeblock`, `cloudAgentEdit` | result: `resultForModel`, `contentsAfterEdit`, `fileWasCreated` |
| `Write`, `write_file`, `create_file` | `edit_file_v2` | 38 | 同上 + 必填 `contentsAfterEdit` | result: `fileWasCreated:true`, `contentsAfterEdit`；loss `cursor.write-mapped-to-edit` |
| `Grep`, `ripgrep` | `ripgrep_raw_search` | 41 | `pattern`, `path`, `glob`, `outputMode`, `context*`, `caseInsensitive`, `type`, `headLimit`, `multiline`, `ignoreGlobs`, `offset` | **不写 result**，additionalData 摘要：`{isPruned,pattern,path,outputMode,totalFiles,totalMatches,topFiles}`（与 `fgo` 一致） |
| `Glob`, `file_search` | `glob_file_search` | 42 | `targetDirectory`, `globPattern` | result: `{directories:[{absPath,files:[{relPath}],totalFiles}]}` |
| `LS`, `ls`, `list` | `list_dir_v2` | 39 | `targetDirectory`, `ignoreGlobs` | **不写 result**，additionalData 摘要：`{isPruned,rootPath,totalDirs,totalFiles,topEntries,extensionCounts}`（与 `fYv` 一致） |
| `Delete`, `rm` | `delete_file` | 11 | `relativeWorkspacePath` | result: `{rejected,fileNonExistent,fileDeletedSuccessfully}` |
| `TodoWrite`, `update_plan` | `todo_write` | 35 | `todos`, `merge` | result: `{success,finalTodos,initialTodos,wasMerge}` |

状态：

| IR | toolFormerData.status |
| --- | --- |
| 有 result 且 `isError !== true` | `completed` |
| 有 result 且 `isError === true` | `error`（同时写 `error` = ToolResultError JSON） |
| 没有 result | `cancelled`（loss `cursor.tool-result-missing`，info） |

每个工具气泡：`type=2`（AI）、`text:""`、`capabilityType=15`（`COMPOSER_CAPABILITY_TYPE_TOOL_FORMER`），
`startedAtMs` = 调用时间，`completedAtMs` = 结果时间；composerData 的 header entry grouping 写
`{isRenderable:true, capabilityType:15, toolFormerTool, toolFormerStatus, toolCallId, hasText:false, toolDisplayComputed:true}`。
app 加载时会用 `eKi` 重算 grouping（只在不一致时替换），所以近似值不会阻塞加载。[仓库]

## 5. 往返扩展 `_sessionport`（sessionport 私有，Cursor 忽略）

Cursor 的 `params`/`result` 是规范化后的形态（例如 Read 的 `file_path` → `targetFile`），
而 IR 的 `input`/`content` 是源端形态。为了让 IR → Cursor → IR 精确往返，写工具气泡时在
`toolFormerData` 顶层加：

```json
"_sessionport": {
  "v": 1,
  "name": "Bash",              // 源 IR 工具名
  "input": { "command": "ls" },// 源 IR input 原值
  "content": [ { "type": "text", "text": "..." } ], // 源 IR tool_result content 原值
  "isError": false
}
```

- Cursor 的加载链路对 toolFormerData 是对象展开（`wQd` 返回 `{...e}`），不会校验/删除未知键；
  因此该字段不影响 app，且读回时能还原源 IR。[仓库+推测：app 重存时是否保留未单独验证]
- `read.ts` 优先读 `_sessionport.input/content/name`；没有该字段的原生气泡仍按
  `params`/`rawArgs`/`result` 解码（保持旧行为）。[实测：现有 read 测试 + 真实库 321 events]
- 这是 **sessionport 扩展**，不是 Cursor 原生字段。UI 渲染仍依赖 `params`/`result`。

## 6. 已验证 / 推测 / 未验证

### 已验证（[实测]）

- bubble value 是 JSON；toolFormerData 是 JSON 对象；params/result 是紧凑 JSON 字符串。
- 工具枚举数值、工具名分布（3198 条样本）。
- 用真实 rawArgs 重新编码 params：`read_file_v2` 20/20、`glob_file_search` 19/19 与 app 落库的
  params **按 JSON 值**完全一致（不比较键顺序）；grep 9/20（差异主要是 app 省略的
  `headLimit` 等可选默认值）。
- `toolCallBinary` 首字段号与 `agent.v1.ToolCall` oneof 完全对应（shell=1、delete=3、glob=4、
  grep=5、read=8、todo=9、edit=12、list=13、read_lints=14、task=19）。
- 写入 → 读回：常见 9 种工具（Bash/Read/Edit/Grep/Glob/LS/Delete/Write/TodoWrite）的
  name/input/result 精确往返（见 `test/toolformer.test.ts`）。
- 错误态、缺结果、未知工具、孤立结果、参数不可用都有显式 status/loss。
- 原生 Cursor 的 grep/list `additionalData` 摘要能读成 `tool_result(json)`。
- 真实库只读回归：321 events / 115 tool_call / 113 tool_result，verify 全 PASS。

### 推测（[推测]）

- `_sessionport` 在 app 重存气泡后仍会保留（app 对 toolFormerData 做对象展开）。
- `list_dir_v2` 的落库形态：schema 与 `fYv` 都确认会剪成 additionalData，但本机 3.6 GB 副本里
  没有 `list_dir_v2` 样本（只有 schema/代码证据）。
- Write → `edit_file_v2` + `fileWasCreated` 是近似映射；内容保留，但 diff 不可用。

### 未验证（需要人工在 Cursor 里确认）

1. **UI 渲染**：导入会话里的工具卡片是否显示命令/路径/结果。当前只写 `params`/`result`，
   **没有写 `toolCallBinary``**；如果某个工具卡片依赖 `toolFormerData.toolCall`（而不是
   params/result），它可能退化成“Ran tool”/空卡片。需要人工打开会话确认。
2. **app 是否回写/删除 `_sessionport`**：打开会话、发消息、退出 app 后再读库对比。
3. **edit 的 diff 卡片**：没有 before/after 全文与 `beforeContentId`/`afterContentId`，
   预期只显示路径与结果，不显示可展开 diff。
4. **list_dir_v2**：没有真实样本，只有 schema/代码证据；UI 渲染未验证。

### 明确不写（记录为 loss 或文档边界）

- `toolCallBinary`：不生成。原因：需要完整编码 `agent.v1.ToolCall` 的 args/result 子消息
  （shell 的 success/failure oneof、read 的 content/contentBlobId oneof 等），错误编码的收益低、
  风险高；UI 的 params/result 已能提供显示数据。若人工确认 UI 必须依赖 toolCall，再补。
- `userDecision`、edit 的 `precomputedDiff`/`beforeContentId`/`afterContentId`：没有可靠的
  before/after 文件内容来源，写进去会是伪造。edit/write 显式记 `cursor.edit-diff-unavailable`。
- 图片工具结果：只写 `[image: ref]` 占位文本，记 `cursor.tool-result-image-dropped`。
- 未知工具 / 参数不可用：显式 `cursor.tool-call-unsupported` / `cursor.tool-input-unusable`，
  不写半成品气泡。

## 7. 复现命令

```bash
# 1) 只读复制真实库（不要直接打开真实 ~/Library/...）
cp ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb .tmp/state.vscdb

# 2) 单测（临时 SQLite 库，不碰真实库）
node --test packages/adapters/cursor/test/*.test.ts

# 3) 真实样本结构验证（只读副本）
node .tmp/validate-real-toolformer.mjs .tmp/state.vscdb

# 4) 真实库只读回归（列表 + 读最近会话 + verify）
SESSIONPORT_CURSOR_HOME="$PWD/.tmp/cursor-app-test" \
  node --test packages/adapters/cursor/test/gated.test.ts

# 5) 写真实库前先 dryRun，再 confirmReal（会先复制到 .tmp 备份）
#    writeCursorSession(bundle, { dryRun: true })
#    writeCursorSession(bundle, { confirmReal: true })
```

### 人工确认步骤（需要用户在 Cursor 里操作）

1. 在隔离 profile（`.tmp/cursor-app-test` 的副本）或真实库里写入一个带工具调用的测试会话；
2. 完全退出并重启 Cursor，打开该会话；
3. 检查 shell/read/edit/grep/glob/list/delete 卡片是否显示参数与结果；记录哪些卡片退化；
4. 若 shell/read 卡片只显示 “Ran tool”，则下一步补 `toolCallBinary`（agent.v1.ToolCall 编码）；
5. 发一条新消息再退出，重新读库确认 `_sessionport` 是否仍在、气泡是否被 app 重写。
