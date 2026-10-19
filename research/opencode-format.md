# opencode 1.19.3 会话格式、import/export 与 headless resume

> 调查日期：2026-10-19，macOS，本机实测（opencode 1.19.3）。只记结构，不含消息正文。

## 1. 存储与 CLI

```
~/.local/share/opencode/
├── opencode.db          # 主库（Drizzle；旧模型 session/message/part + 新模型 session_v2/session_message）
├── auth.json            # provider 凭证
├── log/  snapshot/  storage/  repos/
```

关键命令（都可 headless）：

```bash
opencode export <sessionID> --pure        # 导出会话 JSON
opencode import <file>                    # 从 JSON 导入
opencode run --session <id> --format json "<prompt>"   # 无头续聊
opencode db path / opencode db "<sql>" --format json   # 直接查库
```

环境变量隔离：`OPENCODE_DB`（数据库路径）实测有效；另有 `OPENCODE_CONFIG_DIR`、`XDG_*` 系列。

## 2. 导出 JSON 形状

```json
{
  "info": { "id": "ses_…", "slug": "…", "projectID": "global", "directory": "/abs/path",
            "path": "abs/path", "title": "…", "agent": "build",
            "model": { "id": "…", "providerID": "…", "variant": "default" },
            "version": "1.18.33", "summary": {...}, "cost": 0.0, "tokens": {...},
            "time": { "created": <epoch ms>, "updated": <epoch ms> } },
  "messages": [ { "info": {...}, "parts": [ { "type": "text|reasoning|tool|step-start|step-finish|file", ... } ] } ]
}
```

- `message.info`（user）：role、time{created}、agent、model、summary{diffs}、id、sessionID
- `message.info`（assistant）：parentID、role、mode、agent、path{cwd,root}、cost、tokens、time{created,completed}、finish、id、sessionID
- `part`：text（type/text/time）、reasoning（type/text/time/metadata.signature）、tool（type/tool/callID/state）、step-*（流式占位）、file（附件）
- `tool.state`：`{ status: running|completed|error, input, output, metadata, title, time{start,end} }`

## 3. import 契约（比 export 更严格，实测）

`opencode import` 用内部 schema 校验，**导出里可省的字段 import 不一定接受**。实测缺一不可：

| 位置 | 必需字段 | 缺失报错 |
|---|---|---|
| message.info | `parentID`（首条可为 null） | `Missing key at ["parentID"]` |
| message.info | `mode`（如 `"build"`） | `Missing key at ["mode"]` |
| message.info | `path`（`{cwd, root}`） | `Missing key at ["path"]` |
| message.info | `time`（created/completed）、`tokens`、`cost`、`finish` | `Missing key at ["time"]` 等 |
| part（text/reasoning） | `time: { start, end }` | `Missing key at ["time"]` |
| part（tool） | `state.title`、`state.metadata`、`state.time`、`state.input`、`state.output`、`state.status` | `Missing key at ["state"]["title"]` |

导入成功后 `session`/`message`/`part` 三张旧表各有对应行；`opencode export` 能原样导回（实测 11 消息 / 60 part）。
重复导入同一 id 的行为未测（adapter 默认生成新 id）。

## 4. 一个必须绕开的坑：export 在管道下截断 64KB

`opencode export` 的 stdout 如果是**管道**，输出会被截断：Lead 实测 65,536 字节，spike 实测 262,144 字节
（取决于管道缓冲）。JSON 直接解析失败（`Unterminated string in JSON`），重定向到文件则完整（实测 1.25MB / 51 条消息可解析）。
adapter 的做法：把子进程 stdout 直接接到临时文件描述符，再读回文件。

## 5. headless resume（实测）

```bash
OPENCODE_DB=<库> opencode run --session <id> --format json -m opencode-go/glm-5.2 "Reply with exactly: RESUME_OK"
# → {"type":"text", ... "text":"RESUME_OK"} → step_finish，tokens.total≈65,875（其中 cache.read≈64,388）
```

- **必须显式 `-m`**：导入会话的源模型（如 `kimi-code/kimi-for-coding`）在目标端不存在或协议不匹配；
  用 `opencode models` 挑本机可用模型（本机 `opencode-go/glm-5.2` 实测可用，免费 zen 模型对 CLI 有限制）
- **隔离要复制真实库**：provider 凭证/账户状态在库的 credential/account 表里，`OPENCODE_DB` 指向空库时模型调用会 401；
  复制 `opencode.db`（`sqlite3 .backup`）到临时路径再导入是当前做法（真实库不动）。
  注意：**复制库不是永久解法**——实测 16:47 用同一份副本还能 RESUME_OK，16:50 之后连真实库副本也全部 401，
  属于 provider 凭证失效（外部原因），与契约无关
- `run --session` 会基于库里的历史回放，并把新一轮写回同一会话（append）

## 6. 与 IR 的映射

- user message → `message(user)`；assistant message 的 parts 依次映射 text→message、reasoning→reasoning、tool→tool_call + tool_result（state 里同时含 input/output）
- `step-start`/`step-finish` 跳过（流式占位）；`file` 暂不映射（记损失）
- 导出侧：一个 IR 事件流会被聚合成「user 消息 + assistant 消息（多条 part）」；工具调用与结果折叠成一个 `tool` part
- 子代理：opencode 用 session 上的 `agent` 列表示，没有独立会话；跨端导入时作为普通工具调用保留（记损失）
- 新模型 `session_v2`/`session_message` 存在于同一库，但 1.19.3 的 import/export 仍走旧表（实测）；未来 2.x 再适配
## 7. import 行为细节（spike 实测补充）

- **import 会用当前进程的项目和 cwd 覆盖 `info.projectID/directory/path`** —— 所以调用前必须 `cd` 到会话的 cwd；
  adapter 已把 import 子进程的 cwd 固定为会话 cwd。
- session 用 upsert（同 id 只更新 project/directory/path，title/slug/version/model 保持原值）；
  message / part 用 `ON CONFLICT DO NOTHING` —— 同 id 静默去重、不覆盖。
- 校验是「先写 session 行，再逐条校验 message/part」，中途失败会留下部分写入；重试建议换新 id 或新库。
- `session.id` 只校验 `ses` 前缀、`message.id` 只校验 `msg`、`part.id` 只校验 `prt`（后缀自由）；
  `session.version` 任意非空字符串。
- **旧表 vs v2**：1.19.3 的 import/export/list/run 全部走旧模型三张表；
  真实库里的 `session_v2`/`session_message`（opencode 2.0.x 写的）对 1.19.3 不可见（export 报 Session not found）。
- 隔离 recipe（可复现）：`OPENCODE_DB` + `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` 四件套 +
  复制 `auth.json` + `sqlite3 .backup` 复制真实库；只给空库会因 credential/account 表为空导致 provider 401。

> 完整逐字段契约见 [opencode-spec.md](./opencode-spec.md)。