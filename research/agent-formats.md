# 四家 AI 编程 CLI 会话存储格式调查

> 调查日期：2026-10-19，macOS，本机实测。仅结构信息（键名、枚举值、布局、版本号），
> 不含任何消息正文或字段值。供 sessionport IR 设计与 adapter 实现参考。

## 1. Claude Code 2.1.303

**存储**：`~/.claude/projects/-Users-...-<slug>/<session-uuid>.jsonl`，每行一个 JSON。
本机 129 项目目录 / 648 个 jsonl / 409MB，单文件 208B–15.6MB。时间戳 ISO 8601 UTC。
行内 `version` 字段记录写入时的 CLI 版本（样本 2.1.299）。

**行类型（`type` 枚举）**：

| type | 说明 |
|---|---|
| `user` | 键：cwd, entrypoint, gitBranch, isMeta, isSidechain, message{role,content}, parentUuid, promptId, sessionId, timestamp, userType, uuid, version（+isCompactSummary 可选） |
| `assistant` | message{container?, content, context_management?, diagnostics, id, model, role, stop_details, stop_reason, usage} + 外层公共键 |
| `system` | `subtype` 枚举：compact_boundary, api_error, local_command, stop_hook_summary, informational |
| `file-history-snapshot` / `file-history-delta` | 文件快照/增量 |
| `cost-state` | modelUsage, totalCostUSD, totalDuration, totalLinesAdded/Removed 等 |
| `last-prompt`, `mode`, `permission-mode`, `queue-operation`, `attachment`, `agent-name`, `custom-title`, `pr-link`, `relocated`, `worktree-state` | 元数据行 |

**消息块**（Anthropic 风格，`message.content` 数组）：
- assistant 块：`text` / `thinking`（键：thinking, **signature**）/ `tool_use`（键：id, name, input, caller）
- user 块：纯 string（userType=external）或数组，元素 `text` / `tool_result`（键：tool_use_id, content, is_error?）

**ID / 父子 / 分支**：sessionId = 文件名 UUID；`uuid` + `parentUuid` 构成链式 DAG（fork/rewind 由 parentUuid 指向旧节点实现）；子代理 `isSidechain: true` 混存同文件；worktree 分支有 `worktree-state`/`relocated` 行。

**独有概念**：thinking signature（加密）；compact_boundary 系统行；isMeta/userType 区分真实与派生输入；file-history 快照体系；丰富 UI 元数据行。

## 2. Codex CLI 0.162.0-alpha.17.2（Rust 重写版，sqlx）

**存储（双存储架构）**：
```
~/.codex/
├── sessions/YYYY/MM/DD/rollout-<ISO时间戳>-<id>.jsonl   # 只追加日志
├── state_5.sqlite              # 主索引(Rust/sqlx 迁移)
├── thread_history_1.sqlite     # 投影: thread_items, thread_turns(含 rollout_ordinal 行号映射)
├── logs_2.sqlite / goals_1.sqlite / memories_1.sqlite / queue_1.sqlite
├── session_index.jsonl         # 键: id, thread_name, updated_at
├── config.toml / skills/ / plugins/ / archived_sessions/
```
注意：旧版的 `history.jsonl` 已不存在。版本来源：`session_meta.cli_version` 与 `threads.cli_version` 一致。

**rollout 行格式**：顶层恒为 `timestamp`（ISO 8601）、`type`、`payload`（部分行有 `metadata`：client_authored, mcp_attribution, retained_source, user_input_order…）

| type | payload 说明 |
|---|---|
| `session_meta` | base_instructions, cli_version, context_window, cwd, git, history_mode, id, model_provider, originator, session_id, source, timestamp… |
| `response_item` | OpenAI Responses API 风格。`payload.type` 枚举：`message`(role, content[{type,text}]) / `reasoning`(content?, summary[{type,text}], **encrypted_content**) / `function_call`(id, call_id, name, arguments) / `function_call_output`(call_id, output—字符串) |
| `event_msg` | UI/流程事件：`user_message` / `agent_message` / `agent_reasoning` / `task_started`/`task_complete`(turn_id, root_turn_id…) / `token_count` / `thread_settings_applied` |
| `token_usage_record` | response_id, turn_id + usage 三级聚合（usage / turn_token_usage / thread_token_usage） |
| `turn_context` | 每回合上下文全量：turn_id, cwd, model, approval_policy, sandbox_policy… |
| `world_state` | agent 配置全局快照（state 键：model, permissions, skills, agents_md…） |

**ID / 父子 / 分支**：线程索引进 sqlite。`threads` 表：id, rollout_path, cwd, title, cli_version, git_sha/branch…；**`thread_spawn_edges`**：parent_thread_id → child_thread_id（子代理边表）；turn 级 turn_id/root_turn_id 贯穿。

**独有概念**：双存储（JSONL 日志 + sqlite 投影，rollout_ordinal 行号映射）；world_state 快照；turn_context 全量；reasoning 可整体加密（encrypted_content）；event_msg 与 response_item 双轨（模型层 + UI 层分离）。

## 3. opencode 1.19.3

**存储（纯 SQLite，Drizzle ORM）**：
```
~/.local/share/opencode/
├── opencode.db                # 全局主库(drizzle)
├── opencode-<项目slug>.db      # 旧版按项目分库(遗留)
├── storage/migration + session_diff/   # 当前均为空,疑似为同步/回滚预留
├── snapshot/<git-sha>/ shell/ tool-output/ log/ repos/
```
版本来源：`session.version` 列（本机观察到 local, 1.14.28, 1.18.21, 1.18.33 等历史值）。

**核心 4 表**：
- `project`：id(40位hex), worktree, vcs, name, time_created/updated…
- `session`：id(`ses_` 前缀), project_id, **parent_id（可空 → fork）**, slug, directory, title, version, agent, model, cost, tokens_input/output/cache_*, time_created/updated/compacting/archived, revert, metadata
- `message`：id(`msg_`), session_id, data(JSON)
- `part`：id(`prt_`), message_id, session_id, data(JSON)

**message.data 键**：role(user/assistant), time, agent, model, parentID(**消息级 fork 链**), tools, cost, tokens, finish, summary, error

**part.data 按 type**：

| type | 键 |
|---|---|
| `text` | text, time, metadata |
| `reasoning` | text, time, metadata |
| `tool` | tool(名称枚举: bash, read, glob, grep, apply_patch, task, todowrite…), callID, state{input, output, error, raw, status(completed/error), time, title} |
| `step-start` / `step-finish` | snapshot, tokens, cost |
| `file` | filename, mime, url, source |

**独有概念**：message/part 双层模型（块外置）；子代理不是独立会话而是同表 `agent` 列；step 快照 part；session_diff 目录。

## 4. Kimi Code 2.1.1

**存储**：
```
~/.kimi-code/
├── sessions/wd_<工作目录名>_<12hex>/        # 工作区目录
│   └── session_<uuid>/
│       ├── state.json        # agents, archived, cwd, id, lastPrompt, title, version…
│       ├── agents/<agentId>/wire.jsonl     # agentId: main, agent-0, agent-1…
│       ├── logs/ media/f_<uuid>.png + meta/ notify/
├── session_index.jsonl       # {sessionDir, sessionId, workDir} / {deleted, sessionId}
├── workspaces.json / config.toml / tui.toml / search-index/ / file-history/ / user-history/ / oauth/
```
时间戳为 **epoch 毫秒**（`time` 字段）。版本来源：`state.json.version`（会话目录格式=2）、`metadata.protocol_version`=1.5。
本机 180 个 session 目录 / 99 个 wire.jsonl / 9.7MB。

**wire.jsonl 事件类型（29 种，按域分组）**：
- turn 生命周期：`turn.prompt`(turnId 整数序号, input 数组, promptId=`msg_` 前缀), `turn.ended`, `turn.cancel`, `turn.step.interrupted`
- agent：`agent.turn.started/ended`, `agent.message.appended`, `agent.switched`(**base, branch, legacyUndoLine, turns, reason — 分支/撤销显式建模**)
- 上下文：`context.append_message`(message{role, content, origin, toolCalls, id?}), `context.append_loop_event`(event.type: `step.begin`/`step.end`, `content.part`(**part.type: text / think**), `tool.call`(toolCallId, name, args), `tool.result`(toolCallId, result, parentUuid)), `context.undo`, `context.undone`(fromTurnId, turns)
- LLM：`llm.request`(model, messageCount, thinkingEffort, systemPromptHash, toolsHash…), `llm.tools_snapshot`
- 子代理：`subagent.spawned`(**parentAgentId, parentToolCallId, subagentId, taskId, runInBackground, model…**), `subagent.started`
- 用量：`usage.record`, `token_counting.measured/truncated/turn_recorded`
- 配置：`metadata`, `profile.bind`, `config.update`, `permission.set_mode`, `mcp.tools_discovered`, `interaction.request/resolved`(人机交互挂起/恢复)

**ID / 父子 / 分支**：session UUID = 目录名；workDir 映射由 session_index.jsonl 维护；分支/撤销 = `agent.switched`(base/branch/legacyUndoLine) + `context.undo/undone` 事件对；子代理 = 独立 agent 目录 + `subagent.spawned` 三元组(parentAgentId/parentToolCallId/taskId)。

**独有概念**：事件溯源最彻底（一切皆是事件）；显式 undo/branch 事件对；subagent 显式记录 parentToolCallId/runInBackground；内容哈希（systemPromptHash/toolsHash）代替全文；interaction 挂起式交互；附件独立 media/ 目录。无独立 compact/summary 事件（最接近的是 token_counting.truncated 与 undo）。

## 横向对比

**共有概念**：会话唯一 ID；user/assistant 分角色；thinking/reasoning（明文三家 + Codex 可密文）；tool_call↔tool_result 配对（id/call_id/callID/toolCallId 键名不一）；父子/fork 概念（四家四种模型）；token/成本统计；子代理标记。

**对 IR 设计的直接提示**：
1. 共通 IR 核心：`(session, turn, message, part)` 四层 + 链式 parent 指针可覆盖全部四家
2. IR 以"追加事件流"为规范形态（最易从四家双向转换）
3. reasoning 需兼容明文（含签名）与密文（opaque）两种形态
4. tool 配对键名统一为单一 callId
5. subagent 采用"独立 session + parent 边"的最通用模型，import 时归一化
6. IR 每个 session 保留来源指纹 `{agent, cliVersion, formatVersion}`——四家都有版本字段可探测
7. 时间戳单位不一（ISO 8601 vs epoch 秒 vs epoch 毫秒），IR 统一 ISO 8601
