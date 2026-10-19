<!-- 由 adapter spike 产出，2026-10-19。证据目录 .spikes/dsh-verify/（gitignored）。 -->

# DSH adapter spike 报告（task-3）

日期：2026-10-19。证据目录：.spikes/dsh-verify/（gitignored）。
安装版本：DSH 桌面端 0.2.1-rc.2（~/.dsh/.workbuddy-app-version.json 里 app version 5.8.3），Node 24.15。

## 1. 文件格式（实测 + 反编译 app.asar 核对）
- 会话文件：$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd + session.lock（0 字节）。
- zstd 多帧容器：首帧必须恰好一行 session 头（官方 assertIndependentHeaderFrame），之后每帧是一次追加的若干 JSONL 行。
  直接 zstdDecompressSync 只解第一帧；本 adapter 的 scanZstdFrames 按官方算法逐帧切分，容忍末尾撕裂帧（ZSTD_e_flush 恢复完整行）。
- 头行字段：必需 type/version/id/createdAt(epoch ms)/isSeeded/delegationDepth；可选 cwd(绝对)/parentSession/origin('subagent')/agentPreset；
  禁止 retired 字段 sandboxMode/approvalPolicy。
- 目录名 projectKey(cwd)：'/'、'\'、':' 连续段折叠成一个 '-'，开头 '-' 去掉；[A-Za-z0-9._-] 原样；其他字符（空格/~/中文）按 UTF-16 code unit 转 ~XXXX；
  前后包 '--'，最长 251；空路径 -> root。例：/Users/me/A B/C -> --Users-me-A~0020B-C--
- sessionId 作为目录段同样转义（encodeSegment）。GUI 根会话 id 为 session-<uuid>；子代理会话是裸 uuid + header.parentSession + delegationDepth=1 + origin=subagent。
- 根会话 header 不写 agentPreset：headless one-shot runner 拒绝加载 agentPreset='standard'（实测报错），只有 GUI 会话才写 standard。
- 正文事件：user/message、assistant/message、tool/result、system/message 属于 surface，必须带 surfaceOp:'append'；
  assistant/message 的 data.message.content 支持 text/reasoning/tool-call 块，data.stream 必须能组装回 content（BlockAssembler）；
  tool/call 事件是 assistant content 里 tool-call 块的执行回显（arguments 是字符串）；tool/result 配对键是 message.toolCallId + source.callId。
- 非对话事件（step/turn/request/assistant-attempt/job/ptc-dispatch/team/todo/...）不进入模型上下文，读端按类型计数进 notices。

## 2. 读端（readDshSession）
输入：目录 | 日志文件 | session id（支持裸 uuid 自动补 session- 前缀，扫 $DSH_HOME/sessions/*）。
映射：user/message -> message(role=user, source.kind!=='user' 标记 synthetic)；assistant/message 拆成 reasoning / message(text) / tool_call；
tool/result -> tool_result；session/title -> meta.title；model/selection -> meta.model；compaction/start -> boundary compact；feedback/message-delete -> boundary undo。
反查 header.parentSession 把子代理会话填入 children（label 取父会话 subagent/catalog 或子会话 descriptor）。
实测：本机 11 个真实会话全部可读；当前会话 374 events + 3 个 child（team 成员）。

## 3. 写端（writeDshSession）
IR 事件流按“一个 step 最多一条 assistant/message”切分；turn=1 包住所有 step。
输出头行 + step/start + 空 system/message(surface node 0) + user/message + assistant/message(含 reasoning/text/tool-call + 可组装 stream) +
tool/call + tool/result + step/end + turn/end + session/title。缺结果的 tool_call 自动补占位 result；孤立 result 丢弃。
不写 projcache（官方会在 restore/定期 checkpoint 时重建；隔离 headless 加载我们的文件后自动生成）；workspace.json 可选（registerWorkspace，默认 false）。
依据：官方 dsh-workspace.bootstrap 在启动时扫描 sessionPersistence.list() 的 header，按 cwd 自动重建 workspace 记录/sessionIds；
projcache 仅是 projection 缓存，缺省时回放事件重建（app.asar: dsh-workspace/lib/index.js bootstrap、dsh-session-projection-cache/lib/index.js）。

## 4. 验证结论：resume 真的跑通（不是“无法无头”）
DSH 安装包自带 headless profile（此前被漏掉）。隔离 DSH_HOME 下两条实测通道：
1) 只证明“应用加载并接管我们写的会话”（无需 API key）：
   ELECTRON_RUN_AS_NODE=1 DSH_HOME=<isolated> '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
     --expose-internals '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js' \
     headless --json --session-id <id> 'continue'
   实测 stdout: {"type":"session",...}、"turn_start"、随后 MISSING_CREDENTIAL；会话文件被应用追加 session/end-seed、turn/start(turn=2) 等事件。
2) 完整 resume turn（用本地 mock Messages API，不需要真 key）：
   DEEPSEEK_BASE_URL=http://127.0.0.1:<mock> DEEPSEEK_API_KEY=sk-mock + 上面同样命令。
   实测：应用回放源会话 -> 发起 POST /v1/messages（捕获 body 里 6 条消息，含 reasoning/thinking、tool_use(call_mock_1)、配对的 tool_result、
   全部 canary 文本）-> 应用返回 turn completed、stdout 输出 mock 回复、把新 assistant/message 追加回我们的 session.v4.jsonl.zstd。
   之后 verifyDshSession 仍 ok（30 events / 19 frames）。
   adapter 已导出 resumeSmokeDsh({home,sessionId,...}) 供 CLI --resume 分支直接接（CLI 现在对 dsh 还打印“暂无无头通道”，可改）。

## 5. 未验证 / 已知坑
- 未用真实模型 key 跑过 resume（本机无 DEEPSEEK_API_KEY）；未在真实 ~/.dsh（用户正在跑的 GUI）里导入过（不能写家目录）。
  导入真实环境步骤：把写出的 session 目录复制到 ~/.dsh/sessions/<同 projectKey 目录>/ 下，重启 DSH（workspace 启动时自动认领），
  在 GUI 会话列表打开；或直接 dsh headless --session-id <id> 验证加载。
- projcache 未主动写；workspace.json 注册是可选辅助，重启后官方 bootstrap 会重建（实测当前 workspace.json 里新会话也未登记，说明不是必需）。
- includeChildren=true 会写子代理会话文件，但未做端到端 resume 验证；默认 false 并记 loss。
- image / 非 text 工具结果、opaque reasoning 是显式损失；model/selection 默认不写（目标端用自身默认模型）。
- 跨 agent 导入时 assistant source.provider 写 'sessionport'（仅归因字段，不影响请求）；system prompt 用空 system/message 占位，
  DSH 下一次请求会以 in-history 方式把自身 system prompt 追加在历史之后（mock 请求实测 #5 system），这是 DSH 的原生行为。
- CLI 集成：packages/cli/node_modules/@sessionport 还没有 adapter-dsh / adapter-command-code 的 workspace link（只有 claude-code、kimi-code），
  因此 node packages/cli/src/index.ts 调用会报 Cannot find package。需要 Lead 跑一次 workspace link（不要 pnpm install 的话，symlink 两个包即可）。
