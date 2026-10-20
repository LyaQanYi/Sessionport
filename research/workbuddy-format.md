# WorkBuddy 会话格式（macOS，2026-10-20）

对象：腾讯 WorkBuddy 5.8.3（`/Applications/WorkBuddy.app`，桌面端内置 CodeBuddy CLI）。
本机实测：`~/.workbuddy` 下 13 条 sessions，其中 12 条有 transcript、1 条云会话没有正文。

标记约定：**[实测]** 本机直接读到/跑通；**[推测]** 从代码、命名或单一样本推断，未做破坏性验证。

---

## 1. 存储位置 [实测]

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `~/.workbuddy/workbuddy.db` | `sessions` 表：id/cwd/title/custom_title/status/created_at/updated_at/last_activity_at/deleted_at/model/mode/transport… | **只有元数据，没有正文**；`node:sqlite` readOnly 打开 |
| `~/.workbuddy/projects/<slug>/<sessionId>.jsonl` | 会话正文 | 一行一个 JSON；本机 12 份，最大约 1.3 MB |
| `~/.workbuddy/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` | 子代理正文 | 与主会话同格式；本机 4 份 |
| `~/.workbuddy/traces/*/trace_*.jsonl` | 运行诊断 trace | 含对话片段但与 transcript 重复，adapter 不读 |
| `~/.workbuddy/workspace/sessions`、`storage/user-*` | 编辑器快照 / UI 缓存 | 不是正文 |
| `~/.workbuddy/app` | Electron 用户数据 | 无关 |

slug 规则 [实测]：`cwd` 中所有非字母数字字符替换成 `-`，与 Claude Code 的 project slug 相同：

```text
/Users/me/Documents/Coding/0vscode-neko
-> Users-me-Documents-Coding-0vscode-neko
```

注意本机目录名**没有**开头 `-`（Claude Code 风格有），因为规则只替换字符。adapter 不依赖 slug 反解，而是扫 `projects/*/*.jsonl`。

## 2. DB 语义 [实测 + 推测]

- `deleted_at` 是软删除时间戳；本机 12 条本地会话全部有值，但 transcript 完整保留，仍可读。
  UI 删除会写 `UPDATE sessions SET deleted_at=?, updated_at=?, unread=0` [实测，来自 app.asar 字符串]。
- 云会话 `deleted_at=-1` 表示活跃；本机唯一一条云会话（`2101903768322555904`）没有 transcript，adapter 列表不返回。
- `title` 是 App 自动标题，`custom_title` 是用户重命名；列表优先 `custom_title`。
- `last_activity_at` 是最后一次活动，`updated_at` 在删除/关闭时会变；列表优先 `updated_at`，退回 `last_activity_at`，再退回文件 mtime。
- `model` 可能是 `deepseek-v4.1-flash`、`step-5-preview`、`custom-local:kimi-k3` 等。
- **[推测]** `deleted_at` 可能同时被 App 用作「关闭会话」墓碑，因为所有本地会话的 `deleted_at` 都等于 `updated_at`；adapter 只把它映射为 `archived`，不影响读取。

## 3. JSONL 行类型 [实测]

行是 OpenAI Responses API 风格（不是 Anthropic）。共有：

| type | 作用 | IR 映射 |
| --- | --- | --- |
| `session-meta` | 会话头（可重复，每次续聊一行） | 忽略 |
| `message` (role=user) | 用户消息；content 里是 `input_text` | `message(user)`，抽 `<user_query>` |
| `message` (role=assistant) | 助手文本；content 里是 `output_text` | `message(assistant)`；被打断的标 synthetic |
| `reasoning` | `rawContent:[{type:'reasoning_text',text}]` | `reasoning(plain)` |
| `function_call` | `callId/name/arguments`（arguments 是 JSON 字符串） | `tool_call` |
| `function_call_result` | `callId/name/status/output` | `tool_result` |
| `ai-title` | `aiTitle` 自动标题 | 会话标题 |
| `file-history-snapshot` | 文件备份元数据 | 跳过（info notice） |
| `credit-usage` | 计费埋点 | 跳过（info notice，本机单会话最多 254 行） |
| `resend-fork-notice` | 用户编辑后重发/分叉 | `boundary(fork)` |

样例（裁剪）：

```json
{"type":"message","id":"01a14fc3-7a20-7c10-9ac4-09f34228f37c","timestamp":1792339571308,"role":"user","content":[{"type":"input_text","text":"<system-reminder ...>...</system-reminder>\n<user_query>分析一下项目架构</user_query>"}],"sessionId":"abeda640-...","cwd":"/Users/me/project"}
{"type":"reasoning","id":"...","parentId":"...","timestamp":1792339584622,"content":[],"rawContent":[{"type":"reasoning_text","text":"..."}]}
{"type":"function_call","id":"...","callId":"call_00_...","name":"Bash","arguments":"{\"command\":\"ls\"}","timestamp":1792339584640}
{"type":"function_call_result","id":"...","callId":"call_00_...","name":"Bash","status":"completed","output":{"type":"text","text":"README.md\nsrc"}}
```

### 3.1 用户消息里的注入上下文 [实测]

13/16 条 user 消息带 `<system-reminder>` 包裹的运行时上下文，正文在末尾的 `<user_query>...</user_query>` 中。
adapter 规则：

1. 有 `<user_query>` → 只取其中文本，当作真实用户消息；
2. 以 `<system-reminder` / `<teammate-message` / `<task-notification` 开头且没有 user_query → 保留原文但标 `synthetic=true`；
3. 空 content → 跳过并记 notice。

### 3.2 工具结果 output 的三种形状 [实测]

- `{"type":"text","text":"..."}`（166/176）
- 数组 `[{"type":"input_text","text":"..."}]`（10/176，widget 类工具；文本常是 JSON 字符串）
- 字符串/对象（样本未出现，adapter 兜底为 text 或 json）

工具参数 `arguments` 是 JSON 字符串；坏 JSON 保留为 `{raw: "..."}` 并记 warning。

### 3.3 链与顺序 [实测]

- 行按文件顺序就是对话顺序；本机 570 条对话行的 `parentId` 全部等于上一行 id（无分叉）。
- adapter 不按 `parentId` 重建树，直接按文件顺序映射 IR 链（避免并行工具调用/分叉时丢行）。
- 每条 IR 事件的 `parentId` 是上一 IR 事件，满足 core 的 `validateIrBundle`。

### 3.4 子代理 [实测]

- 路径：`projects/<slug>/<sessionId>/subagents/agent-<uuid>.jsonl`。
- 格式与主会话相同，只是没有 `ai-title`/`credit-usage` 等。
- 本机 4 份子代理 transcript，84–443 行；最大一份含 87 reasoning / 175 tool call。
- 文件名里的 uuid 就是子代理 id；主会话里 `Agent` 工具的 function_call 是触发点，但没有可靠的 callId 关联字段 → adapter 只填 `label`，`viaToolCallId` 留空 [推测：可通过 function_call 的 prompt 文本匹配，但不稳]。

## 4. CLI / resume [实测]

- App 内嵌 CodeBuddy CLI：`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`。
- 直接执行失败：`Cannot find module '../dist/codebuddy'`，因为 `dist/codebuddy` 在 `app.asar` 内，需要 Electron 的 asar fs 才能解析。
- 本机 PATH 里没有 `workbuddy` / `codebuddy` 命令；`~/.workbuddy/binaries` 只有 node/python 下载缓存。
- 因此**没有可用的 CLI resume 验证**；WorkBuddy 只能通过 GUI 打开（URL scheme `workbuddy://` [实测，Info.plist]）。adapter 不提供 resumeHint。

## 5. adapter 行为

- `listWorkBuddySessions({home?})`：扫 `projects/*/*.jsonl`，DB 只补 title/cwd/时间/archived；无 DB 也能列（读文件头 256 KB）。
- `readWorkBuddySession(idOrPath,{home?,includeSubagents?})`：读根 transcript + 子代理 → `IrBundle`。
- `verifyWorkBuddySession`：检查 JSONL、session-meta、ai-title、IR 结构、工具配对、子代理链。

实测结果（`SESSIONPORT_WORKBUDDY_HOME=~/.workbuddy`）：

| 会话 | events | 组成 |
| --- | --- | --- |
| `abeda640…`（分析项目架构） | 117 | message 13 / reasoning 20 / tool_call 42 / tool_result 42 |
| `e31b6d32…`（核对登录契约） | 203 | message 23 / reasoning 43 / tool_call 68 / tool_result 68 / boundary 1 |
| `b84ce15f…`（N.E.K.O. 方案） | 7 | message 2 / reasoning 1 / tool_call 4（被打断，无结果）+ 3 子代理 |

## 6. 坑

1. **正文不在 DB**：只查 `sessions` 表会得到空对话；必须读 `projects/**/*.jsonl`。
2. **deleted_at 全是墓碑**：按 DB 过滤会得到 0 条；文件仍在，应以文件为准。
3. **credit-usage 行极多**：单会话 254 行，逐行映射会污染 IR；跳过即可。
4. **session-meta 重复**：每次续聊追加一行，不是错误。
5. **user 消息被注入上下文包裹**：不抽 `<user_query>` 会把系统提示当用户问题，跨端导入后标题/首问全错。
6. **工具 output 可能是数组**：widget 工具返回 `[{type:'input_text',text:'<json>'}]`，需要展平。
7. **子代理没有显式父指针**：只能靠目录约定，`viaToolCallId` 不可靠。
8. **CLI 不可独立运行**：验证只能读文件或开 GUI；不要 promise 一个 `workbuddy --resume`。

## 7. 复现命令

```sh
# 离线 fixture
node --test packages/adapters/workbuddy/test/*.test.ts

# 真实目录（只读）
SESSIONPORT_WORKBUDDY_HOME="$HOME/.workbuddy" \
  node --test packages/adapters/workbuddy/test/*.test.ts

# 直接 import：list + read
node --input-type=module -e "
import { listWorkBuddySessions, readWorkBuddySession } from './packages/adapters/workbuddy/src/index.ts';
const rows = await listWorkBuddySessions();
console.log(rows.length, rows[0]?.title);
const bundle = await readWorkBuddySession(rows[0].sessionId);
console.log(bundle.root.events.length, bundle.children.length);
"
```
