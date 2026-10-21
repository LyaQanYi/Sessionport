# 官方会话导入路径调研（2026-10-21）

结论：**ZCode 与 Qoder 各自内置了官方会话导入**，可直接复用；**Cursor 没有**（社区 feature request）。
三家的官方入口都没有可脚本触发的 CLI / 深链，因此 sessionport 的策略是「准备源 → 引导操作 → 事后验证」。

## 1. 结论矩阵

| 目标 | 官方支持 | 机制 | 官方读取的源 | 落库位置 | 触发方式 |
| --- | --- | --- | --- | --- | --- |
| ZCode 3.15.3 | ✅ | 内置 Claude Code 迁移 | `~/.claude/projects`（及 CLAUDE_CONFIG_DIR / HOME） | `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表（含 `migration_source`） | 首次引导「迁移会话数据」/ 设置 → 迁移会话数据（GUI） |
| Qoder CN 0.4.8 | ✅ | 设置 → 数据导入 | `~/.workbuddy`（以及 `.codebuddy` 等来源） | `~/.qoder-cn/projects/<projectKey>/<uuid>.jsonl` | 设置 → 数据导入 → 选择来源 → 开始导入（GUI） |
| Cursor 3.25.9 | ❌ | 无 | — | — | 官方论坛只有 feature request；需要直接写 `state.vscdb` |

## 2. 证据

### ZCode [实测]

- `/Applications/ZCode.app` 3.15.3（`dev.zcode.app`）。
- 解包 `app.asar` 后，`out/main/chunk-ZCWQ2IP2.js` 中存在 `ClaudeNativeSessionImportRepo`：

      getNativeProjectsRoots(){ let t=new Set; t.add(Mw()); ... [...t].map(a=>lr(a,".claude","projects")) }
      readJsonLinesFileHead(...)   // 读 Claude transcript 头部
      shouldIgnoreClaudeNativeTranscriptDir(...)  // 跳过 subagents/worktree

- 渲染层 i18n：`occupationOnboarding.migration` = 「迁移会话数据」，`occupationOnboarding.migrationDescription` = 「从 Claude Code 迁移历史会话数据」；
  另有 `settings.migration.reason.session_not_found_or_workspace_mismatch` 等失败原因文案，说明在设置里也有迁移入口。
- 导入结果落在 `~/.zcode/v2/tasks-index.sqlite`：`tasks` 表有 `migration_source`、`workspace_path`、`task_id` 等列。
- ZCode CLI（`Resources/glm/zcode.cjs`，0.16.9）只有 `--resume`/`--continue`/`-p`/`tui`/`app-server`，**没有 import/migrate 子命令**。

### Qoder [实测]

- `/Applications/Qoder CN.app` 0.4.8（`com.qodercn.app.stable`）。
- 解包 `app.asar` 后，主进程 `electronMain.js` 里存在 WorkBuddy 来源识别与导入逻辑：

      Lhe={quest:..., qoderWork:..., workbuddy:dhe}
      YAe=/(?:~\/|\$HOME\/|%USERPROFILE%[\\\/]|Path\.home\(\)\s*\/\s*)\.(?:workbuddy(?:-ai)?|codebuddy)(?:[\\\/]|\b)/iu

- 渲染层 i18n（`out/renderer/assets/DIR8HOYO.js`）：`importDataAction`「导入数据」、`importStart`「开始导入」、
  `importSessionsViewInSettings`「可在设置 - 数据导入中查看进度」、`importSessionsStartedInBackground`、
  `importSessionsNothing`、`importSessionToStore` 等；导入项包含会话、MCP 连接器、记忆（`importMcpAllFailed` / `importMemoryAllFailed`）。
- 官方导入器自己扫描来源 app 的本地数据，写入 `~/.qoder-cn/projects`；不需要第三方写它的格式。
- Qoder 没有独立 CLI（`qodercli` 是内置 agent runtime），也没有 import 深链。

### Cursor [实测 + 官方文档 + 仓库]

**官方文档**：cursor.com/llms.txt 全量索引里没有任何「会话导入」文档；只有
`/help/getting-started/migrate-vscode`、`migrate-jetbrains`（迁移设置/扩展）和 Cloud Agent API 的
environment history（远端环境历史，不是本地 chat）。结论：**没有文档化的 Claude Code/Codex 会话导入**。

**但 Cursor 3.25.9 里有开发者导入命令**（`f1` 默认 true，命令面板可见，category=Developer）：

- `developer.exportChat` — `Export Chat (Developer)`：把当前 composer 导出成 **Cursor Chat export JSON**，
  结构为 `{ version: 1, name, conversationState: base64(protobuf), blobs: { key: base64 } }`。
- `developer.importChat` — `Import Chat... (Developer)`：选择上述 `.json` 导入当前 workspace
  （必须已打开文件夹；只接受 `version === 1`，导入后 `openComposer` 打开）。
- `developer.bulkImportChats` — `Bulk Import Chats from Directory... (Developer)`：选一个目录批量导入
  目录下所有 `.json` 导出。

**这说明**：Cursor 有官方导入面，但只吃 **Cursor 自己导出的 protobuf 格式**，不是 Claude Code transcript。

**但它们是开发者命令，正式版不可用** [实测]：

- `developer.exportChat`：`f1:!1`（命令面板隐藏），前置条件 `isDevelopment || isDevUser`；菜单项只在
  `editor scheme == composer` 且 dev 上下文为真时注入编辑器标题菜单。
- `developer.importChat` / `bulkImportChats`：同样带 `isDevelopment || isDevUser` 前置条件。
- 本机正式版 Cursor 3.25.9 中，命令面板搜不到 Export/Import Chat（已验证），也没有设置项可以打开。
- 想验证这条路径，需要以**扩展开发模式**启动 Cursor（`--extensionDevelopmentPath=...`）让 `isDevelopment` 为真，
  或者伪造 `isDevUser` 存储标记（不建议改正式 profile）。因此**官方导入不是稳定的用户级集成面**。

所以 Claude Code → Cursor 目前仍**没有原生导入**；论坛帖只是 feature request（Cursor 员工回复认可，未提供 API），
社区插件（0smboy/agent-migration-cursor-plugin）依旧 patch 私有 `state.vscdb`。

**结论**：官方导入路径在正式版被开发者门槛挡住，暂不作为 sessionport 的方案；继续使用已验证的
直接写入 `state.vscdb`（`push --to cursor --confirm-real`）。若未来 Cursor 把导入转为用户功能，再切回官方入口。

## 3. sessionport 如何复用

新增命令（不重复实现官方逻辑，只做「准备 + 引导 + 验证」）：

    sessionport import --into zcode  claude:<id>     [--open] [--verify]
    sessionport import --into qoder  workbuddy:<id>  [--open] [--verify]
    sessionport import --into cursor claude:<id>     # 说明无原生 Claude 导入；Cursor 的 Developer Import Chat 只吃它自己的导出格式

- ZCode：确认 Claude transcript 已在 `~/.claude/projects`（源就是 Claude Code 时无需写任何东西），打印官方迁移步骤；
  `--verify` 读 `tasks-index.sqlite`，按 cwd/标题匹配已导入任务。
- Qoder：确认 `~/.workbuddy/projects` 存在，打印「设置 → 数据导入 → WorkBuddy → 开始导入」；
  `--verify` 扫 `~/.qoder-cn/projects`，按 cwd/标题匹配新导入的 transcript。
- 官方导入比我们直接写目标格式更完整（Qoder 还能带 MCP/记忆），所以**优先引导官方路径**；
  `push --to qoder` 仍作为无 GUI 环境的兜底。

## 4. 后续可做

- 若官方暴露 CLI/IPC（例如 ZCode `app-server` 或 Qoder 内部 IPC），把 `import` 从「引导」升级为「直接调用」；
- ZCode 的 `tasks-index.sqlite` 写入路径可作为无 GUI 兜底方案调研（注意 vendor 兼容性风险）；
- Qoder 导入还包含 MCP/记忆，可在验证阶段一并统计（`importMcpSkippedDetail` 等）。

## 5. 参考

- Cursor 论坛 feature request: https://forum.cursor.com/t/native-agent-history-import-importer-api-for-claude-code-codex-and-cursor-sessions/164604
- 同类开源项目（Claude Code/Codex/ZCode 六向迁移）: https://github.com/llxgdtop/Agent-Session-Migration
- Qoder + Claude 桥接项目: https://github.com/ranxianglei/qoder-claude-bridge