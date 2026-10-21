# Cursor Chat 导出格式（v1）实测笔记

样本：`cursor_chat_6789.json`（用户从 Cursor 3.25.9 导出，约 3.0 MB，2026-10-21）。
本笔记只记录结构与规则，不含会话正文。

## 顶层结构

```json
{
  "version": 1,
  "name": "<会话标题>",
  "conversationState": "<base64(protobuf)>",
  "blobs": { "<sha256 hex>": "<base64(protobuf chunk)>", ... },
  "exportedAt": "<ISO 时间>"
}
```

- `version` 必须为 `1`（导入侧显式校验）。
- `conversationState` 是 **protobuf 消息**，样本 6192 字节。
- `blobs` 是**内容寻址**的 chunk 存储：`sha256(blob 原始字节) === key`（实测验证）。
- 样本：248 个 blob，单个 35 B ~ 307 KB（大 blob 是长工具输出/文本块）。

## conversationState 的字段（wire-level 统计）

| field | wire | 出现次数 | 观察 |
| ---: | ---: | ---: | --- |
| 1 | 2 | 153 | 32 字节，全部命中 `blobs` 的 key → **blob 引用列表**（决定消息顺序） |
| 5 | 2 | 1 | 8 字节，未知标量（可能是版本/时间） |
| 8 | 2 | 5 | 32 字节，5 个引用（可能是 checkpoint/分支/父会话） |
| 9 | 2 | 1 | 52 字节（可能是标题/元数据） |
| 10 | 0 | 1 | varint = 1（可能是 schema/版本） |
| 18 | 2 | 4 | 98~130 字节，疑似结构化元数据（模型/配置） |
| 21 | 2 | 1 | 53 字节 |
| 22 | 2 | 1 | 3 字节 |
| 26 | 0 | 1 | varint 1554448884（疑似毫秒时间戳/随机 id） |
| 27 | 2 | 1 | 13 字节 |
| 38 | 2 | 5 | 36 字节 ×5（疑似 UI/事件元数据） |
| 39 | 2 | 1 | 短字节 |

注意：`blobs` 有 248 个，但 root 只引用 153 个；其余可能是历史分支/附件内容。

## blob 的内部结构

- blob 是**未压缩的 protobuf**（不是 zstd/brotli/gzip；实测三种解压都失败）。
- 顶层只有 `field 1 (wire 2)`，内部嵌套消息包含：
  - 32 字节子引用（可能的子 blob / 附件）；
  - UUID 字符串（如 `c86a3548-…`）；
  - 工具/事件名（如 `SetActiveBranch`、`CreateGoal` 等字符串）；
  - 文本片段。
- 说明它是一棵 **content-addressed DAG**：每个 blob 可再引用子 blob，root 的 field 1 只列出顶层节点。

## 对 sessionport 的含义

1. **导出格式已确认**：`{version:1, name, conversationState, blobs, exportedAt}`；写入侧必须生成合法的
   conversationState protobuf 与 blobs，且 blob key = sha256(content)。
2. **从 IR 直接生成 export JSON 可行但成本高**：需要 Cursor 的 protobuf schema（conversationState 与
   blob 各消息类型）。这份 schema 未公开，可以从 app bundle 逆向，但属于长期维护接口。
3. **导入侧仍是 dev-only**（`isDevelopment || isDevUser` 前置条件），正式版用户无法调用；
   所以即使能生成 JSON，也不能作为稳定的用户级导入通道。
4. 因此现有策略不变：Claude/其他 agent → Cursor 用已验证的直接写 `state.vscdb`；
   Cursor → 其他 agent 继续用 DB reader。

## 可选后续

- 增加 `cursor-export:` 源：读取导出 JSON 作为 IR 输入（需要 protobuf schema 或文本提取启发式）。
- 若 Cursor 未来把 Import Chat 变成正式功能，再按本笔记生成 v1 导出。

## 样本安全

样本文件包含真实会话正文，**未入库**（位于 `~/Downloads`，属于用户数据）。
本笔记只保留结构统计与哈希/字段信息。
