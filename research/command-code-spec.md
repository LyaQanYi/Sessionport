<!-- 由 adapter spike 产出，2026-10-19。证据目录 .spikes/cc-verify/（gitignored）。 -->

# Command Code 会话格式与 resume 结论（1.82.3, 2026-10-19）

来源：
- 真实数据 ~/.commandcode（23 个会话 jsonl / 1888 行 / 24 个 checkpoints / 41 个 meta.json）
- CLI 源码 dist/cli.mjs（createSessionStoreV3 / isSessionEntryV3 / getProjectSessionDir /
  appendMessage / createSessionRecorder / loadExternalPrintSession / resolvePrintResumeState）
- 无头探针：.spikes/cc-verify/variants/*（真实模型调用 + --output-format json 的 nextState 回显）

## 目录结构

~/.commandcode/
  projects/<slug>/<uuid>.jsonl            会话 transcript（首行 session 头，其后 entry）
  projects/<slug>/<uuid>.meta.json        {entrypoint, title, traceIds, pullRequestBinding, model?}
  projects/<slug>/<uuid>.checkpoints.jsonl  /rewind 用，resume 不需要
  projects/<slug>/<uuid>.prompts.jsonl    ？未见样本
  history.jsonl                           {p,t} 提示词历史，resume 不需要
  auth.json / config.json / models-cache.json

slug 规则（源码 getProjectDirName = @sindresorhus/slugify 2.2.1 默认参数）：
  cwd -> transliterate -> decamelize -> lowercase -> [^a-z0-9]+ 折叠成 '-' -> 去首尾 '-'
  实测：7 个有 transcript 的项目目录 7/7 吻合，例如
    /Users/x/GitHub/NEKO                    -> users-x-git-hub-neko
    /Users/x/GitHub/N.E.K.O.Verse           -> users-x-git-hub-n-e-k-o-verse
    /Users/x/Coding/N.E.K.O.HarmonyOS       -> users-x-coding-n-e-k-o-harmony-os
    /Users/x/Coding/0TEST                   -> users-x-coding-0-test
    /Users/x/Coding/0neko-mobile            -> users-x-coding-0neko-mobile

## 行格式

session 头（首行，必需）：{type:'session',version:3,id,uuid,timestamp:ISO,cwd:/abs[,parentSession]}
entry 公共字段：{type, id:<8 hex>, parentId:null|<上一行 id>, timestamp:ISO}
entry.type 全集（源码 SESSION_ENTRY_TYPES）：message / model_change / effort_change / compaction /
  branch_summary / custom / custom_message / label / session_info
实测 23 个会话只出现：message(1864) / compaction(1)。

message entry：
  message.role: user | assistant
  message.content: block[]，实测四类：
    {type:'text',text}
    {type:'thinking',thinking,signature:''}      // signature 实测恒为空串
    {type:'tool_use',id,name,input}
    {type:'tool_result',tool_use_id,content:[{type:'text',text}]}  // content 是 block 数组
    源码另外支持 {type:'image',source:{type:'base64',media_type,data}}
  message.meta: {messageId:uuid, source:'user'|'model'|'tool', createdAt:epoch_ms, isMeta?, isSummary?}
  assistant 行额外顶层字段：usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costUsd}、model、effort

compaction entry：{summary, firstKeptEntryId, tokensBefore, stripThinkingFromKept?, fromMod?}
  语义：上下文从 firstKeptEntryId 开始，summary 作为 isSummary 的 user 消息注入。

## 最小可 resume 集（实测确认）

`cmd -p --session <工作区 .jsonl> --output-format json ... "Reply with exactly: RESUME_OK"` 全部返回
finalText=RESUME_OK / exit 0；用 run_end.nextState.messages 校验历史被真实加载：

| 变体 | 结果 |
| full（header+user+assistant，meta 齐全） | OK，历史 2 条全部加载 |
| no-meta（message 无 meta） | OK，但 resume 后旧消息被重复 append 回文件 |
| meta 只有 messageId+createdAt（无 source） | OK，不重复 |
| meta 只有 source（无 messageId） | OK，重复 append |
| thinking block（signature='' 或假签名） | OK（deepseek 与 claude-haiku-5-5 都通过） |
| tool_use+tool_result 配对（含claude风格 Bash 名字） | OK，历史原样加载 |
| image block（base64 png） | OK |
| header 缺 cwd | 不报错，但整份历史被丢弃（当新会话） |
| 只有 header、无消息 | 仍能回答，但新的一轮不会 append 回该外部文件 |
| parentId 断链 | 不报错，链断点之前的历史被静默丢弃 |
| 缺 tool_result | 加载不报错（provider 是否接受未测） |

结论：最小必需 = 合法 session 头（type/version=3/id/timestamp/cwd）+ 每行 entry 的
id/parentId/timestamp + message.role/content + parentId 线性链。meta.json 不是必需。
但 message.meta.messageId 是事实必需：createSessionRecorder 用它去重，缺了每次 resume 都会把
旧消息再 append 一遍（文件膨胀）。source/createdAt 建议写全。

## 写端 / 互传结论

- 写端产物：<home>/projects/<slug(cwd)>/<id>.jsonl + <id>.meta.json（entrypoint='interactive'）。
  home 默认 ~/.commandcode（opt.home 可覆盖，测试用临时目录）。
- `--session <任意存在的 .jsonl>` 被 CLI 支持（源码 resolveSessionRefFlag/loadExternalPrintSession），
  不需要落在 ~/.commandcode 下；resume 成功后新的一轮会 append 回该文件。
  实测：适配器生成的 transcript（合成 IR 和 Kimi 真实 bundle -> IR）都被 CLI resume 成功。
- 要让 `cmd -r <id>` / `cmd -c` 在真实项目里发现会话，文件必须落在真实 ~/.commandcode/projects/<slug>/；
  CLI 的 session runtime 强制 HOME=os.homedir()（不接受 home 环境变量覆盖）。本适配器已验证布局一致，
  但沙箱内无法写家目录，故 `-r`/`-c` 未做真实验证（--session 路径方式已闭环）。
- 写端损失清单：cross-agent-import / reasoning-opaque-dropped / tool-result-synthesized /
  orphan-tool-result / tool-error-flag-dropped / boundary-dropped / subagent-dropped /
  sidecars-not-written / source-undo / image-dropped / invalid-timestamp 等。

## 未验证 / 已知坑

- `cmd -r <id>`、`cmd -c` 真实验证（需要写 ~/.commandcode，沙箱拒绝）。
- 缺 tool_result 的 transcript 能否被 provider 接受（CLI 加载不报错；写端会合成占位）。
- 空会话（只有 header）不持久化新轮次到外部 session 路径（源码：resumeState 为空时不使用 sessionFilePath）。
- batch/多会话目录：同一项目目录多个 jsonl 时按 mtime 取最新（可传 sessionId 指定）。
- 非 Latin 脚本的 slug：transliterate 完整表未移植，西里尔/希腊等路径可能算错（本机样本全 ASCII）。
- compaction 之外的 custom/label/session_info 等 entry 类型只按 notice 记录，未做写回。

## 复跑

node --test packages/adapters/command-code/test/*.test.ts
SESSIONPORT_CC_RESUME=1 node --test packages/adapters/command-code/test/*.test.ts   # 含真实 resume


## CLI 集成（2026-10-19 实测，Lead 的 packages/cli）

- `sessionport inspect commandcode:<real.jsonl>` -> IR 摘要正常。
- `sessionport push commandcode:<real.jsonl> --to command-code --home <工作区> --cwd ... --id <uuid>` -> 写入 + 损失清单正常。
- `sessionport verify --agent command-code --file <生成的 jsonl>` -> 18 项全 PASS。
- `sessionport verify --agent command-code --file <生成的 jsonl> --resume` -> RESUME SMOKE: PASS（真实模型）。
- `sessionport verify --agent command-code --id <真实 uuid>` -> 按 id 在 ~/.commandcode 解析后全 PASS。
- 注：CLI 的 `packages/cli/node_modules/@sessionport/adapter-command-code` 链接与 package.json 依赖由 Lead 补齐；
  本 adapter 本身不依赖它。

## 附录：sessionport 实测补充（2026-10-19）

1. **超大历史会自动压缩**：把一份 424k token 的 DSH 会话导入后，`cmd -p --session <path>` 仍能 resume 成功；
   CLI 在重放前做了 compaction（返回体里可见 `compaction.tokens ≈ 18044`），实际请求只有约 1.8 万 token。
   因此不需要为「上下文上限」提前拒绝导入。
2. **resume 之后 app 自己追加的行会有悬空 parentId**：续写的 assistant 行 `parentId` 可能指向压缩前的记录 id
   （文件里已不存在）。这类文件仍可正常加载，但结构校验不能把「悬空」当断链——只把「首行 parentId 非 null /
   中间出现 null」算作真正断链。
3. **注入消息可以安全丢弃**：DSH 的 `user/message` 带 `source.kind`（`user` / `time-context` /
   `runtime-context` / `skill-catalog` / `subagent-settled` / `agent-message` / `user-approval`）。
   除 `user`、`agent-message`、`user-approval` 外都属于目标端会自行生成的运行时上下文，导入时默认丢弃
   （`--keep-injected` 可保留）。
