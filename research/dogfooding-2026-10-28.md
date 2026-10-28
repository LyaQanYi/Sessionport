# Dogfooding：0.1.4 发布版真实迁移（2026-10-28）

环境：从 npm 安装的 `sesport@0.1.4`（不是源码运行）；macOS arm64；真实会话源。
目的：验证发布产物在真实数据上的可用性，并记录新的保真缺口。

## 三条迁移

| # | 迁移 | 源 | 目标 | 结果 |
|---|---|---|---|---|
| 1 | Claude Code → DSH（`--include-children --register`） | `claude:0beb93b8…`（4 个 workflow 子代理） | 隔离 `.tmp/dogfood/dsh-home` | root 343 events + 4 children；DSH verify **14 项 PASS**；读回 children 标题 `verify:*` 一致；`workspace.json` 已注册 |
| 2 | WorkBuddy → Qoder | `workbuddy:f022affa…` | 隔离 `.tmp/dogfood/qoder-home` | 1047 行；Qoder verify **11 项 PASS**；读回 661 events、标题保留；**11 个子代理被丢弃**（`qoder.subagents-dropped x11`） |
| 3 | DSH → Claude Code（`--include-children`） | `dsh:session-22e4f5f8…`（父 + 6 个子代理会话） | 隔离 `.tmp/dogfood/claude-home` | 1240 行 + 6 份 `subagents/agent-*.jsonl`；verify 全 PASS；读回 6 children；**主会话没有 Agent tool_use，因此 UI 不会展示这些子代理** |

## 发现

1. **发布产物可用**：三条迁移只依赖 `npm i -g sesport` 装出来的 CLI，没有引用仓库源码。
2. **Qoder 目标不支持子代理**：`qoder.subagents-dropped x11`。Qoder 的子代理本来就是独立 transcript，
   理论上可以写（参考 Claude/DSH 的做法），这是下一个明确的保真缺口。
3. **DSH → Claude 的子代理没有父调用**：DSH 把子代理存成独立会话（`parentSession` 边），IR 里没有
   `viaToolCallId`，所以 Claude 侧写出的 sidecar 无法被 UI 关联。writer 现在会记
   `claude.subagent-unlinked`（warning）而不是静默通过。
   后续可选：加 `--synthesize-agent-calls`（在父会话补 Agent tool_use，默认关），或在报告里持续显式说明。
4. **跨 agent 的理性损失稳定**：reasoning dropped（Claude 不接受无签名 thinking）、model 不迁移、
   boundary 丢弃、synthetic 消息丢弃 —— 与 DESIGN §6.1 的分类一致。

## 复现实例

```bash
BIN=$(which sesport)   # 0.1.4

$BIN push "claude:0beb93b8-5179-4b81-8d54-9ec96de91c13" --to dsh \
  --include-children --register --home .tmp/dogfood/dsh-home

$BIN push "workbuddy:f022affa-196f-4fc4-a789-2439bdbd3a37" --to qoder \
  --home .tmp/dogfood/qoder-home

$BIN push "dsh:session-22e4f5f8-01b0-4c2a-95ba-433914d812d3" --to claude-code \
  --include-children --config-dir .tmp/dogfood/claude-home
```

## 下一步

- Qoder writer：支持 children（独立 transcript + meta/task 关联）
- Claude writer：对无 `viaToolCallId` 的 children 提供可选 `--synthesize-agent-calls`
- 继续用发布版 CLI 做真实迁移，逐步把「结构 PASS」升级成「目标 app 里可见」的证据
