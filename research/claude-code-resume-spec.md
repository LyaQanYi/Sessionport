# Claude Code 2.1.303 会话文件 SPEC（最小可 resume 集）

> 来源：`.spikes/claude-resume/` 的 spike 产物，2026-10-19。证据文件（probes / real-* / requests / source-notes）
> 保留在本地 `.spikes/`（已 gitignore，含会话内容不入库）。本文是 adapter 实现的依据。
> 结论标注约定：**实测确认** / **源码确认**（从 2.1.303 bundle 提取函数）/ **推测** / **未验证**。

> 目标：回答「让 `claude --resume <uuid>` 成功加载并继续对话，会话 JSONL 的最小行集合是什么」，供 sessionport 的 claude-code adapter `writeSession` 直接实现。
> 验证对象：claude 2.1.303（macOS arm64，`/Users/example/.local/share/claude/versions/2.1.303`），隔离 `CLAUDE_CONFIG_DIR=.spikes/claude-resume/home`。
> 证据目录：`.spikes/claude-resume/evidence/`。标注约定：**实测确认** = 无头 resume 实测；**源码确认** = 从 2.1.303 自带 bundle 中读出对应代码；**推测** = 未直接验证的推断；**未验证** = 明确没测出来。

---

## 0. 五问五答（先看这里）

**Q1. 最小可 resume 的行集合？timestamp 缺失为什么 "No conversation found"？**

- **单行即可 resume（实测确认）**：`{"type":"user","message":{"role":"user","content":"..."},"timestamp":"2026-10-19T05:00:00.000Z"}`，文件名 `<uuid>.jsonl`，放在 `$CLAUDE_CONFIG_DIR/projects/<任意一层目录>/` 下。实测：仅这一行 + `--resume <uuid>`，真实模型基于这行内容回答了历史里的 secret（evidence/real2-absmin_single_user.json）。
- **推荐最小集（多轮对话）**：每行 `type` + `message` + `uuid` + `parentUuid` + `timestamp`；首行 `parentUuid:null`，其后每行 `parentUuid = 上一行 uuid`。这是能完整回放多轮上下文的实测最小集（evidence/probes-final-.json → final_abs_min_two_records；真实 API evidence/real2-absmin_chain.json）。
- **timestamp 是致命的（实测确认）**：resume 的 leaf 记录必须带 Date.parse() 可解析的 timestamp；缺失/null/数字/非法字符串 → 直接 `No conversation found with session ID`（exit 1）。**只有 leaf（文件里最后一条 user/assistant）的 timestamp 必须合法**；非 leaf 记录 timestamp 非法不影响加载（evidence/probes-final-.json、evidence/errors/errors.txt 的 C 例）。
- 原因（**源码确认**，从 bundle 提取的函数 `$Et` / `zL` / `s7s`）：加载器先确定 leaf 候选（有 `last-prompt` 时看其 `leafUuid`，否则取文件里最后一条非 sidechain 记录），再在候选集合里用 `Date.parse(record.timestamp)` 取最大值；leaf 的 timestamp 不可解析时选不出 leaf → loader 返回 null → 外层报 "No conversation found"。空文件、只有 metadata 行、文件不在 `projects/` 下、文件名不是 UUID 也会走同一个报错（evidence/errors/errors.txt）。

**Q2. thinking 块：无 signature / 假 signature / 空 signature 分别怎样？跨源导出安全做法？**

- 三种情况 **都不会导致加载失败**（实测确认，mock 侧抓包 + 真实 API 都跑通：evidence/probes-ts-chain-tool-think-loc-order-odr-field-.json、evidence/real-thinking_*.json）。
- **无 signature**：记录保留，thinking 块原样进入下一轮 API 请求（mock 抓包 `thinking(len=29,sigLen=none)`）。
- **空 signature `""`**：等价于无 signature（空串被静默丢弃，抓包 sigLen=none）。
- **假/自定义 signature**：原样保留并原样发给 API（抓包 sigLen=20）。**非最后一条 assistant 的历史 thinking 会被 Claude Code 在 replay 前剥掉**；但 **最后一条 assistant 的 thinking 会保留**（evidence/probes-content-...json 的 thinking_nonleaf_position 对比 think_fake_signature）。
- 跨源安全做法（建议，**推测/未验证**）：Kimi 的 thinking 没有 Anthropic 合法签名。虽然本机代理（`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`）接受了假签名，但 mock 抓包证明 Claude Code 会把 thinking 块**原样**发给 API；打到真正的 api.anthropic.com 时，非最后一条会被 Code 剥掉、**最后一条的伪造 signature 大概率 400 invalid signature（未验证）**。因此 adapter 应 **默认丢弃 thinking，或降级成普通 text**（如 `[thinking] ...`），**绝不伪造/透传 signature**。别依赖"只在最后一条才有风险"——导出会持续被 resume，今天最后一条明天就是历史条，但 Code 只剥历史，末尾仍保留当下的最后 assistant：为稳妥一律不发 thinking。

**Q3. tool_use ↔ tool_result 不配对时：拒绝加载还是静默降级？**

- **静默降级，不会拒绝加载（实测确认）**：mock 抓包 + 真实 API 都通过（evidence/probes-...、evidence/real-orphan_tooluse_leaf.json、evidence/real2-orphan_tooluse_middle.json、evidence/real2-tool_pair.json）。
  - 正常配对：assistant `tool_use` + user `tool_result` 原样保留。
  - 孤儿 `tool_use` 在**中间**（后面跟了普通 user 消息）：Claude Code 直接丢弃该 assistant tool_use 记录，保留后续消息（可能把相邻 user 文本合并）。
  - 孤儿 `tool_use` 在**末尾**（被打断的调用）：Claude Code 自动补一条合成 `tool_result` 再发起请求（抓包可见），不会 400。
  - 孤儿 `tool_result`（无对应 tool_use）：静默丢弃。
  - id 不匹配：把不匹配的 tool_use + tool_result 一起丢弃。
- 结论：adapter **应主动配对**（保语义、避免内容丢失）；不配对不会导致加载失败。

**Q4. 连续两条 assistant / 空 content 是否安全？**

- **连续 assistant：安全（实测确认）**：加载正常，回放时是两条连续 assistant 消息；真实 API 跑通（evidence/real2-consecutive_assistants.json）。但为跨实现稳妥，建议 adapter 把相邻 assistant 合并为一条（**推测**：部分 Anthropic 兼容实现可能要求交替；本机代理接受）。
- **空 content**：user 空串/空数组 → **该行被静默丢弃**；assistant 空数组 → **保留但回放时替换成文本 "(no content)"**（实测确认，evidence/probes-...json 的 misc_assistant_empty_content / final_empty_user_content）。两者都不会导致加载失败。建议 adapter 不要写空消息（跳过或合并）。

**Q5. 文件位置规则？slug 与 cwd 不一致还能不能 resume？**

- **能（实测确认）**：`--resume <uuid>` 会扫描 `$CLAUDE_CONFIG_DIR/projects/*/<uuid>.jsonl`（**所有**一层子目录），不看当前 cwd 的 slug；实测从 repo root resume 了 tmp 目录的会话；从"没有对应 project 目录"的空 cwd 也 resume 成功（evidence 里的 emptycwd 测试；mock 抓包有 secret 回放）；把文件放在 `projects/-some-other-project-slug/` 也能 resume（evidence/probes-... 的 loc_other_slug）。
- 硬约束：**必须在 `<config>/projects/<一层>/<uuid>.jsonl`**；放在 `projects/` 外（如 `<config>/elsewhere/`）不行；文件名不是 UUID 不行（evidence/errors/errors.txt 的 D/E 例）。**查找键是文件名，不是行内 sessionId**；文件名与行内 sessionId 不一致也能找到（evidence/probes-06_sessionId_mismatch_filename）。
- 建议仍写入 `projects/<slug(cwd)>/`：`--continue` 和交互式 resume picker 是 cwd/slug 相关的（**推测**，基于 CLI 行为与源码中 cwd 相关索引；本 SPEC 未实测 picker）。
- slug 规则（**实测确认**）：把 cwd 中**每一个**非 `[A-Za-z0-9]` 字符替换成 `-`（不合并、不折叠）。例：`/Users/.../sessionport/.spikes/...` → `-Users-...-sessionport--spikes-...`（`.` 与前面的 `/` 各产生一个 `-`）。在 129 个真实 project 目录上核对：70 个匹配、0 个不匹配、1 个目录无法读取 cwd。路径含 unicode/空格时同样逐字符替换。
- 不需要 `history.jsonl`、`sessions/` 注册表或任何索引：隔离 config 首次运行只生成 `.claude.json` + `projects/.../*.jsonl`，resume 正常（**实测确认**）。

---

## 1. 验证方法（可复现）

- **隔离 home**：`CLAUDE_CONFIG_DIR=<workspace>/.spikes/claude-resume/home`，其中 `settings.json` 配代理（`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`、`ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED`、默认模型 `ccs-claude-venlacy--claude-opus-5-5[1M]`）。Claude 会创建 `home/.claude.json` 和 `home/projects/<slug>/<uuid>.jsonl`。
- **无头校验命令**（真实模型，PASS 标准 = 模型答出历史里的 secret）：

~~~bash
cd .spikes/claude-resume/tmp
CLAUDE_CONFIG_DIR=$PWD/../home claude -p --resume <uuid> --output-format json \
  "What is the exact secret word from earlier? Reply with only the word."
# => {"is_error":false,"result":"ZAPHIR-4471",...}
~~~

- **结构探针**（不花真实 token）：用 `--settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18999",...}}'` 把 API 指到本地 mock（`tools/mock-server.mjs`），抓 `POST /v1/messages` 的 `messages[]`，精确看到 Claude 把哪些行回放进了上下文。`--settings` 里的 env 会覆盖 `settings.json` 的 env（实测确认）。
- 全部探针：`tools/probe.mjs`（40+ case，输出 `evidence/probes-*.json`）；真实 API 校验：`tools/realcheck.mjs` / `tools/realcheck2.mjs`（输出 `evidence/real*-*.json`）。
- **源码确认**：2.1.303 是 Bun 单文件二进制，内含可读 JS；关键函数 `$Et`（行解析/leaf 选择）、`NIt`（parentUuid 链回放）、`zL`（按 Date.parse(timestamp) 选 leaf）、`L4e`/`s7s`（resume 加载）从二进制中提取，摘要见 `evidence/source-notes.txt`。

---

## 2. 文件位置、命名与查找

| 项 | 结论 | 类型 |
|---|---|---|
| 目录 | `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl`（默认 config dir 是 `~/.claude`） | 实测确认 |
| 子目录 | `projects/` 下**任意**一层目录都可以；不必与 cwd 的 slug 一致 | 实测确认 |
| 文件名 | **必须**是 resume 参数里的 UUID + `.jsonl`；lookup 以文件名为准 | 实测确认 |
| 行内 sessionId | 不参与查找；缺省/与文件名不一致都可加载 | 实测确认 |
| 是否需要注册表 | 不需要 `history.jsonl` / `sessions/` / 索引 | 实测确认 |
| 文件编码 | UTF-8，一行一个 JSON；空行/坏 JSON 行被忽略 | 实测确认 |
| 末尾换行 | 无末尾换行也能加载（建议保留 `\n`） | 实测确认 |
| 写权限 | 需对 config dir 可写；沙箱环境用 `CLAUDE_CONFIG_DIR` 隔离 | 实测确认 |

---

## 3. 行级 schema

Claude Code 的 transcript 行是"联合类型"。对 adapter 来说只需产出 `user`/`assistant` 两种行，其它行类型**可省**。

### 3.1 conversation record（user / assistant）

**必填（决定能否加载/回放）**

| 字段 | 类型 | 说明 | 证据 |
|---|---|---|---|
| `type` | "user" 或 "assistant" | 决定角色；`message.role` 不决定（type 优先） | 实测确认：缺 type 的 assistant 行被丢弃（probes field_no_type_on_assistant）；role 改成 user 仍按 assistant 回放（misc_role_mismatch） |
| `message` | object | 见下 | 实测确认：缺 message 行被丢弃 |
| `message.content` | string 或 block[] | user 可为 string 或 text block 数组；assistant 通常为 block 数组（string 也可，实测确认） | 实测确认 |
| `timestamp` | ISO-8601 string | **leaf 行必须能被 Date.parse 解析**；非 leaf 行可以缺失/非法（但建议全部合法） | 实测确认 + 源码确认 |
| `uuid` | UUID string | 多行时用于串联；单行文件可省（实测 type+message+timestamp 单行可 resume） | 实测确认 |
| `parentUuid` | UUID 或 null | 首行 null（或省），其后 = 上一行 uuid；**断链会丢失上下文** | 实测确认：全部无链时只剩 leaf 一条（09_no_parentUuid_only 的 warning）；断链可被 timestamp 兜底修复（08_parent_chain_broken、min_leaf_parent_missing） |

**可选 / 会被忽略（缺了不影响加载）**

`sessionId`（行内）、`userType`、`entrypoint`、`cwd`、`gitBranch`、`version`、`isSidechain`、`promptId`、`permissionMode`、`isMeta`、`apiBlockIndex`、`requestRef`、`requestedModel`、`effort`、`perTurnEffort`、`thinkingDurationMs`、`message.id`、`message.model`（异源模型名也 OK）、`message.type`、`message.stop_reason`、`message.usage`、`message.stop_sequence`、`toolUseResult` 等。全部**实测确认**（probes 02/05/06/10/final_abs_min*、model_name_foreign 等）。

**注意**
- `isSidechain: true` 的记录不参与"无 last-prompt 时"的 leaf 兜底（源码确认），adapter 不要写 true。
- `parentUuid` 断链/指向不存在 uuid：Claude 会按"时间戳最近的同 isSidechain 记录"兜底接上（源码 `wso`；实测 08_parent_chain_broken / min_leaf_parent_missing），但**不要依赖**，正确写链。
- 全部记录都没有 `parentUuid` 时有 stderr warning（不会失败）：`Resume transcript ... has N user/assistant records but none carry parentUuid links; only 1 reached the resumed conversation...`（实测确认，probes 09）。

### 3.2 最小完整示例（实测可 resume + 真实模型回放）

~~~jsonl
{"type":"user","message":{"role":"user","content":"The secret word is ZAPHIR-4471. Remember it."},"uuid":"11111111-1111-4111-8111-111111111111","parentUuid":null,"timestamp":"2026-10-19T05:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Understood. The secret word is ZAPHIR-4471."}]},"uuid":"22222222-2222-4222-8222-222222222222","parentUuid":"11111111-1111-4111-8111-111111111111","timestamp":"2026-10-19T05:00:01.000Z"}
~~~

### 3.3 metadata 行（可省，出现也安全）

`cost-state`、`last-prompt`、`atis-latch`、`mode`、`permission-mode`、`attachment`、`file-history-snapshot`、`file-history-delta`、`api-request`、`api-request-blob`、`api-request-shape`、`custom-title`、`ai-title`、`agent-name`、`pr-link`、`queue-operation`、`started`、`result`、`system` 等。
- 放在消息前后都不影响加载（实测 order_firstline_metadata_before_user / order_trailing_metadata_after_assistant）。
- `attachment` 行有 `uuid`/`parentUuid` 时会作为 `system` 角色消息进入回放（实测 chain_attachment_between）；adapter 不需要。
- **`last-prompt` 的坑**：只在需要显式指定 leaf 时写。带 `explicit:true` + `leafUuid` 会**钉住 leaf**，若 leafUuid 指向旧消息则历史上下文被截断（实测 confirm：final_explicit_true_stale_lastprompt 只回放了第一条）。不带 explicit 时，过期的 leafUuid 会被"最后一行"启发式覆盖（实测 final_explicit_false_stale_lastprompt 全量回放）。**建议 adapter 默认不写 last-prompt**；要写就写 `explicit:true` 且 `leafUuid = 最后一条消息 uuid`。

### 3.4 未知行 / 坏行

- **未知 type 行被忽略**，不影响加载（实测 07：未知类型行 + 一行非法 JSON + 空行 + 合法 baseline → 正常 resume，上下文完整）。
- **非法 JSON 行被忽略**（同上）。
- **未知 content block 类型不会在加载时被清掉**，会**原样**发给下一轮 API（mock 抓包 `kimi_thinking`、`kimi_attachment` 都在 `messages[]` 里）。本机代理接受了，但真正 Anthropic API 对未知 block type 大概率 400（**未验证**）。→ adapter 只允许输出已知 block：`text`、`tool_use`、`tool_result`；`thinking` 见 `5。
- 空文件 / 只有 metadata 行 → `No conversation found`（实测 errors.txt B）。

---

## 4. leaf 选择算法（写 timestamp/uuid 的依据）

**源码确认**（bundle 中 `$Et.processEntry` → `finish`、`zL`、`NIt`）：

1. 构建 `uuid → record` map（只含通过 schema 校验的行）。
2. 若文件里有 `last-prompt.leafUuid`：leaf 候选 = 该 uuid 对应的记录（且 `!isSidechain`、type ∈ user/assistant）；带 `explicit:true` 时严格钉死。
3. 否则（无 last-prompt）：leaf 候选 = **文件顺序里最后一条非 sidechain 的对话记录**（"last row"），并在 timestamp 字符串与 newest record 不一致时尝试用后代记录修正。
4. 最终对候选集合做 `Date.parse(timestamp)` 取**最大值**；解析不出（NaN）→ 没有 leaf → 加载返回 null → 报 No conversation found。
5. 从 leaf 沿 `parentUuid` 向上回溯（`NIt`）得到回放链；断链时按时间戳兜底（`wso`）；有环会截断并记日志。
6. 相邻同角色消息在发 API 前会被合并（实测：连续 user 文本合并成一条多 block；连续 assistant 在真实 API 侧也通过）。

**对 adapter 的推论**：
- 文件里**最后一条** user/assistant 行必须是"当前最新消息"，且 timestamp 合法。
- 所有 timestamp 用**单调递增的 ISO-8601 UTC 毫秒字符串**（如 `2026-10-19T05:00:00.000Z`）；不要用 epoch 数字，不要 null。
- 不要用一个旧 `last-prompt` 指向中间消息（除非你确实想截断历史）。
- 不要在末尾追加"空 conversation 行/metadata-only"——空内容 user 行会被丢，可能让 leaf 落空。

---

## 5. thinking 块（详见 `0-Q2）

| 情形 | 加载 | 回放（mock 抓包） | 真实代理（本机） | 跨源建议 |
|---|---|---|---|---|
| 无 signature | 通过 | thinking 块原样保留（sig 缺省） | 通过 | 丢弃 |
| `signature: ""` | 通过 | 空串被丢弃，等价无 signature | 通过 | 丢弃 |
| 假 signature | 通过 | 原样保留（sig 长度不变） | 通过（代理宽松） | **禁止**透传；一律丢弃/转 text |
| 非末尾 assistant 的 thinking | 通过 | **被 Claude Code 剥掉** | 通过 | 无需特别处理 |
| 末尾 assistant 的 thinking | 通过 | **保留并发送** | 通过（代理宽松） | 风险点：真 API 可能 400 |

- **未验证**：真实 `api.anthropic.com` 对伪造 signature 的行为；本机 `127.0.0.1:15721` 代理会接受，不能代表线上。
- 推荐 adapter 语义：`thinking` → 丢弃，或降级为 assistant text（`[thinking] ...`）；**绝不发明 signature**。

---

## 6. tool_use / tool_result 配对矩阵

构造规则（**实测确认**）：assistant 行 content 放 `{"type":"tool_use","id":"toolu_...","name":"Bash","input":{...}}`；下一条 user 行 content 放 `{"type":"tool_result","tool_use_id":"toolu_...","content":"..."}` 或 `content:[{"type":"text","text":"..."}]`。`message.stop_reason` 可省。

| 场景 | 加载 | 回放/修复行为 | 真实 API |
|---|---|---|---|
| 正常配对 | 通过 | 原样保留 tool_use + tool_result | 通过（real2-tool_pair） |
| 孤儿 tool_use（中间） | 通过 | 丢弃该 assistant tool_use 记录，后续消息保留 | 通过（real2-orphan_tooluse_middle） |
| 孤儿 tool_use（末尾/被打断） | 通过 | 自动补合成 tool_result 再请求 | 通过（real-orphan_tooluse_leaf） |
| 孤儿 tool_result | 通过 | 静默丢弃 | 通过（probes final_tool_orphan_result） |
| id 不匹配 | 通过 | 不匹配的 tool_use + tool_result 一起丢弃 | 通过（probes tool_mismatched_ids） |

**adapter 要求**：为每个 tool_use 生成对应 tool_result（顺序：assistant(tool_use) → user(tool_result)），无结果的 tool_use 丢弃（保语义）；不要指望修复机制。

---

## 7. 其它 message/content 规范化（实测确认）

- **role 字段**：`message.role` 不决定角色，`type` 决定（assistant 行 `message.role:"user"` 仍按 assistant 回放）。
- **assistant 空 content []** → 回放为 `"(no content)"` 文本。
- **user 空 content ""/[]** → 该行被丢弃。
- **连续 assistant** → 两条都回放；真实 API 通过（real2-consecutive_assistants）。建议合并。
- **连续 user** → 回放时合并成一条多 text block（probes final_tool_orphan_middle 可见）。
- **content 为 string 的 assistant** → 自动包装成 text block。
- **message.model 是异源模型名**（`kimi-k3-256k`）→ 正常（model 只是记录元数据，实际模型取 CLI/env）。
- **文本内容不改写**；不需要 `userType/entrypoint/cwd/gitBranch/version`。

---

## 8. resume 之后会发生什么（adapter 需知）

- `claude -p --resume <uuid> ...` 会**向同一个 jsonl 追加**新行：新 user 行、若干 `attachment`（如 prompt_snapshot）、assistant 行、`last-prompt`、`mode`、`atis-latch`、`cost-state` 等（实测：evidence/real2-summary.json 对应文件尾部）。
- 追加行的 `parentUuid` 会接在当前 leaf 上；如果 adapter 的 leaf 没有 `uuid`，会破坏后续链（所以永远给每条记录写 uuid）。
- 文件会保持可再次 resume（不要在导出后自己截断/重写；sessionport 若要更新需整文件重写并保证链一致）。
- `--fork-session` 可新建 session id（非必需）；本 SPEC 未依赖。

---

## 9. writeSession 实现清单（伪代码）

~~~text
inputs: session IR (turns), targetCwd, configDir = env.CLAUDE_CONFIG_DIR ?? ~/.claude
1. sessionUuid = 新 v4 UUID（小写）
2. slug = targetCwd.replace(/[^A-Za-z0-9]/g, "-")
3. file = <configDir>/projects/<slug>/<sessionUuid>.jsonl
4. prevUuid = null; ts = now - turns*1000
   for turn in turns (按时间顺序):
     ts += 1000
     if turn.role == "user":
       content = 文本直接拼 string；若有 tool_results -> [{type:"tool_result",tool_use_id,content}]
       lines.push({type:"user", message:{role:"user",content}, uuid, parentUuid:prevUuid, timestamp:iso(ts)})
     if turn.role == "assistant":
       content = []
       for block in turn.blocks:
         text      -> {type:"text",text}
         thinking  -> 丢弃或 {type:"text",text:"[thinking] "+...}   // 不发 signature
         tool_use  -> 仅当后续能找到配对 tool_result 才输出（否则丢弃）
         unknown   -> 丢弃（禁止透传未知 block）
       if content.length == 0 -> 跳过该行（或合并下一条）
       lines.push({type:"assistant", message:{role:"assistant",content}, uuid, parentUuid:prevUuid, timestamp:iso(ts)})
     prevUuid = uuid
5. 不写 last-prompt（或写 {type:"last-prompt", leafUuid:lastUuid, explicit:true, sessionId, lastPrompt:...}）
6. 写文件：lines.map(JSON.stringify).join("\n") + "\n"
7. 返回 {sessionId, path}
8. 校验：claude -p --resume <sessionUuid> --output-format json "<question about history>"，检查 is_error=false 且回答包含历史 secret
~~~

**写入前自检**（任一不满足都可能丢上下文或报 not found）：
- [ ] 至少一条 user/assistant 行；
- [ ] 最后一条对话行 timestamp 是合法 ISO-8601（带毫秒+Z）；
- [ ] 所有 uuid 唯一、parentUuid 链首尾相接、首行 null；
- [ ] 没有空 content 行、没有未配对 tool_use、没有伪造 thinking signature、没有未知 content block；
- [ ] 文件路径 `<config>/projects/<slug>/<uuid>.jsonl`，文件名 = 将被 resume 的 uuid。

---

## 10. 未验证 / 风险项

1. **真实 Anthropic 线上 API** 对假 thinking signature、未知 content block 的行为（本机代理宽松，mock 证明请求里会原样带上）。→ 未验证，按保守策略实现。
2. 交互式 `claude --resume`（picker / `--continue`）对"仅手写项目目录"的识别细节；本 SPEC 验证的是 `claude -p --resume <uuid>`。
3. 跨版本兼容（2.1.303 实测；2.1.299/300 真实文件也被成功 resume，但未逐版本回归）。
4. 超大会话/图片 block/attachment 映射未测；adapter v1 建议只做文本 + tool_use/tool_result。
5. `gitBranch`/`cwd` 不同导致的环境上下文差异：resume 成功且 Claude 会插入 "Environment update" system 消息（实测），但对模型行为的影响未评估。

---

## 11. 证据索引（都在 `.spikes/claude-resume/evidence/`）

| 文件 | 内容 |
|---|---|
| `errors/errors.txt` | 5 种 "No conversation found" 复现（缺失 UUID/空文件/leaf 无 timestamp/位置错/文件名非 UUID），含 exit code |
| `real-summary.json` + `real-*.json` | 第一轮真实 API 校验（minimal chain/single user 答出 secret；thinking 三态；孤儿 tool_use；未知 block） |
| `real2-summary.json` + `real2-*.json` | 第二轮真实 API 校验（绝对最小行集、孤儿 tool_use 中间、连续 assistant、tool 配对） |
| `probes-all.json` | 第一批 mock 探针（baseline、字段删减、未知行、断链、sessionId 错配） |
| `probes-ts-chain-tool-think-loc-order-odr-field-.json` | timestamp/链/tool/thinking/位置/顺序/字段最小性 |
| `probes-min-*.json` | 最小记录 + leaf 规则 |
| `probes-content-*.json` | content block 规范化、thinking 位置、空内容、role 错配 |
| `probes-final-.json` | 绝对最小行、last-prompt explicit、tool 边缘、连续 assistant |
| `requests/*.json` | 每个探针被 mock 捕获的完整 API 请求（可看 messages[] 回放） |
| `debug-ts_assistant_missing.log` | leaf 无 timestamp 时的 debug 日志 |
| `reference/claude-2.1.303-session-ce9bdb03.jsonl` | 2.1.303 自己写出的真实会话（含 attachment/api-request 等全部行型） |
| `reference/claude-2.1.300-session-8e54e78d.jsonl` | 2.1.300 真实小会话样例 |
| `source-notes.txt` | 从 2.1.303 bundle 提取的 leaf/链/加载关键函数摘要 |

## 12. 复现命令

~~~bash
# 结构探针（本地 mock，不花 token）
cd .spikes/claude-resume && node tools/mock-server.mjs &   # :18999
node tools/probe.mjs 00_baseline_full_2turn

# 真实 API 端到端
cd .spikes/claude-resume && node tools/realcheck2.mjs

# 生成 + 校验（交付脚本）
node gen.mjs sample-session.json
./verify.sh sample-session.json
~~~

---

## 附录：sessionport 实现阶段补充的两个坑（2026-10-19 实测）

1. **`CLAUDE_CONFIG_DIR` 必须是绝对路径。** 传相对路径时，claude 子进程会按它自己的 cwd 解析，
   而调用方进程的 cwd 往往不同 → 直接报 `No conversation found`。adapter 在解析 config dir 时统一绝对化。

2. **无头调用必须把 stdin 设为 /dev/null（Node 里 `stdio[0] = 'ignore'`）。** 把 stdin 留成打开的管道时，
   claude 会等 3 秒并打印 `Warning: no stdin data received in 3s`，随后按另一种路径处理导致 `No conversation found`。
   bash 里显式 `< /dev/null` 就不会踩到。

3. **resume 会在同一文件末尾追加** `attachment` / `last-prompt` / `mode` / `atis-latch` / `cost-state` 等元数据行。
   校验器必须容忍这些行（父链判定要把它们的 uuid 也纳入"更早出现"的集合），否则对已 resume 过的会话误报断链。
