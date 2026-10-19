<!-- 由 opencode spike 产出，2026-10-19。证据目录 .spikes/opencode-resume/（gitignored）。 -->

# opencode 1.19.3 — import/export 契约与 headless resume（spike）

> 调研日期：2026-10-19，macOS arm64，opencode 1.19.3（~/.opencode/bin/opencode）。
> 标签：[实测] 本 spike 实测；[源码] 从二进制内嵌 JS bundle 提取；[实测-Lead] Lead 独立实测；[推测] 推断；[未验证] 未测。
> 真实数据目录 ~/.local/share/opencode 全程只读（只做过 cp / sqlite 只读查询）；所有写操作都落在 /tmp 隔离目录。

## 0. 结论速览（回答 5 个问题）

1. **最小 import JSON** = { info, messages[] }，二者都必须存在（messages 可为空数组 []）。
   - session.info 必需：id(以 "ses" 开头)、slug、title、version(任意非空字符串，可为 "")、time.created/updated(>=0 数字)、model.id + model.providerID（model 整体可省略）。
   - message.info 必需：id("msg" 前缀)、role("user"|"assistant")、sessionID、time.created；user 另需 agent、model{providerID,modelID}；assistant 另需 parentID、mode、agent、path{cwd,root}、cost、tokens{input,output,reasoning,cache{read,write}}、modelID、providerID、time.completed（finish 可省）。
   - part(text) 必需：id("prt" 前缀)、type、text、sessionID、messageID（time 可省）；reasoning 必需 time；tool 必需 tool、callID、state{status,input,output,title,metadata,time{start,end}}。
   - 未知/多余字段被忽略（不报错）；id 只校验前缀（"ses"/"msg"/"prt"），前缀之后的格式自由、长度不限。[实测] evidence/probe-min/、evidence/probe2/
2. **import 行为** [实测] + [源码]：
   - 只写旧模型三张表 session / message / part（+ project 行）；不写 session_v2 / session_message。
   - session 用 upsert：已存在同 id 时**只更新 project_id / directory / path**；title、slug、version、model 等保持原值。message / part 用 ON CONFLICT DO NOTHING（同 id 静默去重，不报错、不覆盖）。
   - **import 强制覆盖 info.projectID / info.directory / info.path**：取当前进程的 project（cwd 所在项目）与 cwd（源码：{...E.info, projectID:u.project.id, directory:u.directory, path:relative(worktree,directory)}）。所以必须 cd 到目标目录再 import。
   - 会话行先写入、再逐条校验 message/part；中途校验失败会留下已写入的 session 行（部分写入），重试前建议换新库或换 id。
   - 重复导入同文件：幂等（行数不增）；追加新消息再导入：新消息/part 写入，session 的 title 等不更新。
   - 非 git 目录 → projectID="global"、project 行 worktree="/"、session.path = cwd 相对 "/"；git 仓库 → projectID = 仓库路径哈希、project 行 worktree=仓库根、session.path 相对 worktree（仓库根时为空串）。
3. **resume**：可行，但有三个前提 [实测-Lead][实测(部分)]：
   - 必须**复制真实 opencode.db**（空库 + 只复制 auth.json 时 provider 凭证校验失败：AI_APICallError: Upstream request failed: Invalid credential）——provider/账户状态在 DB 的 credential/account 表里。
   - 必须显式 **-m provider/model**（导入会话的源模型在目标端可能不存在）；Lead 用 opencode-go/glm-5.2 实测 run --session 返回 RESUME_OK，回放约 65,875 tokens。
   - 我的 canary（空库）证明：import 成功、run 找到会话并**把新一轮消息 append 回同一会话**（message 2→4），只是模型调用因凭证失败。canary 的“模型能否基于导入历史回答”由 Lead 的 RESUME_OK 实测覆盖（同机制）。
4. **隔离 recipe**：OPENCODE_DB + XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_STATE_HOME 四件套 + 复制 auth.json + 用 sqlite3 .backup 复制真实库。见第 6 节，可直接跑 verify.sh。
5. **schema 版本**：1.19.3 的 import/export/session list/run 全部走**旧模型**（session/message/part）；真实库里同时存在的 session_v2/session_message 是 opencode 2.0.x 的数据，1.19.3 完全看不见（session list 不列、export 报 Session not found）。未来 opencode 2.x 需另做适配（未验证）。
6. **ID**：session 必须 "ses" 开头、message "msg"、part "prt"（只校验前缀，自定义后缀可接受）；version 字段 import 不校验内容（"local"/""/"9.9.9" 都可，原样入库）。

## 1. 导出 JSON 形状（import 的输入）

[实测] 真实样本 evidence/oc-export.json；结构与 research/opencode-format.md 一致：

~~~json
{
  "info": { "id": "ses_...", "slug": "...", "projectID": "global", "directory": "/abs/path",
            "path": "...", "title": "...", "agent": "build",
            "model": { "id": "...", "providerID": "...", "variant": "default" },
            "version": "1.18.33", "summary": {...}, "cost": 0.0015,
            "tokens": {"input":4,"output":996,"reasoning":1787,"cache":{"read":13501,"write":514}},
            "time": { "created": <epoch ms>, "updated": <epoch ms> } },
  "messages": [ { "info": { "id": "msg_...", "role": "user|assistant", "sessionID": "ses_...", ... },
                  "parts": [ { "id": "prt_...", "type": "text|reasoning|tool|step-start|step-finish|file", ... } ] } ]
}
~~~

DB 侧：message.data 存的是 info 去掉 id/sessionID 后的对象；part.data 存 part 去掉 id/sessionID/messageID 后的对象。[实测 evidence/import-db-rows.json]

## 2. import 字段契约（逐字段实测）

测试方法：从真实 export 裁剪出 1 user + 1 assistant（text part）最小会话语料，逐字段删除后各用全新隔离库跑一次 import，记录 Missing key at [...]。[实测 evidence/probe-min/probe-min.log + probe-min-results.json]

### session.info

| 字段 | 必需 | 备注 |
|---|---|---|
| id | 是 | 必须以 "ses" 开头；"sesumba"/"ses_"/"ses_123" 都可（只校验前缀） |
| slug | 是 | 任意字符串 |
| title | 是 | 任意字符串 |
| version | 是 | 任意字符串（空串也可），原样入库 |
| time.created / time.updated | 是 | 数字且 >= 0（-1 报 Expected a value greater than or equal to 0；字符串报 Expected number） |
| model.id / model.providerID | 是（若给 model） | 整体省略 model 也能 import |
| projectID / directory / path | 否 | **import 时被强制覆盖**（见 3.2） |
| agent / summary / cost / tokens / model.variant | 否 | 省略不报错 |

### message.info

| 字段 | user | assistant | 备注 |
|---|---|---|---|
| id | 必需 | 必需 | "msg" 前缀 |
| role | 必需 | 必需 | user / assistant |
| sessionID | 必需 | 必需 | 与父 session 一致 |
| time.created | 必需 | 必需 | 数字 |
| time.completed | - | 必需 | 数字 |
| agent | 必需 | 必需 | 如 "build" |
| model | 必需 | - | {providerID, modelID} |
| parentID | - | 必需 | 指向前一条 user msg id |
| mode | - | 必需 | 如 "build" |
| path | - | 必需 | {cwd, root} |
| cost | - | 必需 | 数字（0 可） |
| tokens | - | 必需 | {input,output,reasoning,cache{read,write}} |
| modelID / providerID | - | 必需 | 当前模型字符串 |
| finish | - | 可选 | "stop" 可省 |

注：Lead 的样本里 message.info 缺 parentID/mode/path/time/tokens/cost/finish 均报 Missing key；本 spike 的 assistant 分支实测 finish 可省、user 分支不需要 parentID/mode/path。两者不冲突——schema 按 role 分支，且只报第一个缺失字段。以本表为准；如遇更严样本再补。（另：message 缺 parts 键不是 schema 报错，而是 import 内部遍历 h.parts 抛 TypeError，报 Unexpected error 无字段路径；parts: [] 合法。）

### part

| 类型 | 必需字段（除 id/sessionID/messageID 外） | 备注 |
|---|---|---|
| text | type、text | time 可省；assistant text 常带 time{start,end} |
| reasoning | type、text、time{start,end} | 缺 time 报 Missing key at ["time"] |
| tool | type、tool、callID、state{status,input,output,title,metadata,time{start,end}} | state.time 必填；completed 的 output 可以是 string 或 {text,attachments} |
| step-start | type | 可省（adapter 跳过） |
| step-finish | type | reason/tokens/cost 可省，实测最小只有 type+id 即可 |
| file | type、mime、url（样本含 filename/source） | 最小集未逐一验证 [未验证] |
## 3. import 行为细节

3.1 写入哪些行 [实测 + 源码]
- project 行（若不存在，按 cwd 项目创建；非 git 目录为 id="global"、worktree="/"）
- session 行（id 冲突时 onConflictDoUpdate，仅更新 project_id/directory/path）
- message / part 行（ON CONFLICT DO NOTHING）
- 不写 session_v2 / session_message（后者在 1.19.3 新库里存在但 import 不用）

evidence：evidence/import-db-rows.json（session/message/part/project 全字段 dump）

3.2 directory 强制覆盖 [实测 + 源码]
import 源码（二进制内嵌 JS）：decode({...E.info, projectID:u.project.id, directory:u.directory, path:relative(resolve(u.worktree),u.directory)})。
实测：同一 JSON 在 /tmp/.../workA 导入后 directory=/private/tmp/.../workA，在 workB 重导入后 directory 变为 workB（同 session id 被 upsert 覆盖）。macOS 注意 /tmp → /private/tmp（process.cwd 给真实路径）。
影响：adapter 必须先 cd（或 run --dir）到目标项目目录再 import；跨项目搬运时 session 会“落”在导入目录。

3.3 幂等 / 重复导入 [实测]
- 同一文件导两次：session/message/part 行数不变（1/2/2）。
- 追加消息后再导：新 message/part 增加（3/3），session title/slug/version 不更新（只有 project_id/directory/path 被 upsert）。
- 失败导入：session 行已写入（校验逐条进行），message/part 可能部分写入 → 重试建议用新 id 或新库。

3.4 其它 [实测]
- 未知字段（session.info / message.info / part 上）被忽略。
- 顶层 messages 缺失 → 报错（Unexpected error，无字段）；messages: [] → 成功导入空会话。
- 以 "http(s)://" 开头的文件参数会被当作 share URL 拒绝（sharing 已停用）。
- import 结束打印 "Imported session: <id>"，成功 exit 0。

## 4. export 契约与管道截断坑

- export = { info, messages:[{info,parts}] }，JSON 缩进 2 空格；session 不存在时 stderr 打 "Session not found: <id>"，exit 1。[实测]
- **stdout 是管道时会被截断**：同一 1.25MB 会话，重定向到文件完整（1,252,168 bytes，51 msgs，JSON 可解析）；经管道（| cat）只剩 262,144 bytes，JSON 解析失败（Unterminated string）。[实测 evidence/export-pipe-truncation.txt；Lead 另测到 65,536 字节截断，与缓冲/消费速度有关]
  → adapter 必须把子进程 stdout 直接接到临时文件 fd（或 shell 重定向 >），不要用 pipe 读 JSON。
- --sanitize 可脱敏（未用）；--pure 跳过外部插件（建议 adapter 始终加 --pure）。

## 5. resume（headless 续聊）

命令：opencode run --session <id> --format json -m <provider/model> "<prompt>"
- [实测-Lead] 导入 Kimi 会话（11 消息 / 60 part）后，用 opencode-go/glm-5.2 得到 RESUME_OK，回放 tokens.total≈65,875（cache.read≈64,388）→ 历史确实进入模型上下文，且 run 把新一轮 append 回原会话。
- [实测(本 spike)] 空隔离库 + 复制 auth.json + free 模型 longcat-2.5-preview-free：import OK；run 找到会话并写入 2 条新 message（2→4），但模型调用 3 次重试均 AI_APICallError: Invalid credential（evidence/resume-attempt/）→ resume 机制本身可用，凭证/账户状态需要真实库。
- [源码] run --session：先 session.get({sessionID})，不存在则 "Session not found" exit 1；否则 session.prompt 追加。本地模式 server instance 的 directory = cwd（或 --dir），与导入时 cwd 一致最稳。
- [实测] 不存在的 session：立即 "Session not found"，无模型调用。
- 建议 adapter：import 与 run 使用同一 cwd；显式 -m；--format json 逐行解析；检测到 {"type":"error"} 判失败。

## 6. 隔离 recipe（可复现，真实库只读）

~~~bash
ROOT=$(mktemp -d /tmp/oc-isolate.XXXXXX)
mkdir -p "$ROOT"/{xdg-data/opencode,xdg-config,xdg-cache,xdg-state,work}
cp -p ~/.local/share/opencode/auth.json "$ROOT"/xdg-data/opencode/auth.json && chmod 600 "$ROOT"/xdg-data/opencode/auth.json
# provider/账户状态在 DB 里：用 sqlite3 online backup 复制真实库（对源库只读）
sqlite3 ~/.local/share/opencode/opencode.db ".backup '$ROOT/oc.db'"
export XDG_DATA_HOME="$ROOT/xdg-data" XDG_CONFIG_HOME="$ROOT/xdg-config" \
       XDG_CACHE_HOME="$ROOT/xdg-cache" XDG_STATE_HOME="$ROOT/xdg-state" \
       OPENCODE_DB="$ROOT/oc.db"
cd "$ROOT/work"
opencode import session.json
opencode run --session <id> --format json -m opencode-go/glm-5.2 "Reply with exactly: RESUME_OK"
~~~

- [实测] OPENCODE_DB 生效（opencode db path 返回该路径）；XDG_DATA_HOME 决定 auth/log/repos；XDG_CONFIG_HOME 决定 config；XDG_STATE_HOME 决定 ~/.local/state/opencode（不设会写真实 state）。
- [实测] OPENCODE_CONFIG_DIR 在 1.19.3 中未见生效（debug paths 仍显示 XDG config）；用 XDG_CONFIG_HOME 即可。
- [实测] 空库问题：只复制 auth.json 时 provider 校验失败（Invalid credential）；复制真实库后 Lead 的 resume 成功。
- 注意：sqlite3 .backup 对源库是只读读操作；本 spike 未对真实库执行任何写。
## 7. schema / 版本结论

[实测]
- 1.19.3 新建空库（opencode db path 触发 migration）只有旧模型表：session / message / part / project / workspace / todo / permission / account / credential / event / session_message（FK 指向 session）等，**没有 session_v2**。evidence/iso-1.19.3-fresh-schema.sql
- 真实库是混合库：旧表 session(19 行，version 1.14.28/1.18.21/1.18.33/local) + message(132) + part(644)，以及 2.0.x 的 session_v2(2 行，version 2.0.29/2.0.30) + session_message(13 行，事件式 model-switched/user/assistant)。evidence/real-db-probe/、real-db-schema.sql
- 1.19.3 对 session_v2 完全不可见：opencode session list 不列出 2.0.x 会话；opencode export <session_v2 id> → "Session not found"。→ import/export/run 只操作旧模型。
- 未来 opencode 2.x（session_v2 / 事件式 session_message / part 存于 session_message）需要单独适配；1.19.3 与 2.0.x 不互通。[未验证 2.x 的 import/export 是否存在/格式]

## 8. adapter 实现注意事项（坑清单）

1. 必须先 cd 到目标项目目录再 import（directory 被覆盖）；import 与 run 用同一 cwd。
2. import JSON 要按“比 export 更严”的 schema 补字段：assistant message 的 parentID/mode/path/time.completed/cost/tokens；tool part 的 state.title/metadata/time；reasoning 的 time。缺失报 Missing key at [...]，容易一个个踩。
3. message 必须带 parts 键（空数组也行），否则 import 内部 TypeError。
4. export 不要用 pipe 读：stdout 接临时文件 fd；文件解析完整。
5. run 必须显式 -m；且需要真实库副本（空库 → Invalid credential）。跑真模型前先用不存在的 session 做零成本自检。
6. id：只校验前缀。生成建议 "ses_"/"msg_"/"prt_" + 与真实 id 同形状（12 hex + 14 随机 base62）；同一会话内 id 必须唯一，重复导入被静默去重，可能导致新消息“消失”。
7. version 原样入库，可写来源端版本或 "1.19.3"；不影响 import。
8. step-start/step-finish 是流式占位，按 research 已定跳过；file part 建议记损失。
9. 失败导入会留下 session 行：adapter 重试前用新 id 或清临时库。
10. macOS /tmp → /private/tmp：比较目录字符串用 realpath/process.cwd，不要硬编码。

## 9. 未验证 / 待补

- [未验证] 本 spike 的“模型基于导入历史回答”canary 未在本会话内跑通（凭证问题）；该结论由 Lead 的 RESUME_OK 实测覆盖（同机制、同命令）。
- [未验证] tool part 的 state 各子字段最小集（只验证了缺失 state.time 会报错；title/metadata/input/output 的最小集来自 Lead 实测与 export 样本）。
- [未验证] file part 最小必需字段；compaction/subtask/snapshot/patch 等 part 类型的 import 契约。
- [未验证] opencode 2.x 的 import/export 行为与 session_v2 迁移路径。
- [未验证] import 对极大会话（>1.25MB export）的耗时/内存；export pipe 截断的确切阈值（实测 262144，Lead 实测 65536，与缓冲有关）。
- [未验证] 在 git 仓库内 import 后 resume 是否会在仓库里生成快照/其他文件（opencode snapshot 在 data dir，推测无）。

## 10. 证据索引（evidence/）

| 文件 | 内容 |
|---|---|
| oc-export.json | 真实 export 样本（2 消息） |
| probe-min.mjs / probe-min/ | 逐字段删除的 import 必需性探针 + 日志 + JSON 结果 |
| probe2.mjs / probe2/ | id 前缀、version、time、重复导入、cwd 覆盖、git project、part 类型探针 |
| import-db-rows.json | 一次成功 import 后的 session/message/part/project 行 dump |
| iso-1.19.3-fresh-schema.sql | 1.19.3 空库 schema（旧模型） |
| real-db-schema.sql / real-db-probe/ | 真实库 schema、各表行数、session_v2 与 session_message 证据 |
| export-pipe-truncation.txt | export 管道截断实测（file 1,252,168 B vs pipe 262,144 B） |
| resume-attempt/ | 空库 canary 尝试：import OK、Invalid credential 日志、run 后消息 append 行数 |

配套：gen.mjs（生成可 import 会话 JSON）、verify.sh（隔离 import → run → canary 无头验证）。
