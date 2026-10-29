# 真实恢复验收矩阵（2026-10-29）

目标：回答“迁过去以后，目标端到底能不能真的打开/续上”，而不是只看结构 PASS。

脚本：`node scripts/verify-matrix.mjs`（可只跑单对，如 `... claude-dsh`）。
每次运行写到隔离目录 `.tmp/matrix/<pair>-home`，不碰真实 app 存储；
Cursor 例外：写 `.tmp/cursor-app-test` 的副本库（需要 `--confirm-real`）。

## 结果（2026-10-29 全量跑通）

| pair | 事件数 | 结构校验 | 原生加载 | 备注 |
|---|---|---|---|---|
| claude-dsh | 343 | ✅ 17 PASS | ✅ headless 加载 Session 并开始 turn | Claude Code（含 4 个子代理）→ DSH，`--compact` |
| dsh-claude | 2493 | ✅ 68 PASS | ✅ claude --resume 显示会话内容 | 子代理无父 tool_use，UI 不展开（`claude.subagent-unlinked`） |
| wb-claude | 682 | ✅ 100 PASS | ✅ claude --resume 显示会话内容 | WorkBuddy 含 11 个子代理 |
| codex-claude | 14 | ✅ 11 PASS | ✅ claude --resume 显示会话内容 | 样本偏小（仅 14 events） |
| claude-qoder | 343 | ✅ 48 PASS | ⚠️ 仅 SDK | 桌面任务列表服务端驱动，本地 JSONL 不可见（§ 见 qoder-format） |
| wb-qoder | 682 | ✅ 104 PASS | ⚠️ 仅 SDK | 同上；11 个子代理写入且 SDK 可读 |
| claude-cursor | 229 | ✅ 31 PASS | ⚠️ 仅人工 | Cursor 无 headless；diff 卡片 2026-10-28 已人工确认 |

“原生加载”判定：

- **Claude Code**：`expect scripts/claude-tui-capture.exp <id> <cwd> <log>` 打开 `claude --resume`，
  Ctrl+O 抓屏；要求有会话内容且不出现 `No conversation found` / `Invalid session` 等加载错误。
  隔离 `CLAUDE_CONFIG_DIR` 需要 seed 配置（`settings.json` + `hasCompletedOnboarding` +
  `projects[cwd].hasTrustDialogAccepted`），否则会停在首启向导/信任弹窗。
- **DSH**：`ELECTRON_RUN_AS_NODE=1 DSH_HOME=<iso> <app> --expose-internals <cli.js> headless --json
  --session-id <id> "hi"`，看到 `{"type":"session"}` 且 `turn_start` 即算加载/续跑成功。
  隔离 home 没有 API key，会在加载成功后报 `MISSING_CREDENTIAL` —— 这是预期行为，不消耗模型额度。
- **Qoder**：桌面端没有读取本地 `projects/` 的入口（任务列表走服务端分页）；SDK 的
  `listSessions/listSubagents/getSubagentMessages` 可读（见 `research/qoder-format.md` §7）。
- **Cursor**：没有 headless 入口；编辑卡片 diff 通过真实桌面 app 人工确认（`toolCallBinary` 修复后）。

## 结论与已知边界

1. **Claude Code 与 DSH 两个目标已经具备“真实 app 加载”证据**，不是只做结构校验。
2. Qoder 只能到 SDK 层：本地文件写对了，但桌面 UI 不读；官方导入走服务端接口，不在本工具范围。
3. Cursor 的 UI 验证依赖人工；结构校验（31 项）覆盖 grouping/precomputedDiff/toolCallBinary 等。
4. 失败/占位是真实损失，不要隐藏：
   - DSH→Claude 的子代理没有 `viaToolCallId`，UI 无法关联（writer 记 warning）；
   - 源会话缺 tool_result 时 Claude 端会显示占位错误文本（`claude.tool-result-synthesized`）；
   - codex 样本只有 14 events，矩阵抽样偏小，后续应按“有工具调用/有多轮”的样本重跑。
5. 矩阵只覆盖 4 个目标（claude-code / dsh / cursor / qoder）。其他目标（codex / opencode /
   kimi-code / command-code / workbuddy）目前以各自 adapter 测试与结构 verify 为准，未纳入原生加载列。

## 复现

```bash
node scripts/verify-matrix.mjs            # 全量
node scripts/verify-matrix.mjs claude-dsh # 单对
cat .tmp/matrix/results.json              # 机器可读结果（含 push/verify 原始输出位置）
```

前置条件：macOS 上装有 Claude Code / DeepSeek Harness / Cursor CN / Qoder CN；
`expect` 可用；源会话仍在本地（矩阵里的 session id 会随清理失效，需换成当时存在的会话）。
