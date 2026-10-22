# sessionport

[English](README.md) | **简体中文**

[![CI](https://github.com/LyaQanYi/Sessionport/actions/workflows/ci.yml/badge.svg)](https://github.com/LyaQanYi/Sessionport/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sesport.svg)](https://www.npmjs.com/package/sesport)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**把一个正在进行的 AI 编程会话，从一家 CLI 搬到另一家，并且能接着聊。**
在 Kimi Code 里开始的对话，可以变成 Claude Code 里能用 `/resume` 接着聊的原生会话。
不是粘贴转录，也不是注入一段摘要：目标 CLI 会像对待自己的会话一样把它加载起来。

> **状态：alpha。** 九个适配器：`claude-code`、`command-code`、`dsh`、`codex`、`opencode`、
> `cursor`、`qoder`（读写），以及 `kimi-code`、`workbuddy`（只读源）。每次导出都会明确列出丢了什么。
> 设计说明：[DESIGN.md](./DESIGN.md)。格式研究：[research/](./research/)。

## 为什么

每家 agent CLI 都把对话历史存在自己的私有格式里。换工具就意味着丢掉上下文。
现有工具要么只做单向翻译，要么把摘要重新灌进去。sessionport 两者都不做：

- **IR**：归一化的追加式事件流（`message` / `reasoning` / `tool_call` / `tool_result` / `boundary`），用 `parentId` 串成链。
- **适配器**：每家 agent 一个，只负责 `native -> IR` 和 `IR -> native`。
- **损失清单**：每次导出都会报告哪些内容没能保留，以及它是「设计取舍」还是「能力缺口」。
- **原生 resume**：唯一真正重要的验收标准——目标 CLI 必须能加载这个会话并继续对话。

## 安装

需要 **Node.js >= 24**（TypeScript 源码由 Node 的类型擦除直接执行；发布到 npm 的 CLI 是单个打包好的 JS 文件）。

```bash
npm install -g sesport          # 命令：sesport / sesp / sessionport
sesport inspect "kimi:./session_.../"
```

桌面端单独以未签名的 macOS `.dmg`/zip 分发（见 releases 页面，或在 checkout 里跑
`pnpm dist:desktop`）。

## 快速开始

需要 Node >= 22.18（TypeScript 由内置类型擦除直接运行，无需构建步骤）。

```bash
# 从仓库源码使用（开发 / 改适配器）：
git clone https://github.com/LyaQanYi/Sessionport && cd sessionport
pnpm install

# 1. 这个会话里有什么？
node packages/cli/src/index.ts inspect "kimi:./session_fdefc84f-.../"

# 2. 搬运它（为目标 CLI 写出一个原生会话）
node packages/cli/src/index.ts push "kimi:./session_fdefc84f-.../" --to claude-code

# 3. 证明目标端能 resume（会真实调用模型）
node packages/cli/src/index.ts verify --agent claude-code --cwd /path/to/project --id <session-id> --resume

# 完整链路（双向）一条命令跑完：
./scripts/demo.sh              # Kimi -> Claude Code
./scripts/demo-interop.sh      # Command Code <-> DeepSeek Harness
```

### 安全重推（sync）

`sync` 不会悄悄覆盖你在目标 app 里新增的对话：

```bash
node packages/cli/src/index.ts sync "dsh:<session-dir>" --to command-code --register
```

| 情况 | 行为 |
|---|---|
| 首次推送 / 目标文件不存在 | 新建写入 |
| 源端与目标端都没变 | **不写**（幂等） |
| 源端有新增、目标端没动 | 重写并更新 registry |
| **目标端有新增**（你在目标端接着聊了） | **拒绝**；`--fork` 另建会话，`--force` 覆盖 |

状态保存在 `~/.sessionport/registry.json`（用 `--state <dir>` 覆盖）。

## 支持的 agent

| Agent | 读 | 写 | Resume 验证 | 验证版本 |
|---|---|---|---|---|
| Kimi Code | ✅ `state.json` + `agents/*/wire.jsonl` | — | 仅作源 | CLI 2.1.1 / format v2 |
| Cursor | ✅ `state.vscdb` composerData/bubbleId | ✅ 新建 composer + header | 重启 app 后可见（续聊需手动发消息） | 3.25.9 |
| Qoder | ✅ `~/.qoder-cn/projects/*.jsonl` | ✅ 新建 transcript 文件 | ✅ Qoder SDK `listSessions` 能看到 | 1.1.69 |
| WorkBuddy | ✅ `~/.workbuddy/projects/*.jsonl` | — | 仅作源 | 5.8.3 |
| Claude Code | ✅ JSONL 会话文件 | ✅ JSONL 会话文件 | ✅ `claude -p --resume` | CLI 2.1.303 |
| Command Code | ✅ `projects/<slug>/<uuid>.jsonl` | ✅ + 桌面端注册 | ✅ `cmd -p --session` | 1.82.3 |
| DeepSeek Harness | ✅ 多帧 zstd 事件日志 | ✅ 原生 workspace 布局 | ✅ 无头加载 + 回放 | 5.8.3（format v4） |
| Codex | ✅ `sessions/**/rollout-*.jsonl` | ✅ + `threads` / index 注册 | ✅ `codex exec resume` | 0.163.0 |
| opencode | ✅ `opencode export` JSON | ✅ `opencode import` | ✅ `opencode run --session` | 1.19.3 |

子代理会话：加 `--include-children`。DSH 保留原生父子树；Claude Code 和 Command Code 没有父子概念，
子代理会被写成独立会话（内容保留，父子关系记入损失清单）。

## 保真度是怎么算的

读和写是不对称的，所以损失分两类记录：

- **notices**（每个会话、读取时）：源端有、但 IR 没有建模的东西——UI 镜像、运行时/配置事件、
  harness 注入的消息、被回滚的轮次。
- **losses**（每次导出、写入时）：IR 有、但目标端表达不了的东西。

损失分为**可接受的设计取舍**（根本没有对应映射，或我们有意不搬——例如模型绑定永远不迁移，目标端用自己的默认模型和
system prompt）和**可修的能力缺口**（无 sidechain 的目标端的子代理关系、图片附件、分支边界）。
详见 [DESIGN.md §6.1](./DESIGN.md)。

## 命令

```
sessionport inspect <source>
sessionport pull  <source> [--out ir.json]
sessionport push  <source> --to <agent> [options]
sessionport sync  <source> --to <agent> [options]
sessionport verify --agent <agent> [options]
```

源：`kimi:<dir>`、`claude:<path|id>`、`commandcode:<path|id>`、`dsh:<dir>`、`codex:<path|id>`、
`opencode:<path|id>`、`cursor:<composerId>`、`qoder:<path|id>`、`workbuddy:<path|id>`，或 IR `.json` 文件。
目标：`claude-code`、`command-code`、`dsh`、`codex`、`opencode`、`cursor`（写真实库需 `--confirm-real`）、`qoder`。

不只写文件，还注册进目标 app：`--register`（Command Code 桌面列表 / DSH workspace /
Codex `threads` + `session_index.jsonl`）。

大会话：`dsh` 目标支持 `--slim`——截断工具结果/参数、较早的 step 只保留消息、丢弃 reasoning，
让导入的会话装进目标模型的上下文窗口（每一处裁剪都会进损失清单）。

桌面端迁移页对 `dsh` 目标提供同样的选择（压缩 / 全量 / 精简），外加摘要引擎选择（抽取式 / Claude / Codex）——
LLM 摘要保持可选，默认抽取式。

`--compact` 是「日志无损」的变体：完整事件日志全部保留，并写入**DSH 原生 compaction 链**
（`compaction/start` → `compaction/summary` → checkpoint `surfaceOp: replace` → `compaction/end`），
模型只看到摘要 + 最近的 step。历史仍可回溯，之后还能被 DSH 再次压缩。摘要默认抽取式；
`--summary-llm claude|codex` 会复用本机已登录的 CLI 做多轮 LLM 摘要（先分段摘要、再合并，直到放进预算）。

### 复用目标端的官方导入

ZCode 和 Qoder 自带迁移流程，还能带上记忆/MCP/技能，并由厂商维护。能用就用官方：

```bash
sessionport import --into zcode claude:<id>     [--open] [--verify]
sessionport import --into qoder workbuddy:<id>  [--open] [--verify]
```

| 组合 | 官方路径 | sessionport 的角色 |
|---|---|---|
| Claude Code → ZCode | ZCode 首次引导 / 设置 → 迁移会话（扫描 `~/.claude/projects`） | 确保 Claude transcript 存在、给出步骤、对着 `tasks-index.sqlite` 验证 |
| WorkBuddy → Qoder | Qoder 设置 → 数据导入 → WorkBuddy | 确认源数据、给出步骤、对着 `~/.qoder-cn/projects` 验证 |
| Claude Code → Cursor | 无（只有 feature request） | 直接写：`push --to cursor --confirm-real` |

细节与证据：[research/official-import-paths.md](./research/official-import-paths.md)。

## 桌面端（early）

Electron 壳在 `apps/desktop`——渲染进程不碰文件系统，所有 adapter 工作都在主进程里做
（主进程直接 import 与 CLI 相同的 `@sessionport/*` 包）。

```bash
pnpm install
pnpm dev:desktop     # electron-vite 开发（开窗口）
pnpm build:desktop   # 生产构建 -> apps/desktop/out

# 打包：apps/desktop/release 下的 .app + dmg + zip（未签名）
pnpm dist:desktop
pnpm --dir apps/desktop dist:dir   # 只产出未压缩 .app，更快

# 无头冒烟（不开窗口，CI 可用）
cd apps/desktop && SESSIONPORT_SMOKE=1 ./node_modules/.bin/electron .
```

打包出来的 app 默认未签名（`mac.identity: null`），首次启动需要右键 → 打开，或执行
`xattr -dr com.apple.quarantine`。

当前界面：跨 agent 的会话浏览器、阅读器（IR 事件、notices、resume 命令）、带 dry-run 损失预览的迁移页。
IPC 是主进程里一份很小的类型化白名单，带 zod 校验。

界面支持中英双语（zh-CN / en-US）：默认跟随系统语言，设置 → 语言可以固定其中一种；
选择存在本地、立即生效（损失/提示文案按 code 翻译）。

迁移页还会列出厂商自己的导入流程（ZCode ← Claude Code、Qoder ← WorkBuddy），
带「一键打开 app」和「验证导入」按钮（直接读目标 app 自己的存储）。

| 会话浏览 | 适配器 | 设置 |
|---|---|---|
| ![会话浏览](docs/desktop-sessions.png) | ![适配器](docs/desktop-agents.png) | ![设置](docs/desktop-settings.png) |

| 阅读器 | 迁移 |
|---|---|
| ![阅读器](docs/desktop-reader.png) | ![迁移](docs/desktop-migrate.png) |

_会话可以按项目或时间分组；侧栏只列出你启用的 harness（首次启动自动检测已安装的数据目录，
可在设置里开关），设置固定在底部。浅色/深色主题跟随系统。UI 设计语言参考：
[ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md)。_

## 架构

```
packages/
├── core/                 # IR schema、损失收集、sync registry、sync 规划
├── adapters/
│   ├── kimi-code/        # 读
│   ├── claude-code/      # 读/写 + verify
│   ├── command-code/     # 读/写/verify + 桌面端注册
│   ├── dsh/              # 读/写/verify + workspace 注册
│   ├── codex/            # 读/写/verify + threads 注册
│   ├── opencode/         # 读/写/verify + import/export
│   ├── cursor/           # 读/写/verify（state.vscdb composerData/bubbleId）
│   ├── qoder/            # 读/写/verify（projects/<slug>/<uuid>.jsonl）
│   └── workbuddy/        # 读/写/verify（projects/<slug>/<sessionId>.jsonl）
├── cli/                  # inspect / pull / push / sync / verify
└── e2e fixtures 放在各 adapter 的 test/ 下

apps/
└── desktop/              # Electron 壳（React + Vite + Tailwind + TanStack Query）
```

## 开发

```bash
pnpm install
node --test packages/core/test/*.test.ts packages/adapters/*/test/*.test.ts packages/cli/test/*.test.ts
```

真实 resume 冒烟测试是门控的（会真实调用模型）：

```bash
SESSIONPORT_CC_RESUME=1     pnpm test   # Command Code
SESSIONPORT_CODEX_RESUME=1  pnpm test   # Codex
SESSIONPORT_OPENCODE_RESUME=1 SESSIONPORT_OPENCODE_MODEL=opencode-go/glm-5.2 pnpm test   # opencode
```

## 贡献与安全

新增适配器必须附带基准 fixtures，并注明验证时使用的 CLI 版本——见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
漏洞请按 [SECURITY.md](./SECURITY.md) 报告。

会话日志包含 prompt、代码，有时还有密钥：sessionport 是本地优先、零遥测的。

## License

[Apache-2.0](./LICENSE)。
