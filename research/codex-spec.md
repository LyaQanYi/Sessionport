<!-- 由 codex spike 产出，2026-10-19。证据目录 .spikes/codex-resume/（gitignored）。 -->

# Codex 0.163 最小可 resume 会话 — Spike SPEC

> 目标：回答「让 `codex exec resume <session-id> "<prompt>"` 成功加载并继续对话的最小会话形态」。
> 结论标注：**[实测]** 已在隔离 CODEX_HOME 实测；**[源码/反编译]** 读源码或反编译确认；**[推测]** 由行为推断；**[未验证]** 未测。
> 本目录所有探针都跑在独立 `CODEX_HOME` 下，真实 `~/.codex` 只读，未做任何修改。
> 唯一真实模型调用共 3 次（2 次 canary + 1 次 verify --real），其余全部走本地 mock / 不可达 base_url（免费）。

## 0. TL;DR（给 adapter 实现）

1. **最小会话 = 一个 rollout JSONL 文件**：`$CODEX_HOME/sessions/<任意子目录>/rollout-<任意>.jsonl`，内容只需
   `session_meta` + 若干 `response_item:message`。不需要预写 `state_5.sqlite`、`thread_history_1.sqlite`。**[实测]**
2. `session_meta.payload` 必需字段恰为：**`id`、`timestamp`、`cwd`、`cli_version`、`originator`**（另有每行顶层 `timestamp`）。**[实测]**
3. 发现机制是**递归扫描 `$CODEX_HOME/sessions/**` 下 basename 匹配 `rollout-*.jsonl` 的文件**；文件名不必含 id，日期目录随意，但前缀必须是 `rollout-`、后缀必须是 `.jsonl`。**[实测]**
4. 写 **legacy**（无 `ordinal`，`history_mode` 可省略）即可被 0.163 直接 resume；0.163 新会话默认写 **paginated**，两者都能 resume，且 resume 会**原地追加**到同一 rollout。**[实测]**
5. **resume 使用进程 cwd，不用 rollout 里的 cwd**。adapter 必须 `cwd = session.cwd` 启动子进程。**[实测]**
6. **session id 必须是合法 UUID**；非 UUID 形式时 codex **静默新建线程**（exit 0）而不是报错。**[实测]**

## 1. 最小 rollout 形态

```jsonl
{"timestamp":"2026-10-19T02:00:01.000Z","type":"session_meta","payload":{"id":"01a1533c-0000-7000-8000-000000000001","timestamp":"2026-10-19T02:00:00.000Z","cwd":"/abs/project","cli_version":"0.163.0","originator":"codex_exec"}}
{"timestamp":"2026-10-19T02:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"launch code is BLUE-42-NIGHTINGALE"}]}}
{"timestamp":"2026-10-19T02:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"noted"}]}}
```

- 上面 3 行即可 resume 并把这段对话带进模型请求（实测 request 的 `input` 里出现 user/assistant 两条）。**[实测]** `evidence/variants2.json`（`tiny-meta`，`evidence/variants5.json`）
- `payload.session_id` 可选；`payload.id` **必需**；`session_meta` 行必须**第一行**，否则报 `rollout ... does not start with session metadata (code -32603)`。**[实测]** `variants2: drop-id/drop-timestamp/...`
- 可选字段（删掉不影响 resume）：`session_id`、`runtime_workspace_roots`、`source`、`thread_source`、`model_provider`、`base_instructions`、`history_mode`。**[实测]** `variants2: drop-*`
  - `history_mode` 缺省 = `legacy`；只接受 `legacy` / `paginated`，其他值报 `unknown variant ... expected legacy or paginated`。**[实测]**
  - `model_provider` / `model` 只作展示，**不决定实际 provider/model**（实际取 config.toml；meta 写 `openai` 也能用 custom provider 跑通）。**[实测]** `variants5: provider-mismatch / meta-model`
- **每一行都必须有顶层 `timestamp`**：缺 `timestamp` 的 `response_item` 不报错，但会被**静默从历史里丢掉**（模型看不到）。**[实测]** `variants2: msg-no-line-timestamp`（inputCount 6→4）
- message 的 `content` 必须是数组，元素 type 与 role 对应：**user → `input_text`，assistant → `output_text`**；沿用旧格式 `type:"text"` 的 user 项会被静默丢弃（assistant 用 input_text 仍可用）。**[实测]** `variants2: msg-text-type / msg-assistant-inputtext`
- message 的 `payload.id` 可省略；`status` 可省略。**[实测]**
- 工具历史：`function_call`（name/arguments/call_id）+ `function_call_output`（call_id/output）会原样进模型请求；**孤立 function_call 会被自动补一条 `{"output":"aborted"}` 的 output**，不会炸。**[实测]** `variants4b`
- `reasoning` 项会以 summary 形式重放（`encrypted_content:null` 可接受）。**[实测]** `variants4b: reasoning`

## 2. 注册层：resume 靠什么发现会话

| 组件 | resume by UUID 必需？ | 说明 | 证据 |
|---|---|---|---|
| `$CODEX_HOME/sessions/**/rollout-*.jsonl` | **是（唯一真源）** | 递归扫描；子目录任意、日期目录任意、文件名不需含 id；必须 `rollout-` 前缀 + `.jsonl` 后缀 | `variants2` layout-*、`variants5` filename-* |
| `state_5.sqlite` `threads` 行 | 否 | 首次 resume 时**自动创建**该行（history_mode 取 meta、title/preview=新 prompt）；`--last`/picker 依赖它 | `p1-resume.txt`、`variants3` |
| `session_index.jsonl` | 否 | `{"id":"<uuid>","thread_name":"...","updated_at":"..."}`；写了才能 `resume <name>` | `variants3: name-index` |
| `thread_history_1.sqlite` | 否 | legacy/paginated 均不需要；codex 按需自建/重建 | `variants4b: pg-no-thread-history` |
| `config.toml` | 是（provider/auth 来源） | 隔离 home 里必须提供；`-c` 可覆盖 base_url | `probe0`、`verify.sh` |
| `model_catalog_json` 指向的文件 | 是（当 config 引用它时） | 缺文件直接 `Error: No such file or directory (os error 2)` | `run-dbg4` 初期 |

- 空 home（只有 config）→ `Error: thread/resume ... no rollout found for thread id <id> (code -32600)`，exit 1。**[实测]** `probe0-resume.txt`
- `sessions/` 之外（如 `$CODEX_HOME/not-sessions/...`）找不到。**[实测]** `variants2: layout-outside-sessions`
- 同名 id 多份 rollout：resume 用了较新的那份（2026 目录 vs 2025 目录）。具体排序规则 **[未验证]**（推测按扫描顺序/时间）。
- `sessions/**.jsonl` 里不带 `rollout-` 前缀（如 `foo-<id>.jsonl`）找不到 → 直接新建线程。**[实测]** `variants3: name-foo`

## 3. legacy vs paginated 与迁移态

- 真实 0.162 会话是 legacy：673 行、无 `ordinal`、`session_meta.history_mode="legacy"`。**[实测]** `evidence/rollout-inventory.txt`
- **0.163 新建会话默认 paginated**：14 行、每行顶层有递增 `ordinal`（从 0 起）、`history_mode="paginated"`，并同步写 `state_5.threads` + `thread_history_1` 投影。**[实测]** `evidence/samples/native0-0.163-native-paginated-rollout.jsonl`、`native0-rollout-inventory.txt`
- **legacy 可以直接 resume，不要求先迁移**；resume 会把新事件（无 `ordinal`）追加到原文件。**[实测]** `real-canary.json` legacy 用例：5→20 行
- **paginated 也可以直接 resume**：只需 `history_mode="paginated"` + 每行 `ordinal`；`thread_history_1.sqlite` 不存在也能跑，追加行 `ordinal` 顺序延续（5,6,7,…）。**[实测]** `variants3: pg-minimal`、`variants4b: pg-no-thread-history`、`real-canary.json` paginated 用例
- `ordinal` 细节：允许重复、允许不从 0 开始（都能 resume）；**缺失则致命**：`final paginated rollout record at <path> is missing an ordinal`。**[实测]** `variants3`、`variants2: mode-paginated-field`
- **不会自动迁移**：`migrate-rollouts` 干跑报 `eligible`，resume 后仍是 legacy；`background_paginated_rollout_migration` feature 为 `under development / false`。**[实测]** `p1-migrate.json`、`evidence/native0-exec.jsonl`
- `codex migrate-rollouts --apply`：**原地重写** rollout（每行补 `ordinal`、`session_meta.history_mode` 改 paginated），同步更新 `threads.history_mode` 并重建 `thread_history_1` 投影；不改文件名/路径。**[实测]** `evidence/samples/migrated-legacy-to-paginated-rollout.jsonl`

### 给 adapter 的迁移建议
- 现在写 legacy 完全可用（Lead 已验证 32k/346k tokens 会话）。**[实测]**
- 未来若要改写成 paginated，只需两处：① `session_meta.payload.history_mode="paginated"`；② **每行**加顶层 `ordinal`（0,1,2,…）。不需要写 `thread_history_1.sqlite`，也不需要预写 `state_5.sqlite` 行；resume 会自动继续编号并补投影。**[实测]**
- 已写出的 legacy 会话若要升级，交给 codex 自己：`codex migrate-rollouts --apply --thread <id>`（isolation 下实测通过）。**[实测]**

## 4. 真实 resume 验证（canary）

设计：canary `BLUE-42-NIGHTINGALE` 只存在于 rollout 历史中，resume prompt 只问「launch code 是什么」，模型只能从历史得知。

| 用例 | 结果 | 证据 |
|---|---|---|
| legacy 最小会话 + 真实模型 | exit 0；回答 `BLUE-42-NIGHTINGALE`；rollout 5→20 行 | `real-canary.json`、`samples/canary-legacy-rollout-after-resume.jsonl` |
| paginated 最小会话 + 真实模型 | exit 0；回答 `BLUE-42-NIGHTINGALE`；追加行 ordinal 5..19 | `real-canary.json`、`samples/canary-paginated-rollout-after-resume.jsonl` |
| `verify.sh --real`（端到端） | 全部 PASS（含 canary 回答、append、负例、按名 resume） | `evidence/verify-20261019-162854-10275/` |
| `verify.sh --mock`（免费回归） | 全部 PASS（断言 mock 收到的请求 input 里含 canary） | `evidence/verify-20261019-162804/`、`verify-20261019-162829/` |

追加事件形态（与 codex 自己的一轮一致）：`event_msg:thread_settings_applied ×2~3`、`event_msg:task_started`、`response_item:message`(developer skills / user environment_context / user prompt / assistant)、`world_state`、`turn_context`、`event_msg:item_completed`、`token_usage_record`、`event_msg:token_count`、`event_msg:task_complete`。**[实测]**

## 5. 坑（按重要性）

1. **cwd**：`codex exec resume` 用**进程 cwd**，忽略 rollout meta 里的 `cwd`（请求里的 environment_context cwd、新建 threads 行的 cwd 都是进程 cwd）。adapter 必须 `cwd=session.cwd` 启动。**[实测]** `variants4: cwd-meta-tmp`
2. **非法 session id → 静默新线程**：非 UUID（如 12-hex 首段）时 `exec resume` **exit 0 并新建 thread**，不报错；合法 UUID 未找到才报 `no rollout found`。生成器必须产/校验 UUID。**[实测]** `evidence/uuid-fallback.txt`；`gen.mjs` 已加校验
3. **response_item 缺顶层 timestamp → 历史静默丢失**（不报错）。**[实测]**
4. **content type 必须匹配 role**（user `input_text` / assistant `output_text`），否则该项静默丢弃。**[实测]**
5. **`history_mode=paginated` 必须每行有 `ordinal`**，否则 fatal。**[实测]**
6. **`session_meta` 必填 5 字段**（id/timestamp/cwd/cli_version/originator），缺一个都报 `does not start with session metadata (code -32603)`。**[实测]**
7. **`disable_response_storage` 在 0.163 已被忽略**（config 里还有会输出非致命的 `item.completed:error` 事件）。解析 `--json` 的 adapter 要容忍这类非致命 error item。**[实测]** `verify --real` 输出
8. **`--skip-git-repo-check` 对 resume 不是必需**（非 git 目录实测可跑）；保留也无害。**[实测]** `variants4: nogit-check`
9. **项目信任 `[projects.*]` 对 resume 无影响**（meta cwd 指向未信任/不存在路径都能 resume，因为实际用进程 cwd）。**[实测]** `variants4: cwd-untrusted / cwd-missing`
10. **title/name**：resume 自动创建的 threads 行 `title/first_user_message/preview` 取的是**新 prompt**，不是历史首条；`session_index.jsonl.thread_name` 可让 `resume <name>` 生效。写 `state_5.threads.name` 的方式实测**没有**恢复出历史（可能命中了别的路径），**不建议依赖**。**[实测/未验证]** `variants3: name-index`、`variants4b: name-sqlite`
11. **`--last` 依赖注册表而非扫描**：刚写入 rollout、还没被 resume 过时，`--last` 找不到它（会新建线程）；先显式 resume 一次后 `--last` 才带上历史。**[实测]** `variants3: last-flag`、`variants4b: last-after-registry`
12. 复制真实 `config.toml` 到隔离 home 时：**必须同时带 `model_catalog_json` 指向的文件**，否则 `os error 2`；`[projects]`/`[plugins]` 等无碍。**[实测]**

## 6. 未验证 / 风险

- **TUI `codex resume`（picker）** 与 `exec resume` 的差异未测（本次约束不跑 TUI）；picker 过滤条件（cwd/source）可能更严格。**[未验证]**
- 版本兼容：只测了 0.163.0 读 0.162 legacy 样本 + 自造样本；其他版本、未来版本是否继续支持 legacy 读取 **[未验证]**（迁移工具的存在暗示 legacy 会逐步退役）。
- 并发/daemon：全程隔离 home（独立 app-server/ipc），**未测**目标 `~/.codex` 正在被 GUI/daemon 使用时写入 rollout 的竞态与索引刷新时机。**[未验证]**
- 分页格式只测了 message 类 item；paginated 下 function_call/reasoning 的投影细节 **[未验证]**。
- 同一 id 多份 rollout 的选取规则、UUID v4（非 v7）是否同样被接受：**[未验证]**（v7 形态实测通过）。
- `state_5.sqlite` 预写 threads 行以设置 title/name 是否被支持：**[未验证]**。

## 7. 交付物与用法

### `gen.mjs`（生成最小会话）
```bash
node gen.mjs --spec session.json --home /tmp/CODEX_HOME --mode legacy   # 或 --mode paginated
# spec: { sessionId(UUID), cwd, createdAt?, name?, items:[{role,text}|{type:function_call|function_call_output|reasoning,...}] }
```
会写 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`；有 `name` 时追加 `session_index.jsonl`；home 无 config 时从 `--config-from`（默认 `~/.codex/config.toml`）复制。

### `verify.sh`（无头验证，打印 PASS/FAIL + 完整命令）
```bash
./verify.sh --mock --mode legacy     # 免费：本地 mock Responses API，断言历史进了请求
./verify.sh --real --mode legacy     # 真实模型（1 次调用），断言 canary 回答
./verify.sh --mock --mode paginated  # 免费验证 paginated
```
覆盖：生成 → resume exit 0 → thread.started id 匹配 → canary（真实或 mock 请求内断言）→ rollout 追加 → 负例（未知 id 报错）→ 按 thread name resume。证据落在 `evidence/verify-<ts>/`。

### `evidence/` 索引
| 文件 | 内容 |
|---|---|
| `rollout-inventory.txt` | 真实 0.162 legacy 会话（673 行）结构统计 |
| `native0-rollout-inventory.txt` / `native0-exec.jsonl` | 0.163 原生 paginated 会话（14 行）及创建过程 |
| `probe0-resume.txt` | 空 home resume 报错 |
| `p1-resume.txt` / `p1-migrate.json` | 仅 rollout 文件即可 resume；迁移 dry-run `eligible` |
| `variants1.json` | 最小 meta+2 消息、无 meta、meta-only 等首批探针 |
| `variants2.json` | session_meta 字段逐个删除、目录/文件名、content 形态、history_mode 变体 |
| `variants3.json` | paginated 变体、发现规则、按名 resume、cwd/trust、`--last` |
| `variants4b.json` | 工具调用/孤立 call/reasoning 重放、无投影 paginated、sqlite name |
| `variants5.json` | 极简 meta（恰 5 字段）、provider 不一致、文件名前缀矩阵 |
| `uuid-fallback.txt` | 非 UUID id 静默新建线程 vs 未知 UUID 报错 |
| `real-canary.json` | 真实模型 canary（legacy/paginated）完整事件 |
| `samples/*.jsonl` | resume 后（或迁移后）的原始 rollout 样本 |
| `verify-*/` | `verify.sh` 各次运行的完整命令/输出/请求日志 |
| `mock-requests.jsonl` / `mock-ok-requests.jsonl` | 各探针抓到的 Responses API 请求体（可看到历史如何进入 input） |

`tools/` 下为一次性探针脚本（mock-proxy、variants*、real-canary、probe-uuid-fallback 等），可复跑；`tools/analyze.mjs` 可对任意 rollout 做行类型统计。
