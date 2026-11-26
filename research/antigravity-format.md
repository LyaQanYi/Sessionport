# Antigravity 本机存储格式与适配器说明

实测版本：**Antigravity App 2.35.2**（macOS），以及 **`agy` CLI**（`~/.gemini/antigravity-cli`）。

## 1. 目录结构

- **App / IDE 主目录**：`~/.gemini/antigravity/`
  - `brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`：完整未截断的明文步骤日志（每行一条 JSON）。
  - `brain/<conversationId>/.system_generated/logs/transcript.jsonl`：部分历史/轻量会话的截断版本（带 `truncated_fields` 列表）。
  - `conversation_summaries.db`：SQLite 摘要与全文索引库，含 `conversation_summaries`（`title`、`preview`、`workspace_uris`、`last_modified_time`、`parent_conversation_id`、`agent_name`、`nesting_depth`）及 `conversations_fts`（`archived`）。
  - `annotations/<conversationId>.pbtxt`：用户修改后的标题（`title:"..."`）与状态。
  - `conversations/<conversationId>.db`：**会话真实加载态存储**，内部 `steps` 表的 `step_payload` 列为私有二进制 Protobuf blob（非 JSON）。
- **CLI 目录**：`~/.gemini/antigravity-cli/`，目录结构与摘要库 schema 同构。

## 2. 为何采用「原生无损读出 + 官方降级上下文交接导入」

Antigravity App/IDE 运行时真正用于恢复多轮气泡的存储位于 `conversations/<conversationId>.db` 内的私有二进制 Protobuf（并伴随桌面端 daemon / WAL 写锁与 `agyhub_summaries_proto.pb`），而语言服务器暴露的公开 RPC `product.v1.ConversationService/CreateConversation` 仅支持以初始提示词新建对话，没有导入任意多轮 `tool_call` / `tool_result` 气泡的公共接口。

因此 `@sessionport/adapter-antigravity` 采用官方安全策略：
- **转出（读 + 校验）**：无损解析明文 `transcript_full.jsonl` + SQLite 元数据 + `.pbtxt` 标题。
- **转入（`--to antigravity` 写）**：生成结构化交接文档 `<home>/scratch/sessionport-handoffs/<id>.md` 与无损归档 `<id>.ir.json`；若配置了 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN`（且未开启 `--handoff-only`），则从 `conversation_summaries.db` 匹配 `project_id` 并调用 `ConversationService/CreateConversation` 直接新建会话；否则仅产出本地交接文档供复制提示词续聊。
- 适配器声明 `supportsInPlaceRewrite: false`，明确所有降级 `losses` 并阻止 `merge-back` 原位改写。

## 3. JSONL 步骤格式与 IR 映射

| Step `type` | 典型字段 | IR 映射 | 备注 |
|---|---|---|---|
| `USER_INPUT` | `content` | `message(role='user')` | 提取 `<USER_REQUEST>...</USER_REQUEST>`；`<CONTEXT_SUMMARY>` 标 `synthetic: true`；剥离 `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` |
| `PLANNER_RESPONSE` | `thinking`, `content`, `tool_calls[]`, `model` | `reasoning(plain)` + `message(role='assistant')` + `tool_call[]` | `tool_calls` 支持对象 `{ name, args }` 与字符串化 JSON，按 FIFO 入队待配对 |
| `GENERIC` | `content`, `status`, `error` | `tool_result` | 与前面 `pendingCalls` 1:1 队头配对；剥离 `Created At` / `Completed At` 头行；`ERROR` 或 `error` 设 `isError: true` |
| `CHECKPOINT` | `content` | `boundary(boundary='compact')` | 记 `antigravity.compact-boundary` info |
| `SYSTEM_MESSAGE` | `content` | 跳过（不打断配对） | 记 `antigravity.system-messages-skipped` info |
| `ERROR_MESSAGE` | `error`, `content` | 跳过 | 记 `antigravity.error-messages-skipped` info |

## 4. 工具参数归一（`packages/core/src/tools.ts`）

Antigravity 工具名采用 snake_case，参数大多使用 PascalCase：

- `run_command`: `CommandLine` / `Cwd` / `WaitMsBeforeAsync` / `toolSummary` → `shell`
- `read_file` / `view_file`: `Path` / `AbsolutePath` / `StartLine` / `EndLine` → `read`（`limit = EndLine - StartLine + 1`）
- `write_file` / `write_to_file`: `Path` / `TargetFile` / `Content` / `CodeContent` → `write`
- `edit_file` / `replace_file_content`: `Path` / `TargetFile` / `Target` / `TargetContent` / `Replacement` / `ReplacementContent` → `edit`
- `grep_search`: `Query` / `Pattern` / `SearchDirectory` / `SearchPath` / `CaseInsensitive` → `grep`
- `find_by_name`: `Pattern` / `SearchDirectory` / `Path` → `glob`
- `list_dir`: `DirectoryPath` / `Path` → `list`
- `update_steps`: `steps[].title` / `steps[].status` → `todo`

## 5. 子代理与 Swarm 子会话

同时通过两条途径发现子会话并读入 `bundle.children`：
1. 解析 `invoke_subagent` 工具返回文本里的 `"conversationId"`（关联 `viaToolCallId` 与 `Role` / `TypeName`）；
2. 查询 `conversation_summaries.db` 中 `parent_conversation_id = <rootId>` 的行（涵盖原生 `/swarm` worker，取 `agent_name` 为 `label`）。
