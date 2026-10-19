# sessionport · 设计与规划 v0.1

> 内部规划文档（中文）。开源后 README / 代码 / API 文档用英文，本文档保留为设计档案。
> 最后更新：2026-10-19

## 0. 一页摘要

sessionport 是一个本地优先的开源 CLI，把 AI 编程 agent 之间的会话变成可移植资产：
在 A agent 里进行到一半的会话，一条命令变成 B agent 里可原生 `/resume` 的会话，继续跑。

与现有工具的本质区别：不是"把上下文打包重喂"，而是 **IR 级无损往返**——
统一的中间表示（IR）+ 每 agent 一个 adapter，导入导出的损失全部显式声明。

## 1. 决策记录

| 决策点 | 结论 |
|---|---|
| 定位 | 直接做开源项目（非自用脚本），从第一天按可开源标准建设 |
| v1 核心场景 | 跨 agent 续聊（一次性迁移 + 目标端原生 resume） |
| 首批 adapter | claude-code、codex、opencode、kimi-code |
| LICENSE | Apache-2.0（含专利授权条款） |
| 命名 | **sessionport** |
| npm 发布名 | `sessionport-cli` 或 `@sessionport/cli`（发布时二选一，bin 均为 `sessionport`） |
| GitHub 仓库 | `<owner>/sessionport`（2026-10-19 查无同名项目） |
| 技术栈 | TypeScript（Node ≥ 24，直接执行 TS；sqlite 用内置 node:sqlite，暂不引入 better-sqlite3） |
| 模型绑定 | **不迁移**：跨 agent 导入后目标端使用自身默认模型（2026-10-19 确认，属于可接受的损失，不是待修 bug） |
| 同步登记表 v0 | JSON（`~/.sessionport/registry.json`）：sourceKey + targetId + syncedHead + targetUnits；sqlite hub registry 留到多目标/增量事件阶段 |

命名考量的教训：生态中 `cc-` 前缀（cc-switch、cc-sync）已是"Claude Code 周边工具"的信号。
cc-switch 全称 Claude Code Switch，CC 中心化出身、扩张到 7+ 工具后名字成为负担。
我们没有先发优势，名字必须从第一天站对位置——中立 hub，不属于任何一家。

## 2. 竞品格局与差异化

| 工具 | 做法 | 局限 |
|---|---|---|
| session-sync | Claude Code hooks 实时翻译成 Codex/Amp/Gemini 格式 | 单向（仅从 Claude 出发） |
| transession | Claude ↔ Codex 离线翻译（Rust） | 只两家，一次性，格式漂移即失效 |
| cc-sync | 同步 Claude/Codex 的 `/resume` 历史 | 只管历史索引 |
| codex-session-bridge | 会话导入 Codex（含 sqlite 注册） | 只汇入 Codex |
| agent-chorus / ai-sync | 打包上下文重新喂给目标 agent | 有损，非原生 resume |
| OpenAI 官方同步 | ChatGPT Work/Codex 导入他厂会话并自动更新 | 只进自家，单向 |
| deja-vu | 索引各 agent 会话日志做记忆检索 | 解决"记得住"而非"接着跑" |

差异化四支柱：

1. **IR 无损往返**：`_native` 透传 + 强制损失清单，不是有损的"上下文压缩包"
2. **中立 + 双向 + 广度**：四家矩阵，kimi-code 为独家覆盖
3. **版本登记制**：导出前明确警告未验证的 CLI 版本，诚实策略
4. **adapter 社区化**：契约测试 + golden corpus，新 agent 接入成本低

## 3. 场景定义与 v1 验收

**一句话验收**：A 中半途会话 → `sessionport push --to B` → B 原生 `/resume` 后继续跑 5 轮不跑偏，工具调用上下文完整。

v1 明确不做：实时同步（Phase 3）、跨机同步、记忆检索、深度 TUI（M3 仅浏览预览）。

## 4. 数据模型（IR v2，基于本机实测修订）

### 4.1 规范形态：append-only 事件流

四家分别是事件日志（Claude、Kimi）、"日志+索引"（Codex）、关系库（opencode），
**追加事件流是四家双向转换的最大公约数**，定为 IR 规范形态。

```ts
type SessionEvent =
  | { kind: 'meta';     session: IrMeta }                        // cwd/git/agent版本/模型/标题
  | { kind: 'message';  role: 'user' | 'assistant'; parts: IrPart[] }
  | { kind: 'reasoning'; reasoning: Reasoning }
  | { kind: 'tool_call';   callId: string; name: string; input: unknown }
  | { kind: 'tool_result'; callId: string; content: IrContent[]; isError?: boolean }
  | { kind: 'fork';     fromEventId: string }                    // 兼容 opencode fork / Kimi undo / Claude parentUuid 分叉
  | { kind: 'compact' }                                          // Claude compact_boundary 等压缩边界
  | { kind: 'usage';    tokens?: TokenUsage; cost?: CostInfo }    // 可选,导出时多数目标端接不住 → 损失清单

interface EventBase {
  id: string;                 // IR 内部 id
  parentId: string | null;    // 上一事件,构成链
  at: string;                 // ISO 8601
  _native?: unknown;          // 源端原始 payload 透传（无损往返的关键）
}

type Reasoning =
  | { kind: 'plain';  text: string; signature?: string }   // Claude(opus签名) / Kimi / opencode
  | { kind: 'opaque'; payload: unknown }                   // Codex encrypted_content

type IrContent =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'diff' }        // 与纯文本区分,导出时各家渲染不同
  | { type: 'terminal' }
  | { type: 'image'; ref: string };
```

### 4.2 关键设计决策

- **统一 `callId`**：源端 `id` / `call_id` / `callID` / `toolCallId` 各自映射进来
- **subagent 归一为"独立 session + parent 边"**：源端行内标记（Claude `isSidechain`）、
  边表（Codex `thread_spawn_edges`）、列标记（opencode `message.agent`）、独立事件目录
  （Kimi `subagent.spawned`）在 import 时统一
- **来源指纹**：每个 session 记录 `{ agent, cliVersion, formatVersion }`——
  版本警告与回归测试的依据。四家都有版本字段可探测（Claude 行内 `version`、
  Codex `session_meta.cli_version`、`opencode.session.version` 列、
  Kimi `state.json.version` + `protocol_version`）
- **capability 矩阵 + 强制损失清单**：adapter 声明保留/丢弃什么，
  导出报告列出损失（如"2 个 thinking 块降级为文本"），绝不悄悄丢

## 5. 四家格式事实（本机实测，2026-10-19）

详见 [research/agent-formats.md](./research/agent-formats.md)。要点：

- **Claude Code 2.1.303**：`~/.claude/projects/<slug>/<uuid>.jsonl`，每行一个 JSON，
  20+ 种行类型，`uuid/parentUuid` 构成 DAG，导出只需写对目录
- **Codex 0.162.0-alpha**：**双存储**——rollout JSONL（OpenAI Responses API 风格条目）
  + sqlite 投影（`state_5.sqlite` threads 表 + `thread_history_1.sqlite`），
  resume 依赖两边一致，adapter 必须同时写两边。**格式漂移风险最高（alpha）**
- **opencode 1.19.3**：纯 SQLite（Drizzle ORM + 迁移），`message`/`part` 双层模型，
  `session.version` 列记录格式演进，读写都要处理 schema 版本
- **Kimi Code 2.1.1**：**事件溯源最彻底**（29 种 wire.jsonl 事件），显式 undo/branch 事件对，
  pull = 事件流→状态重建，push = 状态→事件合成，**四个 adapter 中工作量最大，排 M3**

## 6. 架构

```
packages/
├── core/                 # IR schema(zod)、事件模型、损失清单、registry
├── adapters/
│   ├── claude-code/      # JSONL 读写,最简单
│   ├── codex/            # 双存储: rollout JSONL + sqlite 投影
│   ├── opencode/         # Drizzle schema 版本适配
│   └── kimi-code/        # 事件流 ⇄ 状态重建
├── cli/                  # list / pull / push / sync / doctor / verify / scan
└── e2e/                  # golden corpus + round-trip + resume smoke
```

### Adapter 契约

```ts
interface AgentAdapter {
  readonly agent: AgentId;
  detect(): Promise<Support>;                    // 是否安装 / 版本 / 该版本格式是否已验证
  listSessions(query?: ListQuery): Promise<SessionRef[]>;   // 只读元数据,便宜
  readSession(ref: SessionRef): Promise<IrSession>;         // 原生 → IR
  readonly caps: ExportCaps;                     // { preservesThinking, inlineToolResults, ... }
  writeSession(ir: IrSession, opts: WriteOpts): Promise<WriteReport>;  // IR → 原生 + 索引注册 + 损失清单
  verify?(ref: SessionRef): Promise<VerifyReport>;          // 目标 CLI 能否 resume
  // Phase 3: appendEvents?(ref, events): Promise<void>     // 增量同步
}
```

### Hub registry（sqlite）

```
ir_sessions(ir_id, title, project, created_at, head_event_id, source_agent, source_cli_version)
external_refs(ir_id, agent, native_id, native_path, synced_head, updated_at)
provenance(ir_event_id, agent, native_id)        -- 幂等追加的依据
```

一个 IR 会话挂 N 个外部引用（同一会话同步到多家是同一个会话，不是 N 份拷贝）。

### CLI

```
sessionport list --agent claude
sessionport pull claude:<sessionId>          # agent → hub
sessionport push <irId> --to codex           # hub → 单家
sessionport sync <irId>                      # → 所有 linked agents
sessionport verify <irId> --agent codex
sessionport doctor                           # 格式版本健康检查
sessionport scan                             # 会话内容 secret 扫描
```

### 6.1 损失分级（2026-10-19 增补）

损失清单里的条目分两类，报告消费者（以及未来的 CI）应按类别处理：

| 类别 | 含义 | 例子 |
|---|---|---|
| **设计取舍（accepted）** | 目标端没有对应概念，或刻意不迁移；永远存在，不需要修 | 模型绑定不迁移、thinking 块丢弃（无法伪造 Anthropic 签名）、目标端使用自身 system prompt、源端 UI 镜像/运行时事件不入 IR |
| **能力缺口（actionable）** | 现在做不到但可以补，属于 roadmap | 图片附件未映射、fork/undo 边界被压平、Codex/opencode adapter 缺失 |

子代理会话（2026-10-19 已交付）：DSH 目标写成原生父子树；Claude / Command Code 没有父子概念，退化为独立会话（内容保留、关系丢失，损失清单会说明）。

原则：**设计取舍也要报，但不承诺修复**；能力缺口必须进 roadmap 并配验证用例。
## 7. 安全与隐私

- 本地优先，默认零遥测
- `sessionport scan`：hub 入库前 secret 检测（会话日志常含密钥）
- golden corpus 必须走脱敏流程才能入库
- README 第一段写清数据流向

## 8. 验证与维护体系（品类生死线）

- **契约测试**：每家 golden 文件标注 CLI 版本，`native → IR → native' → IR'` 语义等价
- **resume smoke**：导出后无头验证目标端可加载（Codex 查 sqlite 行、Claude 校验 JSONL schema）
- **版本登记制**：`detect()` 版本不在已验证列表 → 导出前警告
- **adapter 贡献模板**：社区提交必须附 golden 文件 + 验证过的版本号
- CI 定期跑格式漂移检测

## 9. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0-spike**（前置） | 手写最小 Codex rollout + state 行，探测无头 resume 的必填字段集 | 摸清 export 必填集，写进 adapter 契约文档 |
| M0 | 仓库脚手架 + IR schema + claude-code adapter（读写）+ round-trip 测试 | 真实 Claude 会话 round-trip 语义等价 |
| M1 | codex adapter（双存储注册）+ verify + pull/push CLI | Claude 会话 push 后 `codex resume` 续跑 5 轮 |
| M2 | opencode adapter（Drizzle 版本适配）+ 损失清单报告 | Claude ↔ opencode 双向互通 |
| M3 | kimi adapter（事件流⇄状态重建）+ TUI 浏览预览 | 四家矩阵互通，发布 v1.0 |

## 10. 开源治理

- Apache-2.0；README（英文）结构：一句话定位 → 30 秒上手动图 → 支持矩阵 → 损失清单说明 → 安全声明
- CONTRIBUTING：adapter 贡献契约（golden 文件 + 版本验证为硬性要求）
- SECURITY.md（secret 处理流程）、CODE_OF_CONDUCT.md
- 公开 roadmap（本文档的里程碑即 roadmap）

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 格式漂移（Codex 处于 alpha，风险最高） | 版本登记 + 警告 + 契约测试 + 社区快速跟进 |
| 官方下场（OpenAI 已做单向同步） | 护城河是广度、双向、中立性，不依赖任何一家态度 |
| resume 隐藏必填字段（私有校验只有试了才知道） | M0-spike 先摸清 Codex；其余各家同法 |
| 维护负担随 adapter 数线性增长 | adapter 即独立包，契约测试兜底，社区分担 |

## 12. 未决问题

- [ ] M0-spike 结论（Codex 必填字段集）
- [ ] kimi push 策略：事件合成 vs 直接写 state（倾向：最小事件集 + state.json，M3 前定案）
- [ ] opencode adapter 支持的 `session.version` 范围
- [ ] 命令别名与最终 bin 名（`sessionport` 较长，是否加短别名）
- [ ] npm 发布名二选一：`sessionport-cli`（安装路径短）vs `@sessionport/cli`（monorepo 一致性好）