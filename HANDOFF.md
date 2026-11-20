# sessionport 交接说明（2026-11-20）

给接手者（Antigravity / 其他 agent）的完整上下文。读完这份 + `README.md` + `DESIGN.md` 就能继续干活。

---

## 1. 这个项目是什么

**sessionport**（npm 包名 `sesport`，bins：`sesport` / `sesp` / `sessionport`）

把**正在进行的 AI 编程对话**从一个 CLI/桌面工具迁移到另一个，并且能真的续上。
不是"复制粘贴聊天记录"，也不是"摘要成一段 context"，而是写出**目标端自己能加载的原生会话**。

核心设计三件套：

- **IR**：归一化的追加式事件流（`message` / `reasoning` / `tool_call` / `tool_result` / `boundary`），用 `parentId` 串成链。
- **Adapter**：每家一个，只负责 `native -> IR` 和 `IR -> native`。
- **Loss list**：每次导出必须报告"丢了什么"，区分「设计取舍」和「能力缺口」。绝不静默丢数据——这是项目的价值观，改代码时必须守住。

唯一算数的验收标准：**目标 CLI 能自己加载这个会话并继续**。

---

## 2. 当前状态（截至 2026-11-20）

| 项 | 值 |
|---|---|
| 分支 | `main`，与 `origin/main` 同步，工作树干净 |
| 最新提交 | `504792e test(matrix): refresh against 2026-11 targets and fix codex 0.167 resume` |
| 最新发布 | **v0.1.10**（npm `sesport@0.1.10` + GitHub Release 4 个产物） |
| 测试 | 227 tests / 219 pass / **1 fail** / 7 skip（失败项见 §7） |
| 适配器 | 9 个：claude-code / codex / command-code / cursor / dsh / kimi-code / opencode / qoder / workbuddy |

### 可读可写矩阵

| Agent | 读 | 写 | 说明 |
|---|---|---|---|
| Claude Code | ✅ | ✅ | 含原生 subagents transcript |
| Cursor | ✅ | ✅ | 写 `state.vscdb`，需 `--confirm-real` |
| Qoder | ✅ | ✅ | 桌面任务列表服务端驱动 |
| DeepSeek Harness | ✅ | ✅ | 多帧 zstd 事件日志 |
| Codex | ✅ | ✅ | 含 threads/index 注册 |
| opencode | ✅ | ✅ | **CLI 2.x 改了子命令，当前坏了**，见 §7 |
| Command Code | ✅ | ✅ | 含桌面端注册 |
| Kimi Code | ✅ | — | 纯 source |
| WorkBuddy | ✅ | — | 纯 source |

---

## 3. 目录结构

```
packages/core/src/          IR 定义、损失收集、会话列表、sync、registry
packages/adapters/<agent>/  每家一个：read.ts / write.ts / wire.ts / verify.ts
packages/cli/src/index.ts   CLI 全部命令（单文件，约 45KB）
apps/desktop/               Electron 桌面端（renderer 不碰文件系统，全走 main 进程 IPC）
scripts/verify-matrix.mjs   真实恢复验收矩阵（核心工具，见 §5）
scripts/qoder-sdk-probe.mjs Qoder SDK 探针（用 Qoder 自带 Electron Node 跑）
research/*.md               各家的格式研究 + 验收矩阵报告（26 份，很重要）
```

**改代码前先读对应的 `research/<agent>-format.md`**——里面是实测出来的字段表和踩坑记录，比读代码快。

---

## 4. 常用命令

```bash
# 开发（Node >= 24，TS 直接跑，无需 build）
node packages/cli/src/index.ts list
node packages/cli/src/index.ts inspect "claude:<session-id>"
node packages/cli/src/index.ts push "dsh:<session-dir>" --to claude-code --include-children
node packages/cli/src/index.ts sync "claude:<id>" --to codex --register
node packages/cli/src/index.ts verify --agent claude-code --id <id> --resume

# 测试（不要用 pnpm，见 §6）
node --test packages/core/test/*.test.ts packages/adapters/*/test/*.test.ts packages/cli/test/*.test.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit

# 验收矩阵
node scripts/verify-matrix.mjs                    # 全量
node scripts/verify-matrix.mjs claude-dsh         # 单对（结果合并进 results.json）
node scripts/verify-matrix.mjs --sources-only     # 只预演源会话选择
```

---

## 5. 验收矩阵（项目最有价值的工具）

`scripts/verify-matrix.mjs` 对每一对「源 → 目标」做三件事：

1. push 到**隔离的目标 home**（不碰真实 app 数据）
2. 跑目标端结构 verify
3. 尽量跑**目标端原生加载**

### 原生加载的判定方式

| 目标 | 方式 | 隔离手段 |
|---|---|---|
| Claude Code | `expect` 打开 `claude --resume`，Ctrl+O 抓屏 | `CLAUDE_CONFIG_DIR` + seed 配置 |
| DSH | Electron headless `--json --session-id` | `DSH_HOME` |
| opencode | `opencode export` 读回 | `XDG_DATA_HOME` |
| Codex | `codex exec resume --json` | `CODEX_HOME`（**需复制 config.toml**） |
| Command Code | `cmd -p --session` | 复制 `~/.commandcode` 凭据 |
| Qoder | 自带 SDK 探针 | `QODERCN_CONFIG_DIR` |
| Cursor | 无 headless，人工 + CDP | 副本库 |

### 源会话选择：pin → auto → skip

- **pin**：写死的 id 能 inspect 就用（行为不变）
- **auto**：被清理了就自动挑「根会话 + 未归档 + 30 天内 + cwd 存在 + ≥20 events」的最新会话，理由写进 `results.json`
- **skip**：挑不到就明确 skip，不静默失败

### env skip 的约定

pty 耗尽时 `expect` 起不来，脚本记 `env: no more ptys` 并标 skip，**不要当成产品失败**。

---

## 6. 环境坑（务必先读，能省几小时）

### ⚠️ 不要用 pnpm

仓库 `.npmrc` 指向本地 `.pnpm-store`（8KB，空的），但 `node_modules/.modules.yaml` 记录的是
`~/Library/pnpm/store`。两者不一致 → pnpm 认为依赖过期 → 想**删掉 node_modules 重装** → 沙箱无外网，直接把环境搞废。

**替代做法**：`./node_modules/.bin/tsc`、`node --test`、`node_modules/.bin/electron-vite` 直接调用。

### 其他已知问题

- **pty 耗尽**：`expect -c 'spawn /bin/echo'` 直接报 `no more ptys`，导致 4 对 Claude TUI 检查只能 env skip。
- **全局 codex**：曾因缺可选依赖 `@openai/codex-darwin-arm64` 而完全不可用；工作区内有 `.tmp/codex-cli` 本地副本可用。
- **opencode 不在 PATH**：app 里带 `/Applications/OpenCode.app/Contents/Resources/opencode-cli`，但需要可写 XDG 目录。
- **沙箱**：只能写仓库内文件；`~/.kimi-code`、`~/.commandcode`、`~/Library/Application Support/Cursor` 等写不了。

---

## 7. 已知未完成 / 待修（按优先级）

### P0：opencode 2.x 完全不工作

**现象**：`claude-opencode` 这一对 fail/fail，`opencode export 没有 JSON 输出`。

**根因**：opencode 从 1.19.5 升到 **2.2.7**，CLI 把子命令改了：
- 旧（adapter 现在用的）：`opencode export <id> --pure` / `opencode import <file> --pure`
- 新：`opencode session export <id>` / `opencode session import <file>`

**要改的地方**：`packages/adapters/opencode/src/read.ts:49`、`packages/adapters/opencode/src/write.ts:273`。
建议做法：探测版本或先试新写法、失败回退旧写法，两边都保留。

### P1：Codex 测试失败（数据问题，非代码 bug）

`packages/adapters/codex/test/read.test.ts` 的「读取真实 Codex 会话」失败：
`actual: 9, expected: 8` — 有 1 个 `function_call` 没有对应的 `function_call_output`
（`call_d30a175244c64e36b244968f0ce76e32`）。

这是**真实样本数据不完整**（模型调用被中断），不是 reader 逻辑错。两个选择：
1. 放宽断言：允许少量未配对（记录成 notice）
2. 换一个配对完整的样本

**建议选 1**，因为真实世界就是会有中断的调用，reader 应该容忍并如实报告。

### P2：Cursor 3.31.11 桌面渲染未复核

上次确认是 3.27.22（CDP + 截图，见 `research/cursor-ui-2026-10-30.md`），现在 app 已到 3.31.11。
结构校验通过，但 GUI 渲染需要再跑一次。CDP 方法在报告里有完整记录，可以复用。

### P3：Kimi 2.6.3 兼容性

好消息：实测 2.6.3 写出的会话**能正常读**（867 events，`formatVersion=2` / `protocolVersion=1.5` 没变）。
待办：把矩阵里的 Kimi 样本换成 2.6.x 写出的会话，确认无回归。

### P4：其他

- Qoder 已卸载，两对走 skip；重装后 `scripts/qoder-sdk-probe.mjs` 会自动恢复
- Command Code 冒烟仍 opt-in（`--command-code-smoke`），有效凭据会花一次模型调用
- DSH→Claude 子代理的 **UI 展示**从未人工确认过（功能已实现，结构验证 PASS）

---

## 8. 未发布内容

`CHANGELOG.md` 的 `[Unreleased]` 有两项（矩阵 11-09 复跑 + Codex 0.167 修复），可以并进下一个版本。

发版流程见 `RELEASING.md`：改三处 `package.json` → 挪 CHANGELOG → commit + tag → `git push origin main --tags` → CI 自动发 npm + 构建 dmg。

---

## 9. 重要文档索引

| 文档 | 内容 |
|---|---|
| `DESIGN.md` | 整体设计、IR 语义、§6.1 损失分类（**改保真逻辑前必读**） |
| `README.md` | 用户视角、支持矩阵、命令 |
| `RELEASING.md` | 发版步骤 |
| `research/*-format.md` | 各家格式实测（claude-code / cursor / qoder / dsh / codex / opencode / kimi / workbuddy / command-code） |
| `research/verification-matrix-2026-11-09.md` | 最新验收矩阵报告 |
| `research/cursor-headers.md` §8 | Cursor 3.27 分块 header 迁移（修过的真 bug） |
| `CONTRIBUTING.md` | 贡献约定 |

---

## 10. 接手后的建议顺序

1. **修 opencode 2.x**（P0，唯一"完全不能用"的功能）
2. **修 Codex 测试**（P1，放宽断言 + 记 notice）
3. 发版（把 Unreleased 两项一起带上）
4. Cursor 3.31.11 桌面复核（P2）
5. Kimi 2.6.x 样本更新（P3）

---

## 11. 工作方式约定（从前任继承）

- **改代码前先读 research 里对应的格式文档**，再动手
- **任何丢弃数据的地方都要进 loss list**，并区分 severity（info = 设计取舍，warning = 能力缺口）
- **验收要跑到"目标端真的能加载"**，结构 PASS 不等于能用
- **测试失败先查是不是真实样本数据的问题**，别急着改断言
- 提交信息用 `type(scope): summary` 前缀，正文说清"为什么"
