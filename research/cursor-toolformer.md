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
| `additionalData` | object | 1545 | 非 protobuf 的 UI 数据：shell 状态、grep/list 摘要、edit precomputedDiff | shell/grep/list/delete；edit 有 diff 时 `precomputedDiff` |
| `error` | string | 59 | `ToolResultError` 的 protobuf JSON | 错误态 |
| `toolCallBinary` | string | 3198 | base64(`agent.v1.ToolCall`)；app 打开 composer 时 `ug.fromBinary` 解码，缺了工具卡片退化成文本摘要 | **shell/read/grep/glob/ls/delete/edit 都写**（`toolcall-binary.ts`，见 §3.1/§4.1）；todo 等其余分支暂不写 |
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

相反方向 `$5n` 返回的对象字段是 `params: h`、`result: g`（protobuf-es 的 message 对象），
落库前再走 `wQd({forStorage:true})`（以及 `HCt` 的 `toJsonString()`）把 message 序列化成
protobuf JSON 字符串，把 `toolCall` 转成 `toolCallBinary` 并删除 `toolCall`。
所以 UI 侧拿到的是解码后的 message 对象，存储侧是 JSON 字符串。

### 1.2 edit_file_v2 的 diff 字段（2026-10-28 追加，实测 + 仓库）

样本仍来自 `.tmp/cursor-app-test/User/globalStorage/state.vscdb`（只读副本）与
Cursor 3.25.9 bundle。先给结论：**UI 的 diff 卡片靠 `additionalData.precomputedDiff`，
不靠 `beforeContentId`/`afterContentId`；后两者只是 `composer.content.<sha256>` 全文
blob 的引用。** 因此 IR 里只有统一 diff 文本时，可以按 app 自己的 diff fallback
编码出可渲染的 diff 卡片；没有全文 blob 时无法伪造的是“文件内容引用”，不是卡片本身。

#### result：真实样本只有 content id

对 1200 个 `edit_file_v2` 气泡（SQL：`value LIKE '%edit_file_v2%'`）统计：

- `result` 的 key 只有 `beforeContentId`（1115 个）与 `afterContentId`（1177 个）；
  `contentsBeforeEdit` / `contentsAfterEdit` / `fileWasCreated` / `linesAdded` 均为 0 次。
- 典型 result 只有 204 字节：

  ```json
  {"beforeContentId":"composer.content.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
   "afterContentId":"composer.content.ddb821e663866f96309fed0c344b93926718e0609044190ae0ca1d8be4457b84"}
  ```

- `cursorDiskKV` 里存在 `composer.content.<64 hex>` 行，value 是**原始文件文本**，
  `<64 hex>` 正好是 `sha256(value)`。[实测]
  - 空文件：id `e3b0c442…b855`，value 长度 0（sha256("")）；
  - 5,454 B 的 canvas.tsx：id `ddb821…7b84`，sha256(value) 一致；
  - 3,926 B 的 nginx conf：id `a34615…6bd8`，sha256(value) 一致。
- bundle 写 blob 的代码在 offset 18,368,211 附近：success 分支
  `composer.content.${sha256(serialize(content))}`，先 `cursorDiskKVGet`，不存在才
  `cursorDiskKVSet`。所以**完整原生 diff 需要 before/after 全文 + 两条 blob key**；
  只有 result id 无法从 diff 反推出全文。

#### additionalData.precomputedDiff：diff 文本的 fallback

同 1200 个样本里 69 个带 `additionalData.precomputedDiff`，且 `additionalData`
只有这一个 key。形状固定：

```json
{
  "lines": [
    { "type": "added",     "content": "line", "modifiedLineNumber": 1 },
    { "type": "removed",   "content": "line", "originalLineNumber": 2 },
    { "type": "unchanged", "content": "line", "originalLineNumber": 3, "modifiedLineNumber": 2 },
    { "type": "unchanged", "content": "",     "originalLineNumber": 9, "modifiedLineNumber": 8,
      "isSyntheticUnchanged": true }
  ],
  "hasChanges": true
}
```

- added 省略 `originalLineNumber`；removed 省略 `modifiedLineNumber`；
  unchanged 两者都有；跨 hunk 空隙由 app 补空 content + `isSyntheticUnchanged:true`。
  原生样本还可能出现 `inlineChanges` / `*TokenLineNumber` 等 UI 字段（可选）。[实测+仓库]
- 69/69 样本 `hasChanges:true`；这 69 个全是新文件的 all-added diff。全局扫描
  （不限 1200 条）另外只找到 3 个含 removed/unchanged 的样本：
  - `{type:"removed",content:"--",originalLineNumber:1}`；
  - `{type:"unchanged",content:"name: …",originalLineNumber:2,modifiedLineNumber:1}`。
- 字节证据（同一份 3.6 GB 副本）：

  | 样本 | bubble | params | result | additionalData | precomputedDiff | lines |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | 新文件 canvas.tsx | 20,315 | 196 | 204 | 17,331 | 17,311 | 184（全 added） |
  | 修改 md（2 removed + 26 unchanged） | 9,977 | 1,793 | 102 | 3,821 | 3,801 | 28 |
  | MEMORY.md（3 removed + 1 unchanged） | 4,194 | 531 | 102 | 654 | 634 | 4 |

- bundle 路径 [仓库]：
  - `bGh`（offset 18,342,682）：`{lines:e, hasChanges:e.some(t=>t.type!=="unchanged")}`；
  - `rZ_` / `iZ_` / `nZ_`（18,343,xxx）：从 `diffString` 解析 hunk，跨 hunk 补
    `isSyntheticUnchanged`；没有 `@@` 时走裸 +/- 解析；
  - `bFo`（18,345,598）：只有 `beforeFullFileContent`/`afterFullFileContent` 缺失时
    才用 diff fallback；
  - edit handler（19,673,089）：success 时 `bFo(...)`，fallback 才把
    `precomputedDiff` 写进 `additionalData`，同时 `result` 仍写
    `{beforeContentId, afterContentId}`；
  - `Z3m`（30,052,240）：`afterContentId` **或** `precomputedDiff` **或**
    `isNewFile` 任一存在就产出 edit display；
  - `getCachedEditToolCallDisplay`（30,309,018）：没有 content id 时直接返回
    `{precomputedDiff, isNewFile}`；
  - UI `iUs`（11,089,208）：`if(precomputedDiff) result=precomputedDiff`，
    `hasChanges===true && lines.length>0` 才显示 diff 正文。
- schema 补充：`aiserver.v1.EditFileV2Result` 有字段 13/14
  `before_content_id`/`after_content_id`、字段 3 `diff`（FileDiff chunks）、字段 12
  `contents_after_edit`；`EditFileV2Params` 字段 7 也有 `diff`。但 1200 个真实
  edit 气泡里 `result.diff` / `contentsAfterEdit` 都是 0 次，UI 渲染也不读
  `result.diff`。所以 **不需要写结构化 `result.diff`**。

#### 必需 / 可选字段表

| 字段 | 是否必需 | 作用 / 缺失后果 |
| --- | --- | --- |
| `additionalData.precomputedDiff.lines` | diff 卡片必需（无 content id 时） | 逐行类型/内容/行号；缺失则 UI 只能走 before/after 全文计算 |
| `additionalData.precomputedDiff.hasChanges` | 必需 | `true` 且 lines 非空才显示 diff 正文 |
| `result.afterContentId` | 可选 | 指向 `composer.content.<sha256>` 全文；缺失时 diff 卡片仍能渲染 |
| `result.beforeContentId` | 可选 | 同上；缺失时 before 视为空/未知（新文件） |
| `result.diff`（FileDiff chunks） | 可选，UI 不读 | 真实样本 0 次；本 adapter 不写 |
| `params.contentsAfterEdit` / `streamingContent` | 可选 | 编辑内容/流式展示；不影响 diff 卡片 |
| `additionalData.isNewFile` | 可选 | 原生 UI 的新文件标记；本 adapter 仅在 Write 的 result 里写 `fileWasCreated` |

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

## 3. toolCallBinary 的 wire 结构（写侧实现）

`toolCallBinary` = base64(`agent.v1.ToolCall`)。app 读 composer 时
`if(e.toolCallBinary){const u=iN(e.toolCallBinary);o=ug.fromBinary(u.buffer)}`（bundle
15,981,704 起），解出来的 `toolCall` 决定工具卡片怎么渲染；缺它时 UI 只能显示文本摘要
（"Ran tool" / "Edited <file>"）。[仓库]

`agent.v1.ToolCall`（`ug`，bundle offset 14,340,506）是 oneof，本 adapter 写其中 7 个分支：

| toolFormerData.name | tool 枚举 | agent.v1.ToolCall 字段 | 真实样本首字节（base64 解码后） | 本 adapter 写 |
| --- | ---: | ---: | --- | --- |
| `run_terminal_command_v2` | 15 | 1 `shell_tool_call` | `0a c2 0f` | ✅ |
| `delete_file` | 11 | 3 `delete_tool_call` | `1a b5 04 0a ae 01 …` | ✅ |
| `glob_file_search` | 42 | 4 `glob_tool_call` | `22 f2 d8 0c` | ✅ |
| `ripgrep_raw_search` | 41 | 5 `grep_tool_call` | `2a f4 e6 0a` | ✅ |
| `read_file_v2` | 40 | 8 `read_tool_call` | `42 ff 01` | ✅ |
| `todo_write` | 35 | 9 `update_todos_tool_call` | `4a 87 04` | ❌（本次未涉及；todo 卡片仍走文本摘要） |
| `edit_file_v2` | 38 | 12 `edit_tool_call` | `62 c6 03` | ✅（96e6765 起） |
| `list_dir_v2` | 39 | 13 `ls_tool_call` | （本机库无 list_dir_v2 样本，schema 已确认） | ✅ |
| `read_lints` | 30 | 14 `read_lints_tool_call` | `72 7e` | ❌ |
| `task_v2` | 48 | 19 `task_tool_call` | `9a 01 9e 0c` | ❌ |
| `get_mcp_tools` | 63 | 44（实测样本字段 44） | `e2 02 e8 04` | ❌ |

字段号来自 `ug=S.makeMessageType("agent.v1.ToolCall", ...)`（bundle 14,340,506）：[仓库]

```js
[
 {no:1,name:"shell_tool_call",kind:"message",T:Oae,oneof:"tool"},
 {no:3,name:"delete_tool_call",kind:"message",T:j0t,oneof:"tool"},
 {no:4,name:"glob_tool_call",kind:"message",T:cFn,oneof:"tool"},
 {no:5,name:"grep_tool_call",kind:"message",T:d$e,oneof:"tool"},
 {no:8,name:"read_tool_call",kind:"message",T:$Ne,oneof:"tool"},
 {no:9,name:"update_todos_tool_call",kind:"message",T:hFn,oneof:"tool"},
 {no:12,name:"edit_tool_call",kind:"message",T:Fae,oneof:"tool"},
 {no:13,name:"ls_tool_call",kind:"message",T:K0t,oneof:"tool"},
 ...
]
```

### 3.1 各工具子消息 schema（bundle 内 `makeMessageType` 原文）

标号即 protobuf 字段号；`T:9`=string、`T:5`=int32、`T:13`=uint32、`T:3`=int64、
`T:4`=uint64、`T:8`=bool、`T:12`=bytes。所有子消息的 args/result 都是 field 1/field 2。

| 工具（ToolCall field） | 子消息 | 字段（号: 名字 类型） |
| --- | --- | --- |
| shell（1） | `ShellToolCall`（14,191,119） | 1 args `ShellArgs`、2 result `ShellResult`、3 description string |
| | `ShellArgs`（13,689,596） | 1 command string、2 working_directory string、3 timeout int32、4 tool_call_id string、5 simple_commands string[]、8 parsing_result message、9 requested_sandbox_policy、10 file_output_threshold_bytes uint64、11 is_background bool、13 timeout_behavior enum、14 hard_timeout int32、15 description string、17 close_stdin bool、21 conversation_id string |
| | `ShellResult`（13,690,964） | oneof result：1 success `ShellSuccess`、2 failure `ShellFailure`、3 timeout、4 rejected、5 spawn_error、7 permission_denied；101 sandbox_policy、102 is_background、103 terminals_folder、104 pid |
| | `ShellSuccess`（13,694,158）/ `ShellFailure`（13,695,064） | 1 command、2 working_directory、3 exit_code int32、4 signal、5 stdout、6 stderr、7 execution_time int32、10 interleaved_output、15 output_head、16 output_tail、17 elided_chars |
| delete（3） | `DeleteToolCall`（14,193,452） | 1 args `DeleteArgs`、2 result `DeleteResult` |
| | `DeleteArgs`（14,191,776） | 1 path string、2 tool_call_id string |
| | `DeleteResult`（14,191,909） | oneof result：1 success `DeleteSuccess`、2 file_not_found、3 not_file、4 permission_denied、5 file_busy、6 rejected、7 error |
| | `DeleteSuccess`（14,192,387） | 1 path、2 deleted_file、3 file_size int64、4 prev_content |
| glob（4） | `GlobToolCall`（14,194,402） | 1 args `GlobToolArgs`、2 result `GlobToolResult` |
| | `GlobToolArgs`（14,193,661） | 1 target_directory string、2 glob_pattern string |
| | `GlobToolResult`（14,193,815） | oneof result：1 success `GlobToolSuccess`、2 error `GlobToolError{1 error}` |
| | `GlobToolSuccess`（14,194,076） | 1 pattern、2 path、3 files string[]、4 total_files int32、5 client_truncated bool、6 ripgrep_truncated bool |
| grep（5） | `GrepToolCall`（14,198,028） | 1 args `GrepArgs`、2 result `GrepResult` |
| | `GrepArgs`（14,194,639） | 1 pattern、2 path、3 glob、4 output_mode、5/6/7 context_before/after/context、8 case_insensitive bool、9 type、10 head_limit、11 multiline bool、12 sort、13 sort_ascending、14 tool_call_id、16 offset |
| | `GrepResult`（14,195,473） | oneof result：1 success `GrepSuccess`、2 error `GrepError{1 error}` |
| | `GrepSuccess`（14,195,726） | 1 pattern、2 path、3 output_mode、4 workspace_results map<string, `GrepUnionResult`>、5 active_editor_result |
| | `GrepUnionResult` | oneof result：1 count `GrepCountResult`、2 files `GrepFilesResult`、3 content `GrepContentResult` |
| | `GrepCountResult`（14,196,260） | 1 counts repeated {1 file, 2 count int32}、2 total_files、3 total_matches、4 client_truncated、5 ripgrep_truncated、6/7 head_limit_applied/offset_applied |
| | `GrepFilesResult`（14,196,800） | 1 files string[]、2 total_files、3/4 truncated 标记 |
| | `GrepContentResult`（14,197,161） | 1 matches repeated {1 file, 2 matches repeated {1 line_number, 2 content, 3 content_truncated, 4 is_context_line}}、2 total_lines、3 total_matched_lines |
| read（8） | `ReadToolCall`（14,200,070） | 1 args `ReadToolArgs`、2 result `ReadToolResult` |
| | `ReadToolArgs`（14,200,205） | 1 path、2 offset int32、3 limit int32、5 include_line_numbers bool |
| | `ReadToolResult`（14,200,446） | oneof result：1 success `ReadToolSuccess`、2 error `ReadToolError{1 error_message}` |
| | `ReadToolSuccess`（14,200,751） | output oneof：1 content / 6 data / 9 data_blob_id / 10 content_blob_id；2 is_empty、3 exceeded_limit、4 total_lines uint32、5 file_size uint32、7 path、8 read_range{1 start_line, 2 end_line} |
| edit（12） | `EditToolCall`（14,205,624） | 1 args `EditArgs`、2 result `EditResult` |
| | `EditArgs`（14,203,943） | 1 path、6 stream_content |
| | `EditResult`（14,204,083） | oneof result：1 success、2 file_not_found、3 read_permission_denied、4 write_permission_denied、6 rejected、7 error |
| | `EditSuccess`（14,204,519） | 1 path、3 lines_added、4 lines_removed、5 diff_string、6 before_full_file_content、7 after_full_file_content、8 message |
| ls（13） | `LsToolCall`（14,205,930） | 1 args `LsArgs`、2 result `LsResult` |
| | `LsArgs`（13,745,179） | 1 path、2 ignore string[]、3 tool_call_id、4 sandbox_policy、5 timeout_ms uint32 |
| | `LsResult`（13,745,467） | oneof result：1 success `LsSuccess`、2 error `LsError{1 path,2 error}`、3 rejected、4 timeout |
| | `LsSuccess`（13,745,747） | 1 directory_tree_root `LsDirectoryTreeNode` |
| | `LsDirectoryTreeNode`（13,745,852） | 1 abs_path、2 children_dirs repeated（同类型递归）、3 children_files repeated {1 name}、4 children_were_processed、5 full_subtree_extension_counts map<string,int32>、6 num_files |

### 3.2 UI 到底读 toolCall 里的哪些字段

工具卡片的 view model 由 `FFm(toolCall, {callId})`（bundle 30,087,... 起）构造，逐分支读：[仓库]

| 分支 | UI 读取 | 缺失后果 |
| --- | --- | --- |
| `shellToolCall` | `args.command`、`ShellToolCall.description`（或 `args.description`）、`result.success/failure` 的 `interleavedOutput \|\| stdout+stderr` 与 `exitCode`、`timeout.timeoutMs`、`rejected.reason`、`spawnError/permissionDenied.error` | command 为空时卡片只有 "Ran command" |
| `readToolCall` | `args.path`、`result.success.read_range`（否则回退 `args.offset/limit`） | 没有 path 卡片没有文件名 |
| `grepToolCall` | `args.pattern`、`args.path`、`result.success.workspace_results`（union count/files/content → 每文件命中数） | 没有 workspace_results 就只显示 pattern |
| `globToolCall` | `args.glob_pattern`、`args.target_directory`、`result.success.path`、`result.success.files` | 没有 files 只显示 pattern |
| `lsToolCall` | `args.path`、`result.success.directory_tree_root`（`Tck` 只展平一层 childrenDirs/childrenFiles） | 没有树就没有目录列表 |
| `deleteToolCall` | `args.path`、`result.success.path/prev_content` | 没有 path 卡片没有文件名 |
| `editToolCall` | `args.path`、`result.success.path/lines_added/lines_removed/beforeFullFileContent` | 没有 path 就没有编辑卡片 |

> **shell 的特殊路径**：`kFm(toolFormerData)`（bundle 30,065,025）里 `yak(e)` 对
> `RUN_TERMINAL_COMMAND_V2 / WEB_SEARCH / ASK_QUESTION / MCP_AUTH` 返回 true，
> 此时**即使有 toolCallBinary 也忽略 toolCall**，改用 `gak(params, result)` 从
> params/result 重建 shellToolCall（为了拿 parsingResult/allowlist）。
> 也就是说 shell 的 binary 在 glass 这条渲染路径上不是必需的；但写了不冲突，
> 且其它读 toolCall 的路径（审批、终端块）仍可能用到。read/grep/glob/ls/delete/edit
> 的 `kFm` 会优先返回解码出来的 toolCall。

### 3.3 真实样本（`.tmp/cursor-app-test` 副本，40k bubble 抽样）

| 分支 | 样本数 | 实测结构 |
| --- | ---: | --- |
| read（8） | 11,381 | args{1 path, 2 offset, 3 limit}；result.success{1 content **空串**, 4 total_lines, 5 file_size, 7 path, 8 read_range}；317 B 的 binary 对应 6.4 KB 的 result → **原生不把文件正文写进 binary** |
| grep（5） | 11,367 | args{1 pattern, 2 path, 3 glob, 4 output_mode, 8 case_insensitive, 10 head_limit, 11 multiline, 14 tool_call_id, 16 offset}；success{1 pattern,2 path,3 output_mode,4 workspace_results}（content/files 两种 union 都见过；177 KB 的 binary 是全量命中） |
| glob（4） | 3,840 | args{1 target_directory,2 glob_pattern}；success{2 path,3 files[N]（相对路径，2000 条）,4 total_files=10000,5 client_truncated,6 ripgrep_truncated} |
| shell（1） | 6,197 | args{1 command,3 timeout,4 tool_call_id,5 simple_commands,8 parsing_result,9 sandbox_policy,10 file_output_threshold_bytes,13 timeout_behavior,14 hard_timeout,15 description,17 close_stdin,21 conversation_id}；result.failure{1 command,3 exit_code,5 stdout,6 stderr,7 execution_time,9 interleaved_output,12 local_execution_time_ms}；`ShellToolCall.description` 与 `args.description` 同值 |
| todo（9） | 158 | args{1 todos[N],2 merge}；success{1 todos,2 total_count,3 was_merge} |
| delete（3）/ ls（13） | 0 | 本机副本里没有样本，只有 schema + `zok`/`Kok` 合成逻辑证据 |

> 注意：`aiserver.v1.ToolCall`（`y8i`，field 1 builtin / field 2 custom）是另一套旧结构，
> 不是 `toolCallBinary` 用的消息。toolFormerData 用的是 `agent.v1.ToolCall`（`ng`）。

## 4. 写回映射（packages/adapters/cursor/src/toolformer.ts）

| IR 工具名（别名） | Cursor name | tool | params（protobuf JSON） | result / additionalData |
| --- | --- | ---: | --- | --- |
| `Bash`, `shell`, `exec_command`, `run_terminal_command` | `run_terminal_command_v2` | 15 | `command`, `cwd`, `options.timeout`, `commandDescription`, `isBackground` | result: `output`, `exitCode`, `rejected`, `notInterrupted`, `outputRaw`；additionalData: `{status,startedAtMs}` |
| `Read`, `read`, `read_file` | `read_file_v2` | 40 | `targetFile`, `offset`, `limit`, `charsLimit`(默认 1e6), `effectiveUri` | result: `contents`（+ 可选 `totalLinesInFile`） |
| `Edit`, `str_replace`, `str_replace_editor` | `edit_file_v2` | 38 | `relativeWorkspacePath`, `contentsAfterEdit` 或 `streamingContent`, `noCodeblock`, `cloudAgentEdit` | result: `resultForModel`（不含 diff 文本）+ 可选 `contentsAfterEdit`；**IR 有 `{type:'diff'}` block 时** additionalData: `{precomputedDiff:{lines,hasChanges}}`（与 app 的 diff fallback 同款） |
| `Write`, `write_file`, `create_file` | `edit_file_v2` | 38 | 同上 + 必填 `contentsAfterEdit` | 同上；有 diff 时同样写 `precomputedDiff`；result 可带 `fileWasCreated:true`；`cursor.write-mapped-to-edit`（info） |
| `Grep`, `ripgrep` | `ripgrep_raw_search` | 41 | `pattern`, `path`, `glob`, `outputMode`, `context*`, `caseInsensitive`, `type`, `headLimit`, `multiline`, `ignoreGlobs`, `offset` | **不写 result**，additionalData 摘要：`{isPruned,pattern,path,outputMode,totalFiles,totalMatches,topFiles}`（与 `fgo` 一致） |
| `Glob`, `file_search` | `glob_file_search` | 42 | `targetDirectory`, `globPattern` | result: `{directories:[{absPath,files:[{relPath}],totalFiles}]}` |
| `LS`, `ls`, `list` | `list_dir_v2` | 39 | `targetDirectory`, `ignoreGlobs` | **不写 result**，additionalData 摘要：`{isPruned,rootPath,totalDirs,totalFiles,topEntries,extensionCounts}`（与 `fYv` 一致） |
| `Delete`, `rm` | `delete_file` | 11 | `relativeWorkspacePath` | result: `{rejected,fileNonExistent,fileDeletedSuccessfully}` |
| `TodoWrite`, `update_plan` | `todo_write` | 35 | `todos`, `merge` | result: `{success,finalTodos,initialTodos,wasMerge}` |

### 4.1 每个工具写进 toolCallBinary 的字段

写得**最小但结构合法**：只填 IR 里确实有的字段，没有的省略（protobuf 默认值），
不伪造文件全文。

| IR 工具 | ToolCall 分支 | args 写什么 | result 写什么（有结果时） | 明确不写 |
| --- | --- | --- | --- | --- |
| `Bash` | shell（1） | `command`、`working_directory`（cwd）、`timeout`（options.timeout）、`is_background`、`description`（commandDescription，同值写 `ShellToolCall.description`） | `success/failure{command, working_directory, exit_code, stdout}`（错误态走 failure + stderr） | parsing_result / sandbox_policy / tool_call_id / 终端 id |
| `Read` | read（8） | `path`、`offset`、`limit` | `success{content:"", total_lines（只有 totalLinesInFile 时）, path}`；错误态 `error{error_message}` | 文件正文（原生也不写）、file_size |
| `Grep` | grep（5） | `pattern`、`path`、`glob`、`output_mode`、`case_insensitive`、`head_limit`、`multiline` | `success{pattern, path, output_mode, workspace_results{根目录: GrepCountResult 每文件命中数}}`；错误态 `error{error}` | 命中行正文、GrepContentResult/GrepFilesResult |
| `Glob` | glob（4） | `target_directory`、`glob_pattern` | `success{pattern, path, files[≤2000], total_files, client_truncated}`；错误态 `error` | ripgrep_truncated |
| `LS` | ls（13） | `path`、`ignore` | `success{directory_tree_root{abs_path, children_dirs, children_files}}`（节点 ≤500）；错误态 `error{path,error}` | num_files / extension counts |
| `Delete` | delete（3） | `path` | `success{path, deleted_file}` / `file_not_found{path}` / `error{path,error}` | file_size / prev_content |
| `Edit` / `Write` | edit（12） | `path` | `success{path, lines_added, lines_removed, diff_string}` | before/after 全文、content id |

截断策略（都在 `toolformer.ts` 顶部常量）：glob 文件列表 2000 条（超出写
`client_truncated`）、grep 每文件命中数 200 条、ls 目录树 500 个节点。
grep 只用 `GrepCountResult` 承载「每文件命中数」——这个计数来自真实结果文本，
不是编造的；命中行正文没有可靠来源，宁可不写。

没有结果（工具调用被取消）时只写 args 分支，不写 result；edit/write 在没有 diff 时
仍然完全不写 binary（保持 96e6765 之前的纯文本行为）。

状态：

| IR | toolFormerData.status |
| --- | --- |
| 有 result 且 `isError !== true` | `completed` |
| 有 result 且 `isError === true` | `error`（同时写 `error` = ToolResultError JSON） |
| 没有 result | `cancelled`（loss `cursor.tool-result-missing`，info） |

每个工具气泡：`type=2`（AI）、`text:""`、`capabilityType=15`（`COMPOSER_CAPABILITY_TYPE_TOOL_FORMER`），
`startedAtMs` = 调用时间，`completedAtMs` = 结果时间；composerData 的 header entry grouping 写
`{isRenderable:true, capabilityType:15, toolFormerTool, toolFormerStatus, toolCallId, hasText:false, toolDisplayComputed:true}`。
`edit_file_v2` 额外写 `toolCallCase:'editToolCall'`、`toolDisplayPath`，以及从
`precomputedDiff` 算出的 `editLinesAdded` / `editLinesRemoved`（与真实 header 的折叠行数一致）。
app 加载时会用 `eKi` 重算 grouping（只在不一致时替换），所以近似值不会阻塞加载。[仓库]

Edit/Write 的 diff 降级 loss（都在 `toolformer.ts` 显式记录，不静默）：

| loss code | 触发 |
| --- | --- |
| `cursor.edit-diff-mapped`（info） | 有 diff block，已写 `additionalData.precomputedDiff`；没有全文 blob，未写 content id |
| `cursor.edit-diff-unavailable`（warning） | 没有 diff block；Edit 无 before/after 全文，Write 只有 after 全文；只能显示路径/结果 |
| `cursor.edit-diff-empty`（warning） | diff block 有行但没有实际增删（全是 context） |
| `cursor.edit-diff-unusable`（warning） | diff block 为空/解析不出统一 diff 行 |
| `cursor.edit-diff-multiple`（warning） | 多个 diff block；一个气泡只映射第一个文件 |
| `cursor.edit-diff-error-result`（info） | 错误态结果带 diff block，不写 `precomputedDiff` |

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
- Edit/Write 带 diff 时，源 IR 的 `{type:'diff',text}` 原样进 `_sessionport.content`，
  读回优先返回它 → IR → Cursor → IR 的 diff 文本逐字节一致；Cursor UI 侧另由
  `additionalData.precomputedDiff` 提供原生镜像（两者来自同一个 diff 文本）。[实测]
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
- **edit diff 结构回归（2026-10-28）**：
  - 400 个真实 `additionalData.precomputedDiff` 样本经 `precomputedDiffToUnifiedDiff` →
    `parseUnifiedDiff`，变更行 0 差异；另对全局 3 个含 removed/unchanged 的样本单独验证，
    变更行同样 0 差异（读取方向按统一 diff 惯例只保留变更块 ±3 行 context，未变更的长尾
    不写进 diff 文本；因此 line 数组不保证逐项相等，变更语义保证相等）；
  - 真实库只读会话 `6095caea-6779-4e84-a80b-2e211b15efac`：816 events / 324 tool_result /
    5 个 diff block，verify 的 `toolformer-edit-diff` 全 PASS；
  - 合成 IR（`tool_result.content` 含 `{type:'diff'}`）→ 临时 SQLite：`additionalData.precomputedDiff`
    与 header `editLinesAdded/Removed` 落库、读回 diff 文本逐字节一致、`verify` 的
    `toolformer-edit-diff` + `expected-diffs` PASS（见 `test/toolformer.test.ts` / `test/diff.test.ts`）。
- **真实 Cursor UI（3.25.9）目视确认**（2026-10-21，用户实测）：测试 composer
  `7d8c3ddf-64d1-49ca-b0d7-148fd9f012a7` 在 Cursor 里正常打开，`run_terminal_command_v2`
  工具卡片渲染出命令摘要与结果正文（不是 “Ran tool” 空卡片），reasoning 显示为
  “Thought briefly”，`_sessionport` 不影响加载。当时的结论是“不需要补 `toolCallBinary`”；
  后来 edit 卡片（96e6765）证明卡片是否原生取决于 `toolCallBinary`，所以 2026-10-29 起
  所有支持的工具都写 binary。shell 在 glass 渲染路径上仍会用 params 重建（§3.2 的 `yak`），
  这解释了 2026-10-21 的观察。
- **toolCallBinary 全工具结构回归（2026-10-29）**：
  - bundle 内 7 个分支的 args/result 子消息 schema 逐字段抄进 §3.1；
  - 单测覆盖每个工具 encode→decode 往返（字段号、path/command/pattern、行数、命中数、
    文件列表、目录树、错误态）与 verify 的坏 binary 检测；
  - 真实副本库：DSH 会话（853 bubbles / 461 工具气泡）→ `.tmp/cursor-app-test`（composer
    `c0ffee00-3333-4444-8555-666677778888`），`verify --agent cursor` **31 项全 PASS**，
    `toolformer-tool-call-binary` = `binary=321 (shell:183,grep:86,read:52) bad=0 branchMismatch=0
    fieldMismatch=0 editMissing=0`；binary 体积 min 126 B / p50 1,044 B / p95 10,867 B / max 27,722 B；
  - 其余 140 个工具气泡是没有 diff 的 edit/write，按设计不写 binary（旧行为不变）。
- **真实库写入回归**（2026-10-21，sessionport 自测）：把一条真实 Claude 会话（225 events、
  103 个 tool_call）写进真实 `state.vscdb`，composer
  `7d8c3ddf-64d1-49ca-b0d7-148fd9f012a7`（标题 `[sessionport 测试] 工具卡片（PR #213 review）`）。
  `verify --agent cursor` **29 项全 PASS**（含 toolformer-fields / params-json / status /
  call-ids / extension / grouping）；读回 103 tool_call + 103 tool_result。写入前备份在
  `.tmp/cursor-write-backup-*.json`。**UI 卡片渲染仍待人工确认**（见下）。

### 推测（[推测]）

- `_sessionport` 在 app 重存气泡后仍会保留（app 对 toolFormerData 做对象展开）。
- `list_dir_v2` 的落库形态：schema 与 `fYv` 都确认会剪成 additionalData，但本机 3.6 GB 副本里
  没有 `list_dir_v2` 样本（只有 schema/代码证据）。
- Write → `edit_file_v2` + `fileWasCreated` 是近似映射；有 diff block 时 diff 卡片可用，
  否则仍只显示路径/结果。

### 未验证（需要人工在 Cursor 里确认）

1. **其余工具的 UI 外观**：shell 卡片 2026-10-21 实测正常；read / grep / glob / list / delete / edit
   的卡片**尚未逐项目视确认**。现在 binary 都写了、结构也校验过（§3.1/§6），但 Cursor 没有
   headless 入口，**是否真的渲染成原生卡片未验证**。若某类卡片仍退化成 “Ran tool”，
   优先怀疑该分支 `result` 的 oneof case（见 §3.2 的字段读取表）。
2. **app 是否回写/删除 `_sessionport`**：打开会话、发消息、退出 app 后再读库对比。
3. **edit 的 diff 卡片**：结构已验证（`additionalData.precomputedDiff` + UI 的 `Z3m` /
   `getCachedEditToolCallDisplay` / `iUs` 路径），但 Cursor 没有 headless 入口，**UI 是否
   真的显示可展开 diff 卡片未验证**。另外没有写 `beforeContentId`/`afterContentId` 与
   `composer.content.<sha256>` 全文 blob，所以“打开文件对比 / checkpoint”类操作是否可用
   也未验证——这两项需要全文，不能从 diff 文本安全反推。
4. **list_dir_v2**：没有真实样本，只有 schema/代码证据；UI 渲染未验证。

### 明确不写（记录为 loss 或文档边界）

- `toolCallBinary` 的其余分支：`update_todos_tool_call`（9）、`read_lints_tool_call`（14）、
  `task_tool_call`（19）、`get_mcp_tools_tool_call`（44）等暂不写——本 adapter 对这些工具
  本来也没有完整的 args/result 映射，宁可保留文本摘要也不写半成品 binary。
- `toolCallBinary` 里的文件正文：read 的 `content` 留空、edit 的 before/after 全文不写
  （原生落库前 `yM_` 也会清空它们，§3.3 的 317 B read 样本即证据），grep 只写每文件命中数、
  不写命中行正文。这些字段没有可靠来源，伪造会让 app 显示错误内容。
- `userDecision`：不写（本项目没有可靠来源）。
- edit 的 `beforeContentId`/`afterContentId` 与 `composer.content.<sha256>` 全文 blob：**不写**。
  原因：IR 只有 diff 文本，没有 before/after 全文；用 diff 反推全文或伪造 content id 会让
  app 读到错误文件。`precomputedDiff` 现在会写（§1.2），所以 diff 卡片不依赖这两项；
  代价是没有它们时“打开文件对比 / checkpoint”类操作不可用（结构上已确认，UI 未验证）。
- 图片工具结果：只写 `[image: ref]` 占位文本，记 `cursor.tool-result-image-dropped`。
- 未知工具 / 参数不可用：显式 `cursor.tool-call-unsupported` / `cursor.tool-input-unusable`，
  不写半成品气泡。

## 7. 复现命令

```bash
# 1) 只读复制真实库（不要直接打开真实 ~/Library/...）
cp ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb .tmp/state.vscdb

# 2) 单测（临时 SQLite 库，不碰真实库）
node --test packages/adapters/cursor/test/*.test.ts

# 2b) 只跑 diff 解析/反向生成单测
node --test packages/adapters/cursor/test/diff.test.ts

# 3) 真实样本结构验证（只读副本）
node .tmp/validate-real-toolformer.mjs .tmp/state.vscdb

# 4) 真实库只读回归（列表 + 读最近会话 + verify）
SESSIONPORT_CURSOR_HOME="$PWD/.tmp/cursor-app-test" \
  node --test packages/adapters/cursor/test/gated.test.ts

# 5) 写真实库前先 dryRun，再 confirmReal（只写 .tmp 副本，会先把计划 key 备份到 .tmp/cursor-write-backup-*.json）
#    writeCursorSession(bundle, { dryRun: true })
#    writeCursorSession(bundle, { confirmReal: true })

# 6) toolCallBinary 真实副本回归（DSH 会话 → cursor；只写 .tmp/cursor-app-test）
pnpm cli push "dsh:$HOME/.dsh/sessions/<projectKey>/<sessionId>" --to cursor \
  --home .tmp/cursor-app-test --dry-run
pnpm cli push "dsh:$HOME/.dsh/sessions/<projectKey>/<sessionId>" --to cursor \
  --home .tmp/cursor-app-test --confirm-real --id <composerId>
pnpm cli verify --agent cursor --home .tmp/cursor-app-test --id <composerId>
```

### 人工确认步骤（需要用户在 Cursor 里操作）

1. 在隔离 profile（`.tmp/cursor-app-test` 的副本）或真实库里写入一个带工具调用的测试会话；
2. 完全退出并重启 Cursor，打开该会话；
3. 检查 shell/read/edit/grep/glob/list/delete 卡片是否显示参数与结果；记录哪些卡片退化；
4. 卡片退化成 “Ran tool” 时，用 `decodeToolCallBinary` 解一下该气泡的 `toolCallBinary`：
   能解出正确分支却仍退化，说明 UI 读的是别的字段（§3.2），不是 binary 缺失；
5. 发一条新消息再退出，重新读库确认 `_sessionport` 是否仍在、气泡是否被 app 重写。
