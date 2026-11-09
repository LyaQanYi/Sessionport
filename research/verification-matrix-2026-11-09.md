# 真实恢复验收矩阵（2026-11-09 复跑）

目标：回答"迁过去以后，目标端到底能不能真的打开/续上"，并记录**对哪个目标端版本验的**。

脚本：`node scripts/verify-matrix.mjs`（源会话 pin → auto → skip；单对复跑合并进 results.json）。

## 目标端版本（本机 2026-11-09）

| 目标端 | 版本 | 相对 2026-10-30 |
|---|---|---|
| Claude Code CLI | `2.1.316` | 2.1.312 → 2.1.316 |
| Codex CLI | `0.167.0` | 0.165.0 → 0.167.0（本机全局安装损坏，矩阵用 `.tmp/codex-cli` 的本地副本） |
| opencode | `1.19.5` | 未变 |
| Cursor（app） | `3.29.9` | 3.27.22 → 3.29.9（本轮未做桌面人工确认） |
| Qoder（app） | **未安装** | 已卸载；两对 Qoder 走 skip |
| DeepSeek Harness（app） | `0.2.2-rc.1` | 0.2.1-rc.3 → 0.2.2-rc.1 |
| WorkBuddy（app） | `5.9.3` | 未变 |
| Kimi Code CLI | `2.5.2`（app 1.3.2） | 2.4.0 → 2.5.2（矩阵样本仍是 2.4.0 写出的会话） |
| Command Code CLI | `1.86.1` | 未变 |

## 结果

| pair | 源 | events | 结构校验 | 原生加载 | 备注 |
|---|---|---|---|---|---|
| claude-dsh | pinned | 343 | ✅ 17 PASS | ✅ headless 加载 Session 并开始 turn | DSH 0.2.2-rc.1 正常 |
| dsh-claude | pinned | 185 | ✅ 11 PASS | ⚠️ env skip（pty） | 源会话从 76 长到 185 events |
| wb-claude | pinned | 682 | ✅ 100 PASS | ⚠️ env skip（pty） | |
| codex-claude | **auto** | 46 | ✅ 11 PASS | ⚠️ env skip（pty） | pin 的旧 codex 会话已被清理，auto 选到 2026-11-09 新会话 |
| claude-opencode | pinned | 7 | ✅ 8 PASS | ✅ opencode export 读回 2 条消息 | |
| claude-codex | pinned | 7 | ✅ 12 PASS | ✅ codex exec resume 载入 thread 并开始 turn | 0.167 需要 config.toml，见下 |
| claude-commandcode | pinned | 7 | ✅ 18 PASS | ⚠️ skip（冒烟未开启） | `--command-code-smoke` 才跑 |
| claude-qoder | pinned | 343 | ✅ 48 PASS | ⚠️ skip（Qoder 未安装） | 结构与写入不受影响 |
| wb-qoder | pinned | 682 | ✅ 104 PASS | ⚠️ skip（Qoder 未安装） | |
| kimi-claude | pinned | 81 | ✅ 11 PASS | ⚠️ env skip（pty） | |
| kimi-dsh | pinned | 81 | ✅ 17 PASS | ✅ headless 加载 Session 并开始 turn | |
| claude-cursor | pinned | 229 | ✅ 35 PASS | ⚠️ 仅人工 | 桌面渲染上次确认是 3.27.22，现为 3.29.9 未复核 |

**汇总**：12/12 结构 PASS；原生 PASS 4 对（claude-dsh、claude-opencode、claude-codex、kimi-dsh）、
env skip 4 对（pty）、skip 3 对（Qoder 未安装 ×2、Command Code 未开冒烟 ×1）、人工 1 对（Cursor）。

## 本轮发现

1. **Codex 0.167 换了 resume 架构**：`codex exec resume` 现在走 app-server，会校验 transcript 里记录的
   `model_provider`。隔离 `CODEX_HOME` 里没有 `config.toml` 时直接
   `modelProviderNotConfigured`（连 `thread.started` 都不发），矩阵因此从 pass 变成 fail。
   修复：检查前把真实 `~/.codex/config.toml` 复制进隔离 home（**不带 auth**），随后
   `thread.started` + `turn.started` 正常出现，模型调用仍被 401 拦下（不消耗额度）。
2. **auto 源挑选第一次真正生效**：`codex-claude` 的 pin 会话已被清理，脚本自动选了当天最新的
   codex 会话（46 events），并在 results.json 里记了 `mode: auto` 与理由。
3. **Qoder 卸载被正确识别**：两对 Qoder 的结构校验仍通过（写入不依赖 app），原生检查标
   `skip: Qoder 未安装`，没有误报成产品失败。
4. **pty 依旧不可用**：4 对 claude TUI 检查 env skip（脚本已能区分环境问题）。
5. **本机全局 codex 安装损坏**：`@openai/codex` 缺可选依赖 `@openai/codex-darwin-arm64`；
   矩阵改用 `.tmp/codex-cli` 下的本地安装（0.167.0，不动全局环境）。

## 复现

```bash
# 本机 codex 全局装坏时，先用工作区内的本地副本
npm install --prefix .tmp/codex-cli @openai/codex@latest --cache "$PWD/.tmp/npm-cache"
PATH="$PWD/.tmp/codex-cli/node_modules/.bin:$PATH" node scripts/verify-matrix.mjs
node scripts/verify-matrix.mjs claude-dsh            # 单对（合并）
node scripts/verify-matrix.mjs --sources-only        # 只预演源选择
cat .tmp/matrix/results.json                         # 每行带 source 字段
```

## 未完成 / 已知边界

1. **Cursor 3.29.9 桌面渲染未复核**：上次人工/CDP 确认是 3.27.22；结构校验通过，GUI 需再跑一次。
2. **Qoder 两对暂时无法原生校验**：app 已卸载；SDK 探针（`scripts/qoder-sdk-probe.mjs`）保留，
   重装后可直接恢复。
3. **pty 耗尽**：本机 `expect` 无法分配 pty，claude TUI 类检查只能 env skip。
4. **Kimi 2.5.2 未用 2.5.x 会话验证**：矩阵样本仍是 2.4.0 写出的会话；reader 对新版本的格式兼容性未知。
5. **Command Code 冒烟默认关**：有效凭据下会花一次模型调用。
6. **DSH→Claude 子代理 UI 展示**仍未人工确认（功能已实现，结构验证 PASS）。
