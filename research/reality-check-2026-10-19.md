# 事实核对：DESIGN.md 与本机实测的差异

> 核对日期：2026-10-19（DESIGN.md 定稿数小时后），macOS，本机实测。
> 目的：记录文档里已经过时或与事实不符的格式假设，作为 adapter 实现的当前基线。
> 本文只记结构事实，不含消息正文。

## 1. Codex：0.162 → 0.163，双存储正在变三态

| 项 | DESIGN / research 记录 | 实测（2026-10-19） |
|---|---|---|
| 版本 | `0.162.0-alpha.17.2` | `codex-cli 0.163.0` |
| 存储 | rollout JSONL + `state_5.sqlite` 投影 | 仍是，但新增迁移态 |

`state_5.sqlite` 新增：
- `threads.history_mode` 列（当前唯一一条线程为 `legacy`）
- `rollout_migration_state` 表：本机记录 `legacy_to_paginated_v1`
- 投影库 `thread_history_1.sqlite`：`thread_items` / `thread_turns` / `thread_realtime_items` / `thread_history_projection_state`（当前全空）
- `threads.cli_version`、`threads.preview`、`threads.recency_at`、`threads.project_id` 等新列；另有 `rollout_migration_skipped_rollouts`、`external_agent_config_imports`、`project_idempotency_keys` 等新表

**结论**：Codex 正在从「rollout JSONL 为准」迁移到「分页历史投影」。M1 的「写 rollout + 写 sqlite」不再充分，adapter 需要探测 `history_mode` 并决定写入哪一侧，且迁移期间两种形态会并存。

## 2. opencode：不止 message/part，已出现 v2 事件模型

`~/.local/share/opencode/opencode.db` 有 20 条 drizzle migration，同时存在两套模型：

- 旧模型：`session` / `message` / `part`（本机 19 会话 / 132 消息 / 644 part，版本 `1.14.28` `1.18.21` `1.18.33` `local`）
- 新模型：`session_v2` + `session_message`（`seq` 有序；`type` 实测有 `user` / `assistant` / `idle` / `model-switched` / `synthetic`；`data` 内联 content，assistant 的 reasoning 带 `signature`）
- 另有空的 `event` / `event_sequence` 表（事件溯源改造的骨架）

`session_v2` 新增 `parent_id` / `fork_session_id` / `fork_boundary` / `workspace_id` / `time_suspended` / `resume_attempts` / `idle_outcome` 等列。

**结论**：opencode adapter 至少要同时支持两套 schema；DESIGN 里「4 张核心表」的描述只覆盖旧模型。

## 3. Kimi Code：push 不是「事件合成」，而是「写目录 + 登记索引」

CLI 2.1.1 提供 `kimi export`（ZIP）、`kimi fork`、`kimi session list --json`，**没有 import**。

- `kimi export` 产出的 ZIP 解开后与原生会话目录**结构一致**：`state.json` / `agents/<id>/wire.jsonl` 逐字节相同，额外多一个 `manifest.json`、少 `agents/<id>/file-history/`
- 桌面端导出的 bundle 比 CLI 多 `logs/kimi-desktop.log`、`logs/kimi-web.jsonl`，manifest 字段也略有差异 → **两种导出器不能混为一谈**
- `kimi export` 默认把全局诊断日志打进包（`--no-include-global-log` 才排除）
- 工作区目录名规则可逆：`wd_<小写 basename>_<sha256(workDir) 前 12 位>`，本机 9 个目录 9/9 命中
- `session_index.jsonl` 是 append-only 索引（`{sessionDir, sessionId, workDir}` 与 `{deleted, sessionId}` 两种行）；磁盘上 90 个会话目录全部有对应索引行

**结论**：Kimi adapter 的 push 工作量低于 DESIGN 预估（M3 → 可提前），核心是事件合成 + 目录/索引写入 + 版本指纹。

## 4. Kimi 的版本指纹有三个口径

同一个会话目录里：

- `manifest.kimiCodeVersion` = `1.1.0`（bundle 导出器版本）
- `state.json.version` = `2`（会话目录格式）
- `metadata.protocol_version` = `1.5`（wire 协议）
- 而 `kimi --version`（本机 CLI）是 `2.1.1`

**结论**：`{agent, cliVersion, formatVersion}` 三元组不足以表达；IR 里拆成 `cliVersion` / `formatVersion` / `protocolVersion` 三字段，且每个 adapter 要说明各自取值的来源。

## 5. Claude Code：格式稳定，但出现了文档未记的行类型

- 129 个项目目录 / 652 个 jsonl / 413MB，与 research 记录一致
- 新增行类型 `{"type":"atis-latch","atis":"","sessionId":"..."}`（单会话 270 条），research 的枚举里没有
- 真实会话里 `assistant.message.content` 的块类型以 `tool_use` / `thinking` / `text` 为主

**结论**：解析器必须把未知行类型原样透传/跳过，不能因为不认识就报错。

## 6. 会话树不是会话

一个 Kimi bundle 包含 `main` 与若干子代理（本机样本 `agent-0`，`labels.profileName=explore`），
`state.json.agents` 记录 `parentAgentId`，父侧 `subagent.spawned` 记录 `parentToolCallId`。

**结论**：IR 顶层是 bundle（根会话 + 子会话边），不是单个 session；DESIGN 的「独立 session + parent 边」方向正确，但需要显式的 `IrBundle` 容器。
