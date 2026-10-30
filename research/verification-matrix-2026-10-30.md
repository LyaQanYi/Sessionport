# 真实恢复验收矩阵（2026-10-30 复跑）

目标：回答“迁过去以后，目标端到底能不能真的打开/续上”，并且**记录对哪个目标端版本验的**。

脚本：`node scripts/verify-matrix.mjs`（可只跑单对，如 `... claude-dsh`）；
单对复跑会**合并**进 `.tmp/matrix/results.json`，不再覆盖其它 pair。
每次运行写到隔离目录 `.tmp/matrix/<pair>-home`，不碰真实 app 存储；
Cursor 例外：写 `.tmp/cursor-app-test` 的副本库（需要 `--confirm-real`）。

## 目标端版本（本机 2026-10-30）

矩阵现在把目标端版本写进 `.tmp/matrix/versions.json`，并在结果表头打印；下表是同一次运行的快照。

| 目标端 | 版本 | 相对 2026-10-29 首跑 |
|---|---|---|
| Claude Code CLI | `2.1.312` | 未变 |
| Codex CLI | `codex-cli 0.165.0` | 0.163.0 → 0.165.0 |
| opencode | `1.19.5` | 1.19.3 → 1.19.5 |
| Cursor（app） | `3.27.22` | 3.25.9 → 3.27.22 |
| Qoder（app） | `0.4.11`；内置 qodercli `1.1.75-hotfix.1` | qodercli 1.1.69 → 1.1.75-hotfix.1 |
| DeepSeek Harness（app） | `0.2.1-rc.3` | 0.2.1-rc.2 / 底层 5.8.3 |
| WorkBuddy（app） | `5.9.3` | 5.8.3 → 5.9.3 |
| Kimi Code CLI | `2.4.0` | 2.1.1 → 2.4.0（本轮加入矩阵） |

## 结果（2026-10-30 全量跑通）

| pair | 事件数 | 结构校验 | 原生加载 | 备注 |
|---|---|---|---|---|
| claude-dsh | 343 | ✅ 17 PASS | ✅ headless 加载 Session 并开始 turn | Claude Code（含 4 个子代理）→ DSH，`--compact` |
| dsh-claude | 76 | ✅ 11 PASS | ✅ claude --resume 显示会话内容 | 源会话换成 `session-fa31c98c…`（旧样本已被清理） |
| wb-claude | 682 | ✅ 100 PASS | ✅ claude --resume 显示会话内容 | WorkBuddy 含 11 个子代理 |
| codex-claude | 38 | ✅ 11 PASS | ✅ claude --resume 显示会话内容 | 样本从 14 events 换到 38 events（2 次工具调用） |
| claude-opencode | 7 | ✅ 8 PASS | ✅ opencode export 读回 2 条消息 | 隔离 home 通过 `XDG_DATA_HOME`；无模型调用 |
| claude-codex | 7 | ✅ 12 PASS | ✅ codex exec resume 载入 thread 并开始 turn | 隔离 home 无凭据，401 前已加载 thread |
| claude-commandcode | 7 | ✅ 18 PASS | ✅ `cmd -p --session` 无头加载并开始 turn | opt-in（`--command-code-smoke`）；凭据失效时加载后被 401 拦下，不花钱 |
| claude-qoder | 343 | ✅ 48 PASS | ⚠️ 仅 SDK | 桌面任务列表服务端驱动，本地 JSONL 不可见 |
| wb-qoder | 682 | ✅ 104 PASS | ⚠️ 仅 SDK | 同上；11 个子代理写入且 SDK 可读 |
| kimi-claude | 81 | ✅ 11 PASS | ✅ claude --resume 显示会话内容 | Kimi Code 2.4.0 真实会话（25 次工具调用）→ Claude Code |
| kimi-dsh | 81 | ✅ 17 PASS | ✅ headless 加载 Session 并开始 turn | 同一源 → DSH；纯 source 端补进矩阵 |
| claude-cursor | 229 | ✅ 35 PASS | ✅ 3.27.22 桌面（CDP + 截图） | Cursor 无 headless；副本库起独立实例，人类/助手/shell/read/edit diff 均渲染正常 |

## 这一轮的改动

1. **矩阵记录目标端版本**：新增 `toolVersions()`，README 的 “Against” 列不再靠手抄；结果表头与
   `versions.json` 都带版本。
2. **单对复跑改为合并**：`node scripts/verify-matrix.mjs codex-claude` 只替换这一行，其余保留。
3. **codex 样本加厚**：`01a182f9…`（14 events，无工具调用）→ `01a18820…`（38 events，2 次工具调用，
   4.0 MB rollout），对应 2026-10-29 记录里的“样本偏小”待办。
4. **dsh 源样本替换**：旧的 `session-22e4f5f8…` 已随会话清理消失；换成
   `dsh:session-fa31c98c…`（76 events / 26 次工具调用）。
5. **Kimi Code 进矩阵**：新增 `kimi-claude` / `kimi-dsh` 两对，源是本机 2.4.0 CLI 自己写出的真实会话
   （`session_708071d1…`，81 events / 25 次工具调用，`formatVersion=2` / `protocolVersion=1.5`），
   reader 直接读得出来，不再只靠 2.1.1 的 fixture。
6. **TUI 检查对 pty 耗尽的假失败免疫**：`expect` 偶发 `no more ptys`（系统 pty 被占满）会让这一对
   记成 fail；现在检测到该错误会等 1.5s 自动重试一次。

## 已完成

- 12/12 pair 结构校验 PASS（对当前安装版本）。
- 9/9 有入口的目标端原生加载 PASS（Command Code 需 `--command-code-smoke` 显式开启）：
  Claude Code TUI ×4、DSH headless ×2、opencode export ×1、Codex resume ×1、Command Code 无头 ×1。
- Kimi Code 2.4.0 真实会话已进矩阵（reader 与两条迁移路径都验过）。
- Cursor 3.27.22 桌面渲染已确认：人类 8/8、助手 markdown、shell 卡片、read 行、edit diff、
  回合摘要全部正常；默认折叠是 3.27 原生行为（原生 composer 同样折叠）。
  证据：`research/cursor-ui-2026-10-30.md` + `.tmp/cursor-ui/`。
- 顺带修掉 3.27 header 迁移导致的 verify 误报（`conversation-headers` / `no-orphan-bubbles`），
  见 `research/cursor-headers.md` §8。
- codex 的小样本问题已处理（38 events、含工具调用）。
- 矩阵结果可追溯到具体目标端版本。

## 未完成 / 已知边界

1. **Qoder 桌面 UI 仍不可本地验证**：任务列表走服务端分页，本地 `projects/` 不被桌面读取；
   只能到 SDK 的 `listSessions/listSubagents/getSubagentMessages`。
2. **Cursor 桌面渲染已确认，但细项没点完**：read 行展开后的文件正文永远为空（writer 不伪造，
   与原生一致）、edit 卡片的“打开文件/diff 视图”入口未逐一点、原生 vs 导入的分组边界差异没跑全量对照。
   另：3.27 的 `AgentStores` 写死真实库路径，`--user-data-dir` 不隔离，真机上跑副本库前要先备份。
3. **Command Code 冒烟按设计会真实调用一次模型**：CLI 打包在
   `/Applications/Command Code.app/Contents/Resources/app/node_modules/command-code/dist/index.mjs`
   （首次运行自动 1.82.3 → **1.86.1**），运行时只认 `~/.commandcode`。矩阵把它做成 opt-in：
   `--command-code-smoke` 会把真实凭据复制进 `.tmp/matrix/commandcode-home`（不写用户目录），
   再跑无头 resume；默认不开，避免每次跑矩阵都产生一次模型调用。
   2026-10-30 实测（凭据已过期）：CLI 正常载入 transcript 并开始 turn，模型调用在 401 处被拦下，
   token 消耗为 0。
4. **DSH → Claude 子代理仍无法关联**：writer 继续记 `claude.subagent-unlinked`（缺 `viaToolCallId`）。
5. **源会话是硬编码的，会随清理失效**：本轮就有两对因为源被删而换样本；
   长期应改成“自动挑选最近可用的合格会话”或固定的 fixture。
6. **Kimi 2.4.0 有一个未识别的 wire 事件**：`changeNotifier.snapshot` 只记 warning
   （`kimi.unknown-event`），不影响对话内容，但说明 wire 协议又多了一种事件类型。

## 复现

```bash
node scripts/verify-matrix.mjs            # 全量（当前 12 对）
node scripts/verify-matrix.mjs claude-dsh # 单对（合并进 results.json）
node scripts/verify-matrix.mjs --sources-only   # 只预演源选择，不 push、不写 results.json
node scripts/verify-matrix.mjs --no-auto        # pin 不可用直接 skip，不做自动兜底
cat .tmp/matrix/results.json              # 机器可读结果（每行带 source 字段）
cat .tmp/matrix/versions.json             # 本次运行的目标端版本
```

前置条件：macOS 上装有 Claude Code / DeepSeek Harness / Cursor CN / Qoder CN / opencode / codex；
`expect` 可用；源会话仍在本地。

## 源会话：pin → auto → skip（2026-10-30 补）

矩阵原来把源会话 id 写死在 `PAIRS` 里，会话被清理后整对失败（本轮就换过 dsh / codex 两个样本）。现在
`resolvePairSource` 分三段：

1. **pin**：写死的 id/path 能 `inspect` 就原样使用，行为与旧版一致（即使事件数低于 auto 阈值也优先 pin）。
2. **auto**：pin 不可用时，用 `list --agent <源端> --json --limit 200` 取候选，
   过滤「根会话 + 未归档 + `--max-age-days`（默认 30）内 + cwd 是存在的绝对目录」，
   按 `updatedAt` 倒序取前 `--max-candidates`（默认 10），逐个 `inspect` 要求 root events ≥
   `--min-events`（默认 20），第一个合格即用。源形式：claude 用 id（并校验 transcript 在
   cwd 对应的 project 目录，否则 `claude --resume` 找不到）；kimi/codex/workbuddy/qoder/commandcode
   用 `nativePath`（codex 的 rollout 文件名 id 与文件内 `session_meta` id 可能不同）；
   opencode/cursor 用 sessionId。
3. **skip**：都拿不到就不 push，结构校验与原生加载都标 `skip`，reason 写明 pin 报错 + 候选漏斗 + 拒选原因。

实际用的源与理由记录在 `results.json` 每行的 `source`（mode/used/sessionId/nativePath/events/reason/…），
终端表多一列「源」并单列 auto / skip / env-skip 清单。

**env skip（pty 耗尽）**：`expect` 起不来时 system 报 `no more ptys`，这不是产品失败。脚本现在每次 capture
前清旧日志、同时检测 `expect` 的 stderr 与日志、等 5s 重试最多 3 次，仍失败就把 native 标成
`env: no more ptys` 的 skip。2026-10-30 下午本机 pty 被占满时，全量跑为
**12/12 结构 PASS、native 4 PASS + 4 env skip + 3 manual、0 真 fail**；当天上午 pty 正常时同一脚本跑出
**8 native PASS**。环境恢复后重跑即可回到 8 PASS（Command Code 那对另需 `--command-code-smoke`）。
