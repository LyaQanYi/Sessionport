# 为 sessionport 做贡献

**中文** | [English](CONTRIBUTING.md)

感谢帮忙。sessionport 的存在前提是：会话格式都是私有的、而且一直在变。项目刻意设计成
**新增一个适配器是一个边界清晰、可评审的工作**，并且任何适配器都不能悄悄丢数据。

## 基本原则

1. **本地优先、零遥测。** 适配器里不允许网络请求；数据不离开本机。
2. **绝不提交真实会话内容。** fixtures 必须脱敏（替换消息正文、路径、工具输出），
   开发期间可以放在 `fixtures/private/`（已 gitignore）。
3. **不静默丢失。** 适配器带不走的东西，必须通过损失收集器报告出来。
4. **运行时依赖保持最少。** 优先 Node 内置模块（`node:*`）。新增依赖需要在 PR 描述里说明理由。

## 开发环境

需要 **Node >= 24**（TypeScript 由 Node 的类型擦除直接执行——没有构建步骤）和 pnpm。

```bash
pnpm install
node --test packages/core/test/*.test.ts packages/adapters/*/test/*.test.ts packages/cli/test/*.test.ts
```

真实 resume 冒烟测试会真实调用模型，由环境变量门控，例如 `SESSIONPORT_CC_RESUME=1`、
`SESSIONPORT_CODEX_RESUME=1`、`SESSIONPORT_OPENCODE_RESUME=1`。
它们绝不能成为普通 `pnpm test` 的必需项。

## 适配器契约

适配器只负责 `native <-> IR`，彼此不知道对方存在。完整理由见 [DESIGN.md §6](./DESIGN.md)。
实际结构：

- `src/wire.ts` —— 原生格式的类型与解析（容错：未知字段忽略，未知行跳过并计数）。
- `src/read.ts` —— `readXxxSession(input, options): Promise<IrBundle>`。选源（路径/id）、映射事件、
  对读取时丢弃的内容记录 `notices`。
- `src/write.ts` —— `writeXxxSession(bundle, options): Promise<WriteReport>`，带 `rows`、`paths`
  和排好序的 `losses` 列表。支持 `dryRun`（只生成不写盘）。
- `src/verify.ts` —— 结构校验（`{ name, ok, detail }[]`）加上可选的无头 resume 冒烟。
- `src/index.ts` —— 导出；命名与其它适配器保持一致。

以下全部具备，才算完成一个新适配器：

- [ ] 针对真实（脱敏）fixture 的 reader，fixture 缺失时测试自动 skip
- [ ] writer 往返：IR -> native -> IR 保留对话与工具配对
- [ ] `verify` 返回一份检查清单，输出损坏时会明确失败
- [ ] **真实 resume 证据**：确切命令、目标 CLI 版本、实际观察到的输出
- [ ] CLI 接线（`loadBundle`、`writeTarget`、`countTarget`、verify 分支）+ 包依赖
- [ ] `research/<agent>-format.md`，按你实际发现记录格式（验证了什么、没验证什么）

## 损失清单约定

每一个被丢弃的东西都要有一条记录，通过 core 的 `LossCollector` 添加：

```ts
losses.add('codex.reasoning-opaque', 'reasoning is encrypted and cannot be replayed', { severity: 'warning' });
```

- 代码格式是 `<agent>.<what>-<why>`；message 写给用户看，不是写给开发者。
- `severity: "info"` = 设计取舍或无副作用的归一化；`"warning"` = 用户会注意到的内容丢失。
- 如果目标端确实没有对应概念，就明说，并把它记成**设计取舍**；
  如果未来版本有可能带上，就把它列进 PR 的**能力缺口**。

## 版本登记

格式会漂移。每个适配器都要在 research 文档和测试里记录它验证过的版本（CLI 版本和/或格式版本）。
如果本机 CLI 版本不在已验证集合里，适配器仍应工作，但必须诚实：加 notice/loss，并在报告里提到未测试的版本。

## Pull request

小而聚焦。PR 描述里请包含：

1. 这个适配器覆盖什么（以及刻意不覆盖什么），
2. 确切的 resume 命令及其输出，
3. 一份损失清单示例，
4. 你测试时使用的 CLI 版本。

提交即表示你同意以 [Apache-2.0](./LICENSE) 授权你的贡献。
