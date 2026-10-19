# Command Code 与 DeepSeek Harness 的会话存储格式

> 调查日期：2026-10-19，macOS，本机实测。只记结构（路径、键名、枚举、版本号），不含消息正文。
> 目的：为 sessionport 的 command-code / dsh 两个 adapter 提供事实基线。
> 细节与实测证据见 [command-code-spec.md](./command-code-spec.md) 与 [dsh-spec.md](./dsh-spec.md)。

## 1. Command Code 1.82.3

**形态**：Electron 桌面 app + 同源 CLI（command-code npm 包，bin 名为 cmd / cmdc / command-code / commandcode）。

**存储布局**

```
~/.commandcode/
├── projects/<slug>/<session-uuid>.jsonl        # 会话正文，一行一个 JSON
│                    <session-uuid>.meta.json   # { entrypoint, traceIds[], title }
│                    <session-uuid>.checkpoints.jsonl
├── history.jsonl                               # { p: <prompt>, t: <epoch ms> }
├── config.json                                 # { model, reasoningEffort, starredModels, ... }
├── auth.json / models-cache.json / cache/ / file-history/ / plans/ / ide/
```

桌面端另有索引库：`~/Library/Application Support/Command Code/thread-index.db`，
单表 `threads(id, title, project_path, model, git_branch, unread, created_at, updated_at, last_activity_at, has_transcript)`。

**transcript 行格式（version 3）**

首行是会话头：

```json
{"type":"session","version":3,"id":"<uuid>","timestamp":"ISO 8601","cwd":"/abs/path"}
```

其余是消息行（parentId 构成链，首条为 null）：

```json
{"type":"message","id":"<8位hex>","parentId":null,"timestamp":"ISO 8601",
 "message":{"role":"user|assistant|tool","content":[{"type":"text","text":"..."}],"meta":{...}}}
```

**CLI（headless 可用）**

```bash
node "/Applications/Command Code.app/Contents/Resources/app/node_modules/command-code/dist/index.mjs" --help
# 关键参数：
#   -p/--print [query]        非交互，--output-format text|json
#   -r/--resume [id|name]     按 id 或名字恢复
#   --session <path|id>       按 transcript 路径或 id 前缀恢复
#   -c/--continue             继续最近一次会话
#   --fork-session            恢复时 fork
#   --config key=value        无头改配置
#   --skip-onboarding / --yolo / --model 等
```

源码里可见 `createSessionStoreV3({ baseDir, cwd, persist })`，baseDir 可由调用方覆盖 ——
这说明写入目录不是硬编码的，adapter 可以只生成目录、由用户/CLI 决定落点。

## 2. DeepSeek Harness（DSH）

**形态**：Electron 桌面 harness，本地优先；数据根目录由 DSH_HOME 决定（默认 ~/.dsh）。

**存储布局**

```
~/.dsh/
├── storages/
│   ├── workspace.json                          # workspace 注册表（unit v2）
│   └── session_projcache/sessions/<id>.json    # 会话状态缓存（version 7）
└── sessions/
    └── --<workspace 路径转义>--/
        └── session-<uuid>/
            ├── session.v4.jsonl.zstd           # 会话正文（zstd 多帧拼接的 JSONL）
            └── session.lock
```

workspace 目录名转义（projectKey，见 [dsh-spec](./dsh-spec.md)）：
/、\\、: 的连续段折叠成一个 -，开头 - 去掉；[A-Za-z0-9._-] 原样保留；其他字符按 UTF-16 code unit 转 ~XXXX；结果用 -- 前后包起来。
例如 /Users/lyaqanyi/Documents/GitHub/sessionport → --Users-lyaqanyi-Documents-GitHub-sessionport--。
注意：路径里的点号保留（N.E.K.O.HarmonyOS 原样），大小写保留。

workspace.json 结构（节选）：

```json
{"unit":{"name":"workspace","version":2},
 "global":{"initialized":true,"defaultWorkspaceId":"...","workspaceIds":[...],"archivedSessionIds":[],"pinnedSessionIds":[]},
 "tables":{"workspaces":{"<id>":{"path":"/abs/path","title":"...","sessionIds":["session-<uuid>", ...],
                                "createdAt":"ISO","updatedAt":"ISO"}}}}
```

**会话文件：zstd 多帧**

session.v4.jsonl.zstd 是**多个 zstd 帧首尾相接**（魔数 0x28 0xB5 0x2F 0xFD）；只解第一帧会得到 224 字节而文件有 912KB。
读取方式：扫描魔数切分 → 逐帧解压 → 拼接 → 按行 JSON.parse。Node 24 自带 zlib.zstdDecompressSync / zstdCompressSync。

**行格式（formatVersion 4）**

首行：

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":<epoch ms>,"cwd":"/abs/path",
 "isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

其后每行一个事件：

```json
{"type":"<event>","seq":<int>,"time":<epoch ms>,"data":{...}}
```

一个 1000 行的真实会话里出现的事件类型（按频次）：tool/ptc-dispatch-start、tool/ptc-dispatch、
step/start、assistant/message、tool/call、step/end、tool/result、job/registered、job/settled、
user/message、agent/inbox/spliced、assistant/attempt、todo/write、team/task、model/selection、
turn/start、session/title、team/member、session、permission/preset、sandbox/mode、approval/policy、
agent-preset/selected、system/message、request/header、request/context、session/title-llm-request、
subagent/catalog、llm/retry、llm/retry-started、workspace/changes、turn/end。

关键事件的 data（实测）：user/message 带 content[] / source{kind,rpcId,clientTimeZone} / role / id；
assistant/message 带 content[] 与模型信息；tool/call 与 tool/result 以 callId（call_...）配对；
turn/start|end 标记回合边界；session/title 记录标题。

**headless**：asar 内含 @deepseek-ai/dsh-headless 与 dsh-headless profile（profiles/headless/），
理论上可用隔离的 DSH_HOME 启动并加载会话；当前会话所在实例不可中断，所有验证都在隔离 HOME 下进行。

## 3. 对 IR 的提示

1. 两家都是「事件/消息 + 链式 parent」，与 IR v0.1 天然对齐；Command Code 用 parentId，DSH 用顺序 seq。
2. DSH 的 tool/ptc-dispatch 是「一次工具调用内部派发多次子调用」的结构（ptc = programmatic tool calling），
   IR 需要用 callId + 父子关系表达，或先折叠成普通 tool_call 并记损失。
3. DSH 的 agent/inbox/spliced 是运行时注入的消息（含用户消息重放），与 user/message 有重复，读端要按 id 去重。
4. 时间戳：Command Code 用 ISO 8601；DSH 用 epoch 毫秒（createdAt/time）。IR 统一 ISO。
5. 注册信息：Command Code 的 thread-index.db 与 DSH 的 workspace.json + projcache 都是「索引层」，
   由 app 负责重建还是必须手写，见 adapter 交付报告。
## 4. 注册层结论（实测）

- **DSH**：`workspace.json` 与 `session_projcache` 都**不需要手写** —— 启动时 `dsh-workspace.bootstrap` 会扫描
  `sessionPersistence.list()` 的 header 自动建/补 workspace 记录，projcache 是投影缓存、缺省时回放重建。
  adapter 默认不写二者（可选 `registerWorkspace`）。
- **Command Code**：resume 只需要 transcript 本身（`--session <path>` 接受任意路径）；`.meta.json` 可省。
  只有要出现在 app 的 /resume 列表时才需要写 `~/.commandcode/projects/<slug>/` 与 `thread-index.db`。
- **Command Code 的一个隐性必需字段**：`message.meta.messageId` —— CLI 的 recorder 用它去重，
  缺了会导致每次 resume 把旧消息重复 append（文件膨胀）。

## 5. 无头 resume 通道（两家都有）

- Command Code：`node <app>/.../command-code/dist/index.mjs -p --session <jsonl> --output-format json -t --skip-onboarding --yolo "..."`
- DSH：`ELECTRON_RUN_AS_NODE=1 DSH_HOME=<iso> "<app>/Contents/MacOS/DeepSeek Harness" --expose-internals "<app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" headless --json --session-id <id> "..."`
  （隔离 DSH_HOME 下实测：能加载 → 启动 turn → 用 mock Messages API 抓到完整上下文回放）
