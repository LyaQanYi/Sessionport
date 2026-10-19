# Codex CLI 0.163 会话格式与 resume 契约

> 调查日期：2026-10-19，macOS，本机实测（codex-cli 0.163.0）。只记结构，不含消息正文。

## 1. 存储布局

```
~/.codex/
├── sessions/YYYY/MM/DD/rollout-<local ISO>-<session-uuid>.jsonl   # 会话正文（append-only）
├── state_5.sqlite                # threads 索引（id, rollout_path, cwd, title, history_mode, cli_version …）
├── thread_history_1.sqlite       # 新投影（thread_items / thread_turns，迁移后才用）
├── session_index.jsonl           # { id, thread_name, updated_at }
└── config.toml                   # 模型/provider/项目信任
```

目录可由 `CODEX_HOME` 覆盖（实测有效，隔离测试用）。

## 2. rollout 行格式

每行 `{ timestamp, type, payload }`（`response_item` 行可能多一个 `metadata`）。双轨记录：

| 层 | type | payload | 用途 |
|---|---|---|---|
| 模型层 | `response_item` | `message` / `reasoning` / `function_call` / `function_call_output` | 对话内容（reader 以此为准） |
| UI 层 | `event_msg` | `user_message` / `agent_message` / `agent_reasoning` / `token_count` / `task_started` / `task_complete` / `thread_settings_applied` | UI 镜像（跳过，否则内容翻倍） |
| 元数据 | `session_meta` | 会话头，每轮一份（只有 memory_mode/git 变化） | 必需 |
| 元数据 | `turn_context` / `world_state` / `token_usage_record` | 每轮上下文/状态快照/用量 | 跳过 |

`response_item` 的 payload 形状：
- `message`: `{ id, role, content: [{ type: input_text\|output_text, text }] }`
- `reasoning`: `{ id, summary: [{ type: summary_text, text }], content, encrypted_content }`
- `function_call`: `{ id: fc_…, name, arguments: JSON 字符串, call_id }`
- `function_call_output`: `{ id: fco_…, call_id, output: 字符串 }`

## 3. resume 契约（实测，mock 模型探针 + 真实模型）

**最小可行**：一个 `session_meta` + 一条 user `response_item` 即可 `codex exec resume <id>`。

`session_meta` 必需字段（删一个就 resume 失败）：
`timestamp`（行级时间戳）、`id`、`cwd`、`originator`、`cli_version`；
`session_id` / `runtime_workspace_roots` / `source` / `thread_source` / `base_instructions` / `model_provider` 可省。
`history_mode` 只能是合法值（`legacy` 或不写）；写 `paginated` 或不认识的值会失败。

**发现方式**：扫描 `sessions/` 下的 rollout（目录层级、日期目录名、文件名里的 id 都不严格）；
`state_5.sqlite` 与 `session_index.jsonl` 不是 resume 的必需项，但决定桌面端/列表是否可见与标题。
放在 `sessions/` 之外则找不到（`no rollout found for thread id`）。

**真实模型验证**：
```bash
CODEX_HOME=<iso> codex exec resume <id> --skip-git-repo-check --json "Reply with exactly: RESUME_OK"
# → {"type":"thread.started",...} → {"item...agent_message":"RESUME_OK"} → turn.completed
```
`--skip-git-repo-check` 在 cwd 不是受信任 git 仓库时必需。resume 会往同一 rollout 追加新行
（`event_msg` / `turn_context` / `token_usage_record` / `world_state`），校验器需要容忍这些追加。

## 4. 实现要点（spike 实测补充）

完整契约见 [codex-spec.md](./codex-spec.md)，adapter 里已经落实的关键约束：

- **最小会话 = 3 行**（session_meta + 一条 user + 一条 assistant），不需要预写 sqlite 或任何索引
- `session_meta.payload` 必需 5 字段：`id` / `timestamp` / `cwd` / `cli_version` / `originator`；
  `session_id`、`source`、`thread_source`、`model_provider`、`base_instructions` 可省
- **每行都必须有顶层 timestamp**（缺了不报错，但该条历史会被静默丢弃）
- user 消息的 content type 必须是 `input_text`、assistant 必须是 `output_text`（错配静默丢弃）
- **session id 必须是合法 UUID**：非 UUID 时 `exec resume` 会静默新建线程（exit 0）
- rollout 必须放在 `$CODEX_HOME/sessions/**` 下且 basename 匹配 `rollout-*.jsonl`（前缀后缀都是硬要求）
- **resume 使用进程 cwd，忽略 rollout 里的 cwd** → 调用时必须 `cwd = session.cwd`
- `--last` 依赖 `state_5.sqlite`，刚写入的新 rollout 需要先显式 resume 一次
- **paginated 形态**（0.163 默认）：`history_mode="paginated"` + 每行递增 `ordinal`；
  adapter 已支持 `historyMode` 选项，无需写投影库
- 0.163 已忽略 `disable_response_storage`，`--json` 会多出非致命 error item，解析要容忍

> 逐字段探针记录见 `.spikes/codex-resume/evidence/variants*.json`（本地，gitignored）。