<!-- 调研归档，2026-10-19。完整证据在本地 .spikes/ccswitch-arch/（gitignored）。 -->
<!-- 用途：sessionport 前端选型参考。结论面向当时的 CC Switch 4.0.15 / Tauri 2.10.3。 -->

# CC Switch 桌面端架构调研报告（供 sessionport 前端选型）

- **调研对象**：`/Applications/CC Switch.app` 4.0.15（本机安装，2026-10-17 构建）
- **方法论**：本机 bundle/二进制/数据目录只读实测 → 交叉验证 GitHub `farion1231/cc-switch` tag `v4.0.15` 源码
- **标注约定**：**[实测]** = 本机二进制/包/数据目录实测；**[仓库]** = 上游 v4.0.15 源码确认；**[推测]** = 基于证据的推断
- **证据目录**：`evidence/`（01–10 编号与正文引用对应）
- **结论一句话**：CC Switch = **Tauri 2（Rust 后端 + WKWebView）+ React 18/Vite/Tailwind/shadcn 前端 + rusqlite 本地库**；它是「Rust 重写一遍核心逻辑」的路线，适合它（要跨平台原生壳 + 本地代理），**不适合 sessionport**（sessionport 的核心已经是 Node/TS，重写等于双份维护）。

---

## 1. 一页栈结论

### 1.1 桌面框架：Tauri 2（不是 Electron）—— **[实测]**

| 判据 | 实测结果 | 证据 |
|---|---|---|
| 包结构 | `Contents/` 下无 `Frameworks/`、无 `app.asar`、无 `app/`；`Resources/` 只有一个 `icon.icns` | `evidence/01-bundle-structure.txt` |
| 主二进制 | 单个 universal Mach-O（x86_64 + arm64），78 MB，`Contents/MacOS/cc-switch` | 同上 |
| 链接库 | `WebKit.framework` + AppKit/Carbon（**无** Electron Framework.framework） | `evidence/03-binary-crates-and-plugins.txt` |
| 二进制内嵌 crate | `tauri-2.10.3`、`tauri-utils-2.8.3`、`wry-0.54.3`、`tao-0.34.6`、`muda-0.17.1` | 同上 |
| 运行时协议 | `window.__TAURI_INTERNALS__`、`tauri://localhost`、`plugin:*` IPC 命名空间 | 同上 |
| 清单 | `Info.plist`: `com.ccswitch.desktop` / 4.0.15 / `LSMinimumSystemVersion 12.0` / URL scheme `ccswitch` | `evidence/02-info-plist.txt` |
| 声明依赖 | `Cargo.toml`: `tauri = "2.8.2"`（features: tray-icon, protocol-asset, image-png），构建解析到 2.10.3 | `evidence/06-src-tauri-Cargo.toml` |

> 附带结论：**Tauri 的 WebView 是 WKWebView**，数据落在 `~/Library/WebKit/com.ccswitch.desktop/WebsiteData`（有 LocalStorage / IndexedDB / 网络缓存），见 `evidence/08-data-dir-layout.txt`。**[实测]**

### 1.2 渲染层：React 18 + TypeScript + Vite 7 + Tailwind 3 + shadcn/ui —— **[仓库] + [实测交叉验证]**

| 维度 | 结论 | 证据 |
|---|---|---|
| 框架 | **React 18.2** + react-dom 18.2（`@types/react ^18.2`） | `evidence/05-frontend-package.json` |
| 构建 | **Vite 7**（`@vitejs/plugin-react` 4、`vite.build.outDir = ../dist`、dev server 固定 3000） | 同上；`04-tauri-conf.json` 的 `devUrl: http://localhost:3000` |
| 构建产物 | 二进制里内嵌 `/assets/index-*.js`（2 份）、`/assets/index-*.css`、`/assets/__vite-browser-external-*.js`；Tauri 以 brotli 压缩内嵌，二进制无明文 JS | `evidence/10-renderer-bundle-evidence.txt` |
| CSS | **Tailwind CSS 3.4** + PostCSS/autoprefixer + `tailwindcss-animate`；shadcn 的 HSL CSS 变量 + v7 设计 token（`--bg-app` / `--agent-*` 等）；darkMode 为 `.dark` selector | `src/index.css`、`tailwind.config.cjs` **[仓库]** |
| 组件库 | **shadcn/ui**（`components.json`: style=default, baseColor=neutral, cssVariables=true, iconLibrary=lucide）+ 23 个 `src/components/ui/*` 本地组件；底层 **Radix UI**（17 个 @radix-ui/react-* 包） | `components.json`、`evidence/05-frontend-package.json` |
| 其他 UI 依赖 | framer-motion 12、lucide-react 0.542、sonner、cmdk、recharts 3.5、@tanstack/react-virtual 3.13、@dnd-kit、CodeMirror 6、flexsearch | `evidence/05-frontend-package.json` |
| 表单/校验 | react-hook-form 7.65 + @hookform/resolvers + **zod 4.1** | 同上 |
| 类型 | TypeScript 5.3+（`tsc --noEmit` typecheck），vitest 2 + testing-library + msw | 同上 |

### 1.3 进程与 IPC：[实测] + [仓库]

- **三段式**：Rust main（`src-tauri/src/main.rs` → `lib.rs`）→ WKWebView renderer（无 preload 脚本概念；Tauri 用 `__TAURI_INTERNALS__` 注入）→ 无独立 Node 进程。**[仓库]**
- **通信**：`@tauri-apps/api/core` 的 `invoke()` + `Channel<T>`（流式），**不是** HTTP/WebSocket。命令面共 **324 个 `#[tauri::command]`**，全部在 `lib.rs` 的 `generate_handler![]` 注册。**[仓库]**
- **CSP**（`tauri.conf.json`）：`default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https: http:`，脚本只允许 `'self'` + 1 个 sha256。**[仓库]**
- **确实有本地 HTTP server，但只做 LLM 代理**：`proxy/server.rs` + axum 0.7/hyper 1.8，默认 `127.0.0.1:15721`，给 Claude Code / Codex 转发请求 + 记用量。**renderer 不通过它通信**。**[实测]** 二进制含 `axum-0.7.9`、日志模块 `cc_switch_lib::proxy::server`；**[仓库]** `proxy_config.listen_port DEFAULT 15721`（`07-sqlite-schema.sql`）。
- 进程间事件：Tauri emitter/events（`plugin:event|emit/listen`）、deep-link（`ccswitch://`）、single-instance 插件。

### 1.4 状态与数据：[实测] + [仓库]

| 层 | 结论 | 证据 |
|---|---|---|
| 前端状态 | **没有 zustand/redux/jotai**；只有 1 个 React Context（`UpdateContext.tsx`）+ 大量 `useState`；**服务端状态全部走 TanStack Query 5**（`queryClient` retry 1 / staleTime 0 / refetchOnWindowFocus=true）；UI 偏好用 `localStorage`（如语言） | `src/lib/query/*`、`src/i18n/index.ts` |
| 持久化（主） | **SQLite**：`~/.cc-switch/cc-switch.db`（19 MB，user_version 20），Rust `rusqlite 0.31 (bundled)`；**17 张业务表**：providers / provider_endpoints / provider_health / mcp_servers / prompts / skills / skill_repos / settings / profiles / proxy_config / proxy_request_logs / proxy_live_backup / stream_check_logs / model_pricing / usage_daily_rollups / session_log_sync / session_usage_dedup | `evidence/07-sqlite-schema.sql`、`07b-sqlite-tables.txt` |
| 配置/状态文件 | `~/.cc-switch/settings.json`、`live-state.json`、`model-pricing.json`、`logs/`、`backups/`（**真实数据根是自定义的 `~/.cc-switch`，不是 Application Support**） | `evidence/08-data-dir-layout.txt` |
| Tauri 应用数据 | `~/Library/Application Support/com.ccswitch.desktop/`：`.window-state.json`（window-state 插件）、`app_paths.json`（store 插件） | 同上 |
| 会话数据源 | 不搬走宿主数据：直接读 `~/.codex/sessions/**.jsonl`、`~/.claude/projects`、opencode sqlite 等，做 usage 导入 + 会话浏览（`services::session_usage_*`、`session_manager::providers::*`） | `evidence/11-session-manager.md` |

### 1.5 工程化：[实测] + [仓库]

- **包管理**：pnpm 10.12.3；`pnpm-workspace.yaml` 的 `packages: []` → **不是 monorepo**（单仓 = 1 个 Rust crate + 1 个 Vite 前端）。**[仓库]**
- **打包**：Tauri CLI（`pnpm tauri build`），`bundle.targets = "all"`、`createUpdaterArtifacts = true`；macOS 产出 .app/.dmg（minimum 12.0）。**[仓库]**
- **签名/公证**：**[实测]** `codesign` 显示 `Developer ID Application: Jason Young (R8UR22V2F9)`、hardened runtime、**Notarization Ticket=stapled**。**[仓库]** release.yml 分架构编译（`--no-bundle`）→ `macos-release` job 导入 Apple 证书、合并、公证；更新签名用 `TAURI_SIGNING_PRIVATE_KEY`。
- **自动更新**：`tauri-plugin-updater` + minisign（二进制含 `minisign-verify 0.2.5`），endpoints = `https://dl.ccswitch.io/latest.json` + GitHub Releases `latest.json`。**[实测]** 日志有 updater 检查失败记录；**[仓库]** `tauri.conf.json plugins.updater`。
- **CI**：GitHub Actions；`ci.yml` = 前端(pnpm typecheck/format/vitest/build) + 后端 3 OS(cargo fmt/clippy/**nextest**) + WSL2 nightly；`release.yml` 三平台矩阵；另有 `sync-r2.yml`（R2 CDN）。**[仓库]**
- **体积/构建**：Rust `opt-level="s"`, thin LTO, strip symbols, codegen-units=16（注释说主 crate 编译快 64%、体积 +17%）。**[仓库]**

### 1.6 i18n / 主题 / 平台适配 —— **[仓库] + [实测]**

- **i18n**：i18next 25 + react-i18next 16，5 语言（zh / zh-TW / en / ja / tr），**首屏用 localStorage + navigator.language 同步决策，启动后用后端 settings 校正并回写**（`syncLanguageFromSettings`，注释解释 WebView 来源不同会读到旧值——这是我们做桌面端要注意的真实坑）。**[仓库]**
- **主题**：Tailwind `.dark` class + HSL 变量 + v7 设计 token 双层；焦点色橙 `#F97316`；字体系统栈。**[仓库]**
- **窗口/标题栏**：`titleBarStyle: "Overlay"` + `trafficLightPosition {x:14,y:16}` + 自绘 `WindowControls`（Windows/Linux 用），窗口默认 `visible:false`（避免白屏闪）。**[仓库]** `04-tauri-conf.json`
- **托盘**：`tray.rs` 三层架构（collect → 纯数据 menu model（单测覆盖）→ attach 到原生菜单），左键菜单、macOS 模板图标；日志有 `cc_switch_lib::tray`。**[实测+仓库]**
- **快捷键**：全部 JS `keydown` 实现（⌘F / ⌘K / ⌘\ / ⌘,），**没有** global-shortcut 插件。**[仓库]**
- **平台适配坑**：`platform.ts` 用 UA 判断平台；Linux 禁用 drag region（Wayland/Tauri #13440）；Windows 禁用 CSS 拖拽防 CPU 抖动；有 `linux_fix.rs`、`hermes_wsl.rs`、`wsl2-nightly.yml`、flatpak 目录 → **跨平台成本真实存在**。**[仓库]**

### 1.7 代码组织 —— **[仓库]**

```
src-tauri/src/
  lib.rs (2438 行，启动/插件/托盘/窗口/命令注册)
  commands/            37 个领域命令模块（provider/mcp/skill/prompt/session_manager/proxy/...）
  services/            业务服务（provider, session_usage_*, webdav_sync, usage_cache）
  database/{schema,dao,backup}   rusqlite 迁移 + DAO + 备份
  proxy/{server,forwarder,providers,usage,http_client}   axum 本地代理
  session_manager/{model,content,cache,providers/<agent>.rs,terminal}  会话浏览（最接近 sessionport）
  mode/, live/, deeplink/, mcp/, resources/, pi_config/
  tray.rs app_store.rs settings.rs provider.rs config.rs ...
src/
  components/{sessions,reader,providers,proxy,usage,skills,mcp,prompts,profiles,settings,shell,ui}
  lib/{api,query,schemas,utils,errors}   invoke 包装 / TanStack Query / zod
  hooks/ contexts/ i18n/ types.ts config/ whats-new/
```

- `lib/api/*` = 手写、按领域拆文件的 `invoke()` 薄包装；`lib/query/*` = queryKey 工厂 + useQuery/useMutation。**没有从 Rust 类型生成 TS**，靠 `src/types.ts` 两侧手工对齐 + 共享 fixture JSON（session_manager/model.rs 注释明确说了这一点，是个可改进点）。
- **无 JS 插件/扩展机制**；扩展性靠「每个 agent 一个 provider 模块 + 注册表」的编译期分发（`session_manager/mod.rs` 里 `match provider_id` + 并行 thread 扫描）。

---

## 2. sessionport 前端选型对比（重点）

### 2.1 先明确约束（sessionport 现状）

- 核心 = **Node 24 + TypeScript** 的 `@sessionport/core`（IR v0.1 / loss / registry / sync）+ **6 个 adapter** + `@sessionport/cli`（inspect / pull / push / sync / verify，`--resume` 会真实调模型）。
- 会话数据的 **source of truth 在各 agent 自己的目录**；`~/.sessionport` 只存 registry（对齐状态）。
- 已具备：IR 事件流（含 `_native`）、`IrNotice`（读入损失）、`LossCollector`/`ExportCaps`（写出损失）、断点续推（registry 的 targetUnits/sourceHead）。
- 前端需求：**浏览所有 agent 会话、预览、一键迁移、看损失报告**。

⇒ 前端**不应该重新实现任何解析/写入**，只应是一个「本地进程的视图 + 操作面板」。这一点决定选型。

### 2.2 四个候选

| 方案 | 复用现有 TS 核心 | 打包/签名/更新成本 | 体积/内存 | 适用判断 |
|---|---|---|---|---|
| **A. 纯 Web UI + 本地 Node server**（`sessionport web`，浏览器打开；dsh web / opencode web 同款） | ★★★★★ 直接 import core，零重写 | 最低：无签名、无公证、无 updater；只需 npm 包分发 | 前端 dist ~1–3 MB，服务器就是 Node 进程 | **MVP 首选**。可先用 `127.0.0.1:0` 随机端口 + token 跑通全部功能与 UI |
| **B. Electron**（main 进程 Node 直接 import core / spawn CLI） | ★★★★★ 原样复用（主进程就是 Node） | 中高：electron-builder + Apple notarize + electron-updater，生态成熟、文档多；两平台构建要 CI | ~100–150 MB / 150–250 MB | **要单一下载即用桌面端时的首选**，对 TS 团队最省心 |
| **C. Tauri 2 + Node sidecar**（CC Switch 同款壳，核心用 sidecar 跑） | ★★★☆☆ 壳里只能 `invoke`/HTTP，核心必须走 sidecar 进程；不重写但要多做一层 sidecar 生命周期、端口/握手、双份签名 | 高：Rust 工具链 + sidecar 二进制也要签名/公证/hardened + 两个 updater 产物 | 壳 ~15 MB + Node sidecar ~50–90 MB ⇒ 合计接近 Electron；内存略低 | **想做「原生小壳 + CLI 优先」时的折中**；需要接受 Rust 构建与跨平台 WebView 差异（CC Switch 的 `linux_fix.rs`/WSL/flatpak 就是成本证据） |
| **D. TUI**（Ink / opentui） | ★★★★☆ 同进程 import core | 最低 | 最小 | **作为补充**（ssh/CI/无 GUI 环境），不适合「浏览 + 预览 + 损失报告」的主界面 |

### 2.3 明确推荐：**两阶段，先 A 后 B（或 C），不要一步上 Tauri**

**阶段 1（建议立刻做，1–2 周）：`sessionport web`**
- 新增 `packages/server`：`node:http`（或 Hono/Fastify，二选一，别上重框架）暴露 REST + SSE：
  - `GET /api/agents`（adapter 列表 + `ExportCaps` 能力矩阵）
  - `GET /api/sessions?agent=&q=&cursor=`（轻量扫描：只读 meta，不构建完整 IR）
  - `GET /api/sessions/:agent/:id`（IR，或分页事件）
  - `POST /api/migrate {source,target,dryRun:true}` → **先返回 `LossEntry[]` 预览**；`dryRun:false` 才写
  - `GET /api/registry`（同步状态）
  - `GET /api/events`（SSE：长任务进度）
  - 安全：bind `127.0.0.1`、随机 bearer token、`Origin` 校验、路径必须落在该 agent 白名单根目录下（复用 `paths.ts` 已有校验）。
- `apps/web`：React + Vite + Tailwind + shadcn + TanStack Query/Virtual（对标 CC Switch 渲染层，见 §3）。
- CLI 增加 `sessionport web [--port] [--open]`，复用同一套 core 函数（**server 与 CLI 共享实现，不 spawn 子进程**）。
- 好处：现在就能验证「会话浏览 + 损失报告」的信息架构；没有签名/公证/updater 负担；后续桌面壳只是「打开这个 URL 的窗口 + 托盘 + 文件对话框」。

**阶段 2（要桌面分发时再决定）**
- 若团队不想碰 Rust：**Electron + electron-builder**。主进程 `import { sync } from '@sessionport/core'` 或 `spawn('sessionport', ...)`；窗口加载 `http://127.0.0.1:<port>`（不要 `file://`，避免 CORS/CSP 两套逻辑）。
- 若确实要「小壳 + 原生感」：**Tauri 2 + Node SEA sidecar**。把 CLI 用 Node SEA 打成单文件 `sessionport-core` 作为 `externalBin`，壳只负责窗口/托盘/文件对话框/自动更新；**注意 sidecar 必须一起签名 + notarize**，更新要发「壳 + sidecar」两个产物，这比 Electron 多一层。
- **不建议**把 core 用 Rust 重写（那正是 CC Switch 走的路，见 §4）。

**TUI**：保留 `sessionport tui` 作为无 GUI 补充即可，不与主前端争资源。

---

## 3. 可复用的 CC Switch 模式（对 sessionport 价值最高的 6 条）

1. **会话列表的数据模型**：`SessionMeta { providerId, sessionId, title, summary, projectDir, createdAt, lastActiveAt, sourcePath, resumeCommand }`（`session_manager/mod.rs`）。**轻量 list 与重量 IR load 分离**——列表只扫 meta，详情才解析全文；扫描按 agent 并行（`std::thread::scope`），按 `lastActiveAt` 排序。sessionport 的 `inspect` 已有能力，建议在 core 增补 `listMeta()` 而非复用完整 pull。
2. **大会话的流式 + 分页**：`Channel<TranscriptChunk>` 依次推 `Header(total, turns, cached, parse_ms)` → 若干 `Messages(start, chunk)` → `Done`，失败先推 `Error`；工具输出/思考/diff 用 `ContentRef` 按 **512K 字符分页**按需取；图片用 `ImageRef` 取原始字节转 Blob。**sessionport 的 Web 版对应 SSE + Range 分页**，别一次性把 IR 全塞给前端。
3. **解析缓存按源指纹**：`(provider, sourcePath) + source_fingerprint → Transcript`，命中即返回 `cached/parse_ms`。sessionport 可在 `~/.sessionport/cache/` 做同样的事（可重建、非 source of truth）。
4. **turn 分组渲染层**：`reader/turns.ts` 把 `SessionMessage[]` 归约成 `Turn[]`（提问 → 执行步骤 → 最终回复），步骤含 tool/thinking/note/image/event/merged，配对 tool_call↔tool_result，并按 agent 风格合并（Codex「Explored」、Claude「Called X N times」），最后产出 `ReaderRow[]` 给 `useVirtualizer`。**这正是 sessionport 需要的「IR → 阅读视图」纯函数层**，而且我们 IR 已经比它的 `SessionMessage` 更规范。
5. **损失报告 UI 形态**：CC Switch 没有迁移损失报告，但它的 **provider 健康/用量表**展示了我们该抄的呈现方式：按严重度分组 + 计数 + 可展开明细 + 顶部汇总卡片；我们直接把 `LossEntry[]`（code/message/count/severity）做成表格 + 「写入前 dryRun 预览」两步确认。**这是 sessionport 的差异化功能，值得做成主流程**：选择源 → 选目标 → 预览损失（含 `ExportCaps` 能力矩阵红/黄/绿）→ 确认写入 → 显示 writeReport + 目标端 resume 命令。
6. **工程化骨架**：`src/lib/api/*`（invoke 薄封装）→ `src/lib/query/*`（queryKey 工厂 + useQuery/useMutation）→ 组件；`src/components/ui/*` 本地 shadcn 组件 + Radix；i18n 用「localStorage 先渲染、后端设置再校正」避免桌面首屏语言闪烁；托盘用「collect → 纯数据 model（单测）→ attach」三层。

另外可复用：**resume 命令生成放在「会话 meta」层**（`resumeCommand` 字段）——sessionport 的「目标端原生 resume」比它更进一步，但 UI 上应当照它那样「复制命令 + 复制 cwd + 可选终端打开」三件套。

---

## 4. 应该避开的做法（CC Switch 的教训）

1. **把核心逻辑在 Rust 里重写一遍**。CC Switch 的会话解析在 Rust（`session_manager/providers/*.rs`，9 个 agent）而 provider/配置管理又在 TS 前端有大量对应逻辑；两侧类型靠手写 `types.ts` + 共享 fixture 对齐（`model.rs` 注释自述）。sessionport 的核心是 TS，**一旦开新语言就永久双份维护**——前端必须是「同一份 TS core 的视图」。
2. **IPC 命令大爆炸 + 无契约**：324 个 `#[tauri::command]`、`generate_handler!` 单文件注册、TS 类型手写。用 **web server + zod schema + 自动生成的 client 类型** 更可控；命令数控制在几十个资源化端点。
3. **信任 renderer、接受任意 shell 命令**：`session_manager.rs` 注释明确写「`command` 是刻意不加校验的、把 renderer 当可信边界」。sessionport 不应复制：**spawn 固定 argv、绝不 shell 拼接；路径必须校验在 agent 根目录内**（它自己在 `content::validate_source` 做了这件事，这点要学）。
4. **一开始就上完整签名/公证/自动更新/自建 CDN**：CC Switch 有 Developer ID 证书、公证、minisign、`dl.ccswitch.io` + R2 + flatpak + WSL2 nightly + 三平台矩阵。这是成熟产品的成本结构，sessionport 早期只需 npm 包 + 可选 Homebrew，桌面壳等到有分发需求再做。
5. **为跨平台 WebView 差异付税**：Linux Wayland 拖拽、WebKitGTK 依赖、Windows WebView2 拖拽 CPU、WSL 路径……若选 Tauri 要有心理准备；Electron 在这些点上是「一套 Chromium」。
6. **UI 状态库/插件体系过度设计**：它没有 zustand 也活得很好（TanStack Query 管服务端状态 + Context 管全局 UI）；也**没有**插件系统——用「注册表 + 编译期分发」保持简单。sessionport 现在不需要插件机制。

---

## 5. 最小前端骨架建议（不写代码，只给结构）

```
packages/
  core/            (现有：ir/loss/registry/sync/paths/ids)  ← 唯一真相
  adapters/*/      (现有 6 个)
  cli/             (现有：inspect/pull/push/sync/verify) + 新增 web 子命令
  server/          ← 新增：node:http + SSE，import core，不 spawn
    routes/agents.ts  sessions.ts  migrate.ts  registry.ts  events.ts
    security.ts      (127.0.0.1 + token + Origin + 路径白名单)
  protocol/        ← 新增：zod schema + 从 core 类型导出的 DTO（前端/服务端共用）
apps/
  web/             ← 新增：React 18/19 + Vite + Tailwind + shadcn + TanStack Query/Virtual
    routes: /sessions        列表（虚拟滚动 + 搜索 + agent 过滤）
            /sessions/:agent/:id   阅读视图（turn 分组 + 折叠步骤 + 全文按需加载）
            /migrate             源/目标选择 → 能力矩阵 → 损失预览(dryRun) → 确认写入
            /reports             历史迁移报告（writeReport + resume 命令 + registry 状态）
            /settings            数据目录探测 / 语言 / 主题
    state: TanStack Query（服务端）+ 1 个 AppShell Context（UI），不引入 zustand
    i18n: i18next，zh-TW/en/ja 起步，localStorage 先渲染 + /api/settings 校正
```

- **进程边界**：CLI 与 server 共享 `@sessionport/core` 的函数调用；桌面壳（未来）只加载 `http://127.0.0.1:<随机端口>/?token=...`，**不为桌面壳新增 IPC 协议**（这正是 dsh web / opencode web 的做法，也避免 CC Switch 那种 324 命令面）。
- **数据获取**：列表 = 轻量 meta + 分页；详情 = IR 分页/SSE；迁移 = 任务 + SSE 进度；所有写操作前 `dryRun` 出损失。
- **UI 优先级**：P0 会话列表 + 阅读 + 损失预览；P1 一键迁移 + 报告；P2 主题/托盘/自动更新（等桌面壳）。
- **验证路径**：先用 Playwright 对 `sessionport web` 做 E2E（6 个 adapter 的真实 fixture），再决定壳。

---

## 6. 附：一句话回答 Lead 的三个问题

1. **框架结论**：Tauri 2（Rust + WKWebView），非 Electron——本机实测无 `Frameworks/`、无 `app.asar`、单 Mach-O 链接 WebKit、二进制含 `tauri-2.10.3/wry-0.54.3`。
2. **关键依赖版本**：React 18.2 / Vite 7 / Tailwind 3.4 / shadcn+Radix（17 包）/ TanStack Query 5.90 + Virtual 3.13 / RHF 7.65 + zod 4.1 / i18next 25 / framer-motion 12 / recharts 3.5 / CodeMirror 6；后端 rusqlite 0.31 + axum 0.7 + reqwest 0.12 + tokio 1.50 + rquickjs 0.8。
3. **数据层方式**：不是 electron-store/localStorage 为主，而是 **rusqlite 管理的 SQLite（`~/.cc-switch/cc-switch.db`，17 张业务表）+ 自定义 JSON（settings/live-state/model-pricing）+ Tauri store/window-state 插件 + WKWebView localStorage（UI 偏好）**；source of truth 仍是各 agent 原生文件，DB 是索引/用量/配置。
