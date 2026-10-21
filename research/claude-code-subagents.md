# Claude Code 子代理 transcript（磁盘布局与读取策略）

最后验证：2026-10-21（Claude Code 2.1.303 / 2.1.301 写出的真实数据）

## 布局

```
<CLAUDE_CONFIG_DIR>/projects/<projectSlug>/
├── <sessionId>.jsonl                                  # 主会话
└── <sessionId>/
    └── subagents/
        ├── agent-<agentId>.jsonl                      # Task 子代理正文（与主会话同格式）
        ├── agent-<agentId>.meta.json                  # 子代理元数据
        └── workflows/
            └── <wfId>/
                ├── journal.jsonl                      # launched / started / result
                └── agent-<agentId>.jsonl              # workflow 子代理正文
```

- 子代理正文行也带 `isSidechain: true` 与 `agentId`，首行 `parentUuid: null`，自身构成一条完整事件链。
- 主会话里**可能**同时存在 `isSidechain` 镜像行，也可能只有 `Agent`/`Task` 工具调用，正文只在磁盘文件里。

## 本机实测规模（~/.claude）

| 指标 | 数值 |
|---|---|
| 有 subagents 目录的项目 / 会话 | 8 个 / 16 个 |
| agent-*.jsonl / meta.json | 239 / 239 |
| 子代理正文总量 | 约 119 MB |
| 单会话最多子代理 | 101 个（38.8 MB） |
| 该会话读取耗时 | 0.29 s（`inspect`，102 sessions / 1403 events） |

## meta.json 字段（239 份统计）

| 字段 | 出现次数 | 用途 |
|---|---:|---|
| `agentType` | 239 | 落到 `IrMeta.profile`（如 `general-purpose`、`workflow-subagent`） |
| `requestShape` / `requestNonInteractive` | 239 | 运行时语义，未映射 |
| `description` | 230 | 子代理任务描述 → child 标题（优先于首条用户文本） |
| `spawnDepth` | 230 | 嵌套深度，未映射 |
| `workflowPhase` | 204 | workflow 阶段（如 `Verify`），未映射 |
| `finished` | 31 | 是否结束，未映射 |
| `toolUseId` | 29 | 触发子代理的工具调用 id → `IrChildSession.viaToolCallId` |
| `spawnedWithWorktree` / `worktreePath` / `worktreeBranch` | 18 | worktree 信息，未迁移 |

## journal.jsonl（workflows）

每行一个 JSON 事件：

```json
{"type":"launched"}
{"type":"started","key":"v2:…","agentId":"abcdde231dddda1c0","label":"verify:bug-hydra-admin-socket","phase":"Verify"}
{"type":"result","key":"v2:…","agentId":"abcdde231dddda1c0","result":{…}}
```

`started.label` 是 workflow 子代理最有意义的标题（如 `verify:sug-phone-plan-gates`），优先于首条用户文本（后者是 workflow harness 的转发模板）。

## 读取策略（sessionport）

1. 主文件 `isSidechain` 行仍按 `agentId` / `parentUuid` 连通关系分组（旧版 Claude 只有镜像行的兜底）。
2. 扫 `<sessionId>/subagents` 下最多 4 层，收集 `agent-*.jsonl`（跳过 `journal.jsonl`）。
3. 同 `agentId` 的磁盘 transcript **覆盖**镜像行；镜像里磁盘没有的行追加到末尾（防丢数据，记 warning）。
4. 只在磁盘上存在的子代理追加为新 child，排在内联分组之后。
5. 标题优先级：`custom-title > summary > agent-name > meta.description > workflow label > 首条用户文本`。
6. `profile = agentType`；`viaToolCallId = meta.toolUseId`；`nativePath` 指向子代理文件本身。

## 验证

```bash
sessionport inspect "claude:0beb93b8-5179-4b81-8d54-9ec96de91c13" --json
# IR v0.1  sessions=5  events=439
#   child …:agent-a8235cb8df730184e  events=3   label=agent-a8235cb8  (workflow, 标题 verify:sug-phone-plan-gates)

sessionport inspect "claude:93bcfa78-fd45-4802-a7b3-866d106d5e74"
# IR v0.1  sessions=102  events=1403（101 个子代理全部读入）
```

单测：`packages/adapters/claude-code/test/subagents.test.ts`（磁盘发现 / 覆盖镜像 / workflows 嵌套 / 坏行）。

端到端：把这条真实会话（1 根 + 4 个 workflow 子代理）用 `push --to dsh --include-children`
写进隔离 `DSH_HOME`，再用 DSH reader 读回：5 个会话、4 个 child（`parentSession` 指向根会话）、
子代理事件数 3/25/27/46 与源端一致，`validateIrBundle` 无错误。

补充：本机 16 个含 subagents 目录的会话里，**没有**同时出现「主文件镜像行 + 磁盘文件」的情形
（真实 Claude 要么写镜像行、要么写独立文件）；混合去重逻辑由单测覆盖。

## 已知边界

- 只查**主文件所在目录**：复制或改名主文件后找不到子代理目录（与 Claude 自己按 sessionId 查找的行为一致）。
- `viaToolCallId` 仅 `meta.toolUseId` 存在的 29/239 份可用；旧格式没有该字段时不做猜测。
- worktree 状态（`spawnedWithWorktree` 等）不迁移；子代理里引用的 worktree 路径在目标端会失效。
- workflow 的 `journal.jsonl` 只用于标题，`result` 内容未映射。
- 子代理转录里的 `attachment`、`api-request*`、`progress` 等运行时行与主会话一样被忽略。
