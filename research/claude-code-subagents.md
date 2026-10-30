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

## 写入策略（sessionport）

`writeClaudeSession(bundle, { includeChildren: true })`（CLI：`push --to claude-code --include-children`）
把 `bundle.children` 写成 Claude 原生子代理 transcript，而不是独立顶级会话：

```
<projectDir>/
├── <sessionId>.jsonl                                  # 主会话（不追加 sidechain 镜像行）
└── <sessionId>/subagents/
    ├── agent-<agentId>.jsonl
    └── agent-<agentId>.meta.json
```

- 正文复用主会话的 `buildChunks → materialize → repairToolPairs` 管线；每行补 `isSidechain: true` 与
  `agentId`，`sessionId` 与主会话一致，`parentUuid` 在子代理内部从 `null` 起链，与真实 Claude 一致。
- `agentId` 优先沿用源端 `nativeSessionId`（Claude → Claude 往返保持稳定）；源 id 不是纯字母数字时取
  child IR id 的 SHA-256 前 17 位，冲突时加盐，保证 `agent-<agentId>.jsonl` 的文件名规则。
- `meta.json` 固定写 `agentType`（`meta.profile`，缺省 `general-purpose`）、`description`
  （`meta.title` > `label`）、`requestShape: 'foreground'`、`requestNonInteractive: true`、
  `spawnDepth: 1`；有 `viaToolCallId` 时写 `toolUseId`。
- 主会话文件保持原有事件结构，不追加 sidechain 镜像行（reader 优先磁盘 transcript，不会重复）。
- **源端没有触发调用时（`--synthesize-agent-calls`，默认关）**：DSH 这类把子代理存成独立会话的源端，
  IR child 没有 `viaToolCallId`，主会话里也没有 Agent tool_use，Claude UI 不会展示 sidecar。打开该选项后
  writer 会为每个「没有匹配调用」的 child 在父会话里插一对合成事件：
  `{"name":"Agent","input":{description, subagent_type, prompt}}` + 对应 `tool_result`，
  位置按 child 的 `meta.createdAt`（缺省取首事件时间）插入并重串 `parentId`；
  `callId` 沿用源端已有的 `viaToolCallId`（若只是父会话缺这条调用），否则生成
  `toolu_synthesized_<child id 尾段>`。随后正常走 `attachSubagentToolUseResults`，写出
  `toolUseResult.agentId`，UI 即可把 sidecar 挂到该 Agent 调用下。
  这一对调用**在源端并不存在**，导出时记 `claude.subagent-agent-call-synthesized`（info，含条数）；
  未开该选项时仍按原行为记 `claude.subagent-unlinked`（warning）。
- 实测（2026-10-30）：DSH 会话 `session-e5f0de1a…`（2 个子代理，均无 `viaToolCallId`）
  → `.tmp/e2e-synth-on`：主会话出现 2 个 `Agent` tool_use、2 行带 `toolUseResult.agentId` 的
  tool_result、2 份 sidecar；`verify` 全 PASS，读回 2 个 child 的 `viaToolCallId` 与 meta 一致。
  未开选项时同源导出为 `claude.subagent-unlinked x2`，主会话无 Agent 调用。
- `CAPS.subagents` 现在为 `true`。仍有限制，导出时记一条 **info** 损失
  `claude.subagent-native-writeback`：Claude Code app/CLI 是否在 UI 中展示这些子代理未验证；
  IR 只建模一层子代理，子代理自己的子代理不会写回；`toolUseId` 是否被 UI 关联回主会话的 Task/Workflow
  调用也未验证。
- `includeChildren: false` 仍记 `claude.subagent-dropped` + `claude.subagent-events-dropped`（warning）。

## 验证

```bash
sessionport inspect "claude:0beb93b8-5179-4b81-8d54-9ec96de91c13" --json
# IR v0.1  sessions=5  events=439
#   child …:agent-a8235cb8df730184e  events=3   label=agent-a8235cb8  (workflow, 标题 verify:sug-phone-plan-gates)

sessionport inspect "claude:93bcfa78-fd45-4802-a7b3-866d106d5e74"
# IR v0.1  sessions=102  events=1403（101 个子代理全部读入）
```

单测：`packages/adapters/claude-code/test/subagents.test.ts`（磁盘发现 / 覆盖镜像 / workflows 嵌套 / 坏行）。

全量回读（本机 16 个含 subagents 目录的真实会话）：**16/16 读取成功、239/239 个子代理全部读入、
`validateIrBundle` 0 错误**。

端到端：把这条真实会话（1 根 + 4 个 workflow 子代理）用 `push --to dsh --include-children`
写进隔离 `DSH_HOME`，再用 DSH reader 读回：5 个会话、4 个 child（`parentSession` 指向根会话）、
子代理事件数 3/25/27/46 与源端一致，`validateIrBundle` 无错误。

补充：本机 16 个含 subagents 目录的会话里，**没有**同时出现「主文件镜像行 + 磁盘文件」的情形
（真实 Claude 要么写镜像行、要么写独立文件）；混合去重逻辑由单测覆盖。

### 写入侧往返验证

- 单测 `packages/adapters/claude-code/test/children.test.ts`：2 个子代理（title/profile/viaToolCallId
  齐全）写出后断言文件布局、每行 `isSidechain` / `agentId` / `sessionId` / `parentUuid` 链与
  `meta.json` 字段；用 `readClaudeSession` 读回，children 的 title/profile/viaToolCallId/事件数与源一致，
  主会话事件不变。`includeChildren: false` 仍记 `claude.subagent-dropped`；`dryRun` 不落盘；
  `verify` 对新结构 PASS、破坏子代理文件后 FAIL、meta 缺失/与 child 不一致时 FAIL。
- 真实数据：`claude:0beb93b8-5179-4b81-8d54-9ec96de91c13`（1 根 + 4 个 workflow 子代理）写入
  `.tmp/` 下的隔离 `CLAUDE_CONFIG_DIR` 再读回：4/4 子代理、标题与 profile 一致，子代理事件数
  3/25/27/46 与源一致，`verifyClaudeSession` PASS（含 4 份子代理的 meta 对应检查）。
  该往返用 `keepThinking: true` 保留事件条数，reasoning 会被降级成 text 块；默认导出丢弃 reasoning，
  事件条数会相应减少。
- `verifyClaudeSession` 新增检查：`subagent-files`，以及每个 `agent-<agentId>` 的 JSONL 解析 /
  `isSidechain` + `agentId` / parentUuid 链 / `sessionId` / tool_use 配对 / `meta.json`。
  传入 `expectedChildren` 时再核对 `agentType` / `description` / `toolUseId` 与 IR child
  一一对应（多出或缺少文件也会失败）。

## 已知边界

- 只查**主文件所在目录**：复制或改名主文件后找不到子代理目录（与 Claude 自己按 sessionId 查找的行为一致）。
- `viaToolCallId` 仅 `meta.toolUseId` 存在的 29/239 份可用；旧格式没有该字段时不做猜测。
- worktree 状态（`spawnedWithWorktree` 等）不迁移；子代理里引用的 worktree 路径在目标端会失效。
- workflow 的 `journal.jsonl` 只用于标题，`result` 内容未映射。
- 子代理转录里的 `attachment`、`api-request*`、`progress` 等运行时行与主会话一样被忽略。
- 写入侧不生成 `workflows/` 目录与 `journal.jsonl`、不写 `workflowPhase`：所有 child 都放在
  `<sessionId>/subagents/agent-*.jsonl`。IR 只建模一层子代理，子代理自己的子代理不会写回。
- 写入侧不在主文件里补 sidechain 镜像行（Claude 的两种写法 reader 都能读）。
- 写入前已存在的旧 `agent-*.jsonl` 不会被主动清理；`verify` 传入 `expectedChildren` 时会把多出的文件判为失败。
- **UI 展示**：见下一节。写回侧补全 `toolUseResult`（含 `usage` 与统计字段）后，Claude Code 会渲染
  `Done (N tool uses · X tokens · Ys)`。

## UI 展示（2.1.310–2.1.312 实测，2026-10-28）

结论：**Claude Code 会渲染子代理调用**，形态是 Agent 调用行 + `Done (N tool uses · X tokens · Ys)`；
`Ctrl+O` 转录模式下还会显示 `Prompt:` / `Response:`（子代理首条用户消息与最终回复）。

触发条件来自真实 TUI 实验矩阵（复制会话逐项改字段，用 `expect` 抓 `claude --resume` 屏幕）：

| toolUseResult | 渲染结果 |
|---|---|
| `status/agentId/agentType/prompt/content/canContinueAgent`（无 usage、无统计） | 只有 `explore(...)` 一行 |
| 加 `totalToolUseCount/totalTokens/totalDurationMs`，usage 仅 4 个 token 字段 | 仍只有一行（静默失败） |
| 再加 `server_tool_use`/`cache_creation`（6 字段） | 仍只有一行 |
| **usage 为完整原生形状**（值可全 0；含 `output_tokens_details`/`server_tool_use`/`cache_creation`/`service_tier`/`inference_geo`/`iterations`/`speed`/`fallback_credit`） | ✅ `Done (1 tool use · 20 tokens · 3s)` |

原因（2.1.312 bundle，`Done (` 附近）：渲染代码把 `usage` 展开并重建
`output_tokens_details / service_tier / inference_geo / iterations / speed / fallback_credit`，
再交给消息渲染；usage 缺 key 时该子树渲染失败且被吞掉，于是退化成「只有调用行」。

写回实现（`attachSubagentToolUseResults`）：

- `totalToolUseCount` = 子代理真实 tool_call 数
- `totalDurationMs` = 子代理首末事件时间差（真实）
- `totalTokens` = 按子代理转录文本长度估算（IR 不携带 usage；记 `claude.subagent-usage-estimated`）
- `usage` = 完整原生形状的 skeleton（`output_tokens` 用估算值，其余 0）
- `verify` 的 `subagent-<id>-tool-use-result` 同时检查 usage + 三个统计字段

实测：写出一条含 2 个带工具子代理的会话后，TUI 显示
`explore(子代理一 渲染验证) Done (1 tool use · 20 tokens · 3s)` 与对应的 general-purpose 行；
`Ctrl+O` 转录模式还能看到 `Prompt: … Response: …`。

已知边界：token 数是估算值；Claude 只展示子代理的 Prompt/Response 摘要，不展示子代理逐条消息列表。
