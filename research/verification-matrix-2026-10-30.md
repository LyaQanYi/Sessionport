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
| claude-qoder | 343 | ✅ 48 PASS | ⚠️ 仅 SDK | 桌面任务列表服务端驱动，本地 JSONL 不可见 |
| wb-qoder | 682 | ✅ 104 PASS | ⚠️ 仅 SDK | 同上；11 个子代理写入且 SDK 可读 |
| kimi-claude | 81 | ✅ 11 PASS | ✅ claude --resume 显示会话内容 | Kimi Code 2.4.0 真实会话（25 次工具调用）→ Claude Code |
| kimi-dsh | 81 | ✅ 17 PASS | ✅ headless 加载 Session 并开始 turn | 同一源 → DSH；纯 source 端补进矩阵 |
| claude-cursor | 229 | ✅ 35 PASS | ⚠️ 仅人工 | Cursor 无 headless；结构校验在 3.27.22 副本库上通过 |

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

- 11/11 pair 结构校验 PASS（对当前安装版本）。
- 8/8 有入口的目标端原生加载 PASS：Claude Code TUI ×4、DSH headless ×2、opencode export ×1、
  Codex resume ×1。
- Kimi Code 2.4.0 真实会话已进矩阵（reader 与两条迁移路径都验过）。
- codex 的小样本问题已处理（38 events、含工具调用）。
- 矩阵结果可追溯到具体目标端版本。

## 未完成 / 已知边界

1. **Qoder 桌面 UI 仍不可本地验证**：任务列表走服务端分页，本地 `projects/` 不被桌面读取；
   只能到 SDK 的 `listSessions/listSubagents/getSubagentMessages`。
2. **Cursor 桌面渲染只能人工确认**：没有 headless 入口；最近一次人工确认是 3.25.9，
   当前 app 已 3.27.22，需要一次人工重启检查（本轮只做了结构校验）。
3. **Command Code 作为目标端未进矩阵**：`cmd` CLI 不在 PATH（只剩 `Command Code.app` 0.1.57），
   `verify --resume` 的冒烟路径无法在本机复现。
4. **DSH → Claude 子代理仍无法关联**：writer 继续记 `claude.subagent-unlinked`（缺 `viaToolCallId`）。
5. **源会话是硬编码的，会随清理失效**：本轮就有两对因为源被删而换样本；
   长期应改成“自动挑选最近可用的合格会话”或固定的 fixture。
6. **Kimi 2.4.0 有一个未识别的 wire 事件**：`changeNotifier.snapshot` 只记 warning
   （`kimi.unknown-event`），不影响对话内容，但说明 wire 协议又多了一种事件类型。

## 复现

```bash
node scripts/verify-matrix.mjs            # 全量（当前 11 对）
node scripts/verify-matrix.mjs claude-dsh # 单对（合并进 results.json）
cat .tmp/matrix/results.json              # 机器可读结果
cat .tmp/matrix/versions.json             # 本次运行的目标端版本
```

前置条件：macOS 上装有 Claude Code / DeepSeek Harness / Cursor CN / Qoder CN / opencode / codex；
`expect` 可用；源会话仍在本地（矩阵里的 session id 会随清理失效，需换成当时存在的会话）。
