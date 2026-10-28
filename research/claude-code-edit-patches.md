# Claude Code：Edit/Write 的 structuredPatch → IR diff

最后验证：2026-10-28（Claude Code 2.1.312 真实数据）

## 数据来源

Claude Code 的 Edit / Write 工具结果行（type=user，content 里是 tool_result）带一个结构化的
`toolUseResult`：

```json
{
  "type": "update",
  "filePath": "/abs/path/src/app.ts",
  "oldString": "...",
  "newString": "...",
  "originalFile": null,
  "userModified": false,
  "replaceAll": false,
  "structuredPatch": [
    { "oldStart": 46, "oldLines": 6, "newStart": 46, "newLines": 9,
      "lines": [" const X = 1;", "-old line", "+new line", " ", " /**"] }
  ]
}
```

Write（新建文件）的形态是 `type: "create"` + `content` + `structuredPatch: []`，没有 diff。

## 读取实现

`packages/adapters/claude-code/src/read.ts` 的 `structuredPatchDiff`：

- 把每个 hunk 转成标准统一 diff：`--- a/<path>`、`+++ b/<path>`、
  `@@ -oldStart,oldLines +newStart,newLines @@`，随后原样保留 `lines`（含 ` `/`+`/`-` 前缀）；
- 路径优先转成相对会话 cwd 的形式，避免 `a//Users/...`；
- 作为 `{ type: 'diff', text }` 追加到 `tool_result` 事件的 content 末尾（原文本结果保留）；
- 空 `structuredPatch`（新建文件）不生成 diff；没有该字段时也不凭空生成。

## 端到端验证

真实会话 `claude:f2e8af7e-05d6-4d16-ae93-3def418b7a0a`（2 个 hunk，README.md / README.zh-CN.md）：

```bash
# 1) Claude -> IR：reader 产出 2 个 diff block
# 2) 写 Cursor（隔离副本库 .tmp/cursor-app-test）
node packages/cli/src/index.ts push "claude:f2e8af7e-…" --to cursor \
  --home .tmp/cursor-app-test --confirm-real
```

结果：

- Cursor verify：**全 PASS**，其中 `toolformer-edit-diff (withDiff=2 bad=0)`；
- 读回：`diff blocks 2`（105 events），说明 `precomputedDiff` 能被 reader 还原成 IR diff；
- 损失清单：`cursor.edit-diff-mapped x2`（信息），不再出现 `cursor.edit-diff-unusable`。

## 已知边界

- 只映射 `structuredPatch`；`result.diff`（FileDiff chunks）真实样本 0 次且 UI 不读，不写。
- 不写 before/after 全文 blob（`beforeContentId`/`afterContentId`/`composer.content`）：IR 没有可靠全文来源。
- 多文件 diff：Claude 每个 tool_result 只对应一个文件；IR 端多个 diff block 时 Cursor 只取第一个（已记 loss）。
- UI 仍未人工验证（Cursor 无 headless 入口）。
