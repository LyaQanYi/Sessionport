# Cursor composer headers：read 卡片不显示的原因与 header 形状

调查对象：Cursor 3.25.9（`/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.glass.main.js`）
与真实库 `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`、副本库
`.tmp/cursor-app-test`。结论用于 `packages/adapters/cursor/src/write.ts` 的
`composerData.fullConversationHeadersOnly` 写入。

## 1. 结论

Cursor 打开 composer 时，先按 `fullConversationHeadersOnly` 逐条加载气泡
（`composerMigrations.js` 的 `sck()` → `getInitialMessages(composerId, headers)`），
再用气泡重算 grouping（`rck()` → `kms(bubble)` → `eDi(header.grouping, 重算值)`）。
header 不只是缓存：渲染层 `composerTranscriptEntries.js` 的 `h8v()` 在气泡尚未加载时
直接用 header.grouping 生成占位行（`lWi()` 的 `summaryToolCase/summaryPath`）。

所以 header.grouping 必须和 app 从气泡重算出的 grouping 一致。sessionport 早期写出的
header 只有 `capabilityType/toolFormerTool/toolFormerStatus/toolCallId`，缺
`toolCallCase`、`toolDisplayPath`、`isToolGroupable` 和 `hasText/textPreview` 等字段，
read 行被折叠进 worked-for 分组时没有可显示的 case/path，整行消失；shell/edit 仍能因为
独立渲染路径显示出来（edit 另有 diff 卡片）。补齐 header 后，read/grep/glob/ls/delete
的 header 与原生样本一致。

## 2. 原生 header 完整字段表（实测）

样本：`8b130de0-5b69-4719-bd3a-74e598c882bb`（208 个气泡 / 208 个 header）。

### human（type=1）

```json
{
  "bubbleId": "b67ae1a3-…",
  "type": 1,
  "grouping": {
    "isRenderable": true,
    "hasText": true,
    "isShortPlainText": true,
    "textPreview": "…",
    "toolDisplayComputed": true
  },
  "contentHeightHint": 68,
  "createdAt": "2026-10-11T02:47:20.594Z",
  "startedAtMs": 1791686840594,
  "completedAtMs": 1791686840594
}
```

- `isShortPlainText`：`I9a()`，文本 ≤100 字符、≤2 行、不匹配下面的正则时才写：

  ~~~text
  /```|^#{1,6}\s|^\s*[-*]\s|\|.*\|/m
  ~~~
- `textPreview`：第一行非空文本 → 去 markdown/压缩空白 → 280 字符截断 + `…`
  （`XMi()/J_l=280`）。真实库 60 个 composer 抽样 79 条 preview，最长 118；
  app 加载时 `gTf()` 会删掉 `textPreview`，它不是渲染分组比较字段。
- `contentHeightHint` 由 `fbl()/yms()` 估算，可选；writer 不写。
- human 气泡本身也带 `startedAtMs/completedAtMs`，header 由 `hx(bubble)` 复制。

### AI 文本（type=2，无 capabilityType）

```json
{
  "bubbleId": "f70e96b2-…",
  "type": 2,
  "grouping": {
    "isRenderable": true,
    "hasText": true,
    "isShortPlainText": true,
    "textPreview": "…",
    "isKeptFinalAiVisibleOutsideWorkedForGroup": true,
    "toolDisplayComputed": true
  },
  "createdAt": "2026-10-11T02:47:25.835Z",
  "startedAtMs": 1791686845835
}
```

- `isKeptFinalAiVisibleOutsideWorkedForGroup` 来自 `kms()`：AI 且
  (`toolFormerTool === TASK_V2` 或 `capabilityType === undefined && hasText`)。
- `turnDurationMs` 只在气泡带该字段时出现，writer 不写。

### thinking（type=2，capabilityType=30）

```json
{
  "bubbleId": "21508bbf-…",
  "type": 2,
  "grouping": {
    "isRenderable": true,
    "capabilityType": 30,
    "hasThinking": true,
    "thinkingDurationMs": 2896,
    "toolDisplayComputed": true
  },
  "createdAt": "2026-10-11T02:47:22.938Z",
  "startedAtMs": 1791686842938
}
```

writer 的 IR reasoning 没有可靠时长，`thinkingDurationMs` 省略；header 与气泡重算结果一致
（都不带该字段）。

### 工具（type=2，capabilityType=15）

read：
```json
{
  "bubbleId": "583c795a-…",
  "type": 2,
  "grouping": {
    "isRenderable": true,
    "capabilityType": 15,
    "toolFormerTool": 40,
    "toolFormerStatus": "completed",
    "toolCallId": "call-…",
    "isToolGroupable": true,
    "toolCallCase": "readToolCall",
    "toolDisplayPath": "/abs/path/file.ts",
    "toolDisplayComputed": true
  },
  "createdAt": "2026-10-17T12:22:25.486Z",
  "startedAtMs": 1792239745486,
  "completedAtMs": 1792239745670
}
```

shell 额外带 `shellStatus`（`additionalData.status`），不带 `toolDisplayPath`：
```json
"grouping": {
  "isRenderable": true, "capabilityType": 15, "toolFormerTool": 15,
  "toolFormerStatus": "completed", "shellStatus": "success",
  "toolCallId": "call-…", "toolCallCase": "shellToolCall",
  "toolDisplayComputed": true
}
```

edit 带 `toolDisplayPath` 与 `editLinesAdded/editLinesRemoved`，不带 `isToolGroupable`：
```json
"grouping": {
  "isRenderable": true, "capabilityType": 15, "toolFormerTool": 38,
  "toolFormerStatus": "completed", "toolCallId": "call-…",
  "toolCallCase": "editToolCall", "toolDisplayPath": "/abs/path",
  "editLinesAdded": 3, "editLinesRemoved": 0, "toolDisplayComputed": true
}
```

工具 header 不含 `hasText/hasThinking`（它们是 undefined，不会序列化）。

## 3. 实现映射（write.ts）

| toolFormerTool | toolCallCase | toolDisplayPath 来源 | isToolGroupable |
|---|---|---|---|
| 15 RUN_TERMINAL_COMMAND_V2 | `shellToolCall` | 无 | 仅当命令是单独 `ls`（`TFa()`） |
| 40 READ_FILE_V2 | `readToolCall` | `params.targetFile` | true |
| 38 EDIT_FILE_V2 | `editToolCall` | `params.relativeWorkspacePath` | false（省略） |
| 41 RIPGREP_RAW_SEARCH | `grepToolCall` | `params.path` | true |
| 42 GLOB_FILE_SEARCH | `globToolCall` | 无（GlobArgs 没有 path） | true |
| 39 LIST_DIR_V2 | `lsToolCall` | `params.targetDirectory` | true |
| 11 DELETE_FILE | `deleteToolCall` | `params.relativeWorkspacePath` | false（省略） |
| 35 TODO_WRITE | `updateTodosToolCall` | 无 | false（省略） |

- `toolFormerStatus` = `toolFormerData.status`；`toolCallId` = 气泡的 `toolCallId`。
- `isToolGroupable` 的集合来自 bundle 的 `GTm`：web_search/web_fetch/list_dir(_v2)/
  ripgrep(_raw)/semantic/file/glob/read_semsearch/search_symbols/go_to_definition/
  read_file(_v2)/todo_read/fetch_rules/read_lints/await/get_mcp_tools；shell 由 `TFa()`
  判定（单独 `ls`，无 `|;&`、`$(`、反引号、重定向）。
- `toolDisplayPath` 是 app 从解码后的 `ToolCall.args.path` 取的；writer 用等价 params 字段还原。
  用 `toolCallBinary` 解码结果交叉校验（verify 的 `headers-tool-grouping`）。
- `editLines*` 从 `additionalData.precomputedDiff` 统计，和 `EditSuccess.lines_added/removed` 一致。

## 4. header 与气泡的一一对应、其它字段

> 关于“writer 写出的 headers 是空数组”：真实库里 `a8316eb3-26e0-40e6-8313-57b8cc9f188a`
> （标题「【sessionport 测试】工具卡片验证」，2026-10-16 写入）确实 headers=0 / bubbles=229。
> 它是 header 功能（commit 6f72623，2026-10-20）之前写出的旧测试 composer，不代表当前 writer；
> 当前 writer 在副本库/真实库新写的 composers 都是 headers=bubbles（本次回归 8/8）。
> 旧 composer 里 header 为空会让 `rDi()` 把它当空草稿，气泡只能走另一条读取路径，
> read 行的分组信息完全丢失。

- sampled 原生 composer `8b130de0`：208 headers = 208 bubbles。
- 子代理 composer `5bd9cb3c`：123 headers / 237 bubbles —— 多出的 114 个是 header 未引用的
  旧气泡（read/shell/thinking），不会参与渲染。**header 才是渲染列表**，气泡多不等于要写 header。
- writer 每个气泡写一条 header，顺序 = 事件/写入顺序，`type`/`createdAt` 与气泡相同。
- `conversationMap`：原生存储中通常为 `{}`（抽样全部为空），app 加载时由 headers 重新填充。
- `hasLoaded`：存储里是 true，app 反序列化时会置 false 再加载；writer 保持 true 即可。
- `conversationState`：原生是加密 protobuf 字符串；`'~'` 解码为空 `ComposerConversationState`。
  header 路径（legacy bubble JSON）不依赖它，本次测试 composer 用 `'~'` 能正常校验/读回。
- `contentHeightHint`、`turnDurationMs`、`timingInfo` 都是可选展示提示，writer 不写。

## 5. 证据（bundle 符号）

- `kms(bubble)`：从气泡计算 grouping（`isRenderable/capabilityType/toolFormer*/shellStatus/
  toolCallId/hasText/hasThinking/isShortPlainText/textPreview/textPreview 上限 280/
  isKeptFinalAiVisibleOutsideWorkedForGroup/isToolGroupable/toolDisplayComputed`）。
- `gok(toolFormerData)`：从解码后的 `toolFormerData.toolCall.tool` 生成
  `toolCallCase/nativeToolCallCase/toolDisplayPath/editLines*/mcp*`。
- `hx(bubble)`：用 `kms()` 生成 header，并复制 `contentHeightHint/createdAt/timingInfo/
  startedAtMs/completedAtMs`。
- `eDi(a,b)`：按 `STf` 字段表比较两个 grouping；`rck()` 在加载时用重算值覆盖不一致的 header。
- `sck()`：`_v>=2` 时 `getInitialMessages(composerId, fullConversationHeadersOnly)`，
  随后 `rck()`。
- `h8v(header)` / `AgC(bubble)`：header 生成占位 tool 行（`summaryToolCase/summaryPath`），
  气泡加载后由 `AgC()` 用 toolFormerData 生成真实活动行。
- `fullConversationHeadersOnly.length===0` 时 `rDi()` 把 composer 当空草稿；这是旧测试 composer
  （2026-10-16 写入、header 功能之前）没有 read 行的直接原因。

## 6. 验证

- 单元测试：`packages/adapters/cursor/test/headers.test.ts`（3 条）覆盖
  headers 数量/顺序/type/createdAt、human/AI/thinking/tool 形状、verify 能发现
  `toolCallCase`/`toolDisplayPath` 缺失与文本 header 退化。
- 副本库回归：`11eb7e0d-bc75-4764-afb3-0dd475058bd4`（8 headers / 8 bubbles，
  shell/read/grep/edit）→ `verify` 35/35 PASS。
- 真实库测试：`99c1076b-1ee2-48c6-9994-02f931778ccc`（标题
  「【sessionport 测试】read 卡片 v2」）→ 35/35 PASS；桌面 UI 是否出现 read 行仍需重启
  Cursor 后人工确认（Cursor 没有 headless 渲染入口）。

## 7. 已知边界

- 桌面 UI 最终可见性无法自动化；本次只保证结构/分组与原生样本一致。
- read 卡片展开后的文件正文：writer 沿用原生做法清空 `ReadToolSuccess.content`，不伪造内容；
  UI 打开文件需要 Cursor 自己从磁盘读取。
- 原生 composer 可能存在 header 未引用的旧气泡；writer 不产生这类孤儿，verify 的
  `bubble-count` 对导入/测试会话按“一一对应”校验。
- `toolDisplayPath` 目前不写 glob（原生 GlobArgs 无 path）；如果 Cursor 后续给 GlobArgs 加 path，
  需要同步扩展。

## 8. Cursor 3.27 的 header 迁移（2026-10-30）

3.27.22 首次打开一个 sessionport 写入的 composer 时，会把 legacy header **迁移成分块存储**：

| 迁移前 | 迁移后 |
|---|---|
| `composerData.fullConversationHeadersOnly` = 229 条（84829 B） | `[]`，composerData 缩到 ~3304 B |
| — | `composerData.headerLog = {chunkSize:256, chunkCount:1, count:229, generation:…}` |
| — | key `composerConvHeaders:<composerId>:000000`（6 位序号，76699 B JSON 数组） |
| — | `composerRootWriterDiagnostic:<composerId>` |

数据不丢（229 条 header 内容完整），但**按旧字段读回会得到 0 条**。实测后果（修复前）：

```
FAIL  conversation-headers  (0 条)
FAIL  no-orphan-bubbles     (orphan=229)
FAIL  bubble-count          (db=229 headers=0)
```

修复：

- `wire.ts` 新增 `readMigratedConversationHeaders(db, composerId, data)`：按 `headerLog.chunkCount`
  逐块读 `composerConvHeaders:<id>:<6 位>`，拼回 header 数组；缺块/坏 JSON 返回 `undefined`
  让调用方退回旧逻辑。
- `verify.ts` 的 `conversation-headers`：legacy 数组为空时改用迁移后的 header，detail 标
  `（3.27 分块迁移）`。
- `read.ts` 的 `conversationHeaders()`：同样先读迁移块，再退回 createdAt 排序兜底。
- 回归测试：`headers.test.ts` 新增一条，把 9 条 header 拆成 4/4/1 三块模拟 3.27 迁移，
  断言 verify 全绿、headers-count=229 对应、读回 tool_call=6。

修复后同一个库：`conversation-headers (229 条（3.27 分块迁移）)`，
`headers-count (headers=229 bubbles=229)`，结构化校验通过。

另一个 3.27 行为（不是 sessionport 的问题，但会影响测试环境）：`AgentStores` 的写入路径写死在
真实库 `~/Library/Application Support/Cursor/AgentStores`，`--user-data-dir` 不隔离。
用副本库做回归前要先备份该目录。
