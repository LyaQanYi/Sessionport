# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are pre-1.0.

## [Unreleased]

### Added

- **Cursor writer: native tool cards for shell / read / grep / glob / ls / delete.** Tool bubbles now
  carry `toolFormerData.toolCallBinary` (base64 of `agent.v1.ToolCall`) for every branch Cursor
  renders natively: `shell_tool_call` (1), `delete_tool_call` (3), `glob_tool_call` (4),
  `grep_tool_call` (5), `read_tool_call` (8), `edit_tool_call` (12, already shipped) and
  `ls_tool_call` (13). Encoders write the minimal schema-valid shape — args carry
  `command`/`path`/`pattern`/`output_mode`, results carry `exit_code`+`stdout`,
  `total_lines`+`path`, per-file grep hit counts, glob file lists, an `LsDirectoryTreeNode` tree,
  or the delete success/fileNotFound/error oneof. File bodies are deliberately not written: the app
  clears `ReadToolSuccess.content` and the edit before/after full contents before storing too, and
  grep gets counts but not matched line text, so nothing is fabricated. `verifyCursorSession`'s
  `toolformer-edit-binary` is now `toolformer-tool-call-binary`: every binary must decode, its oneof
  branch must match the `tool` enum and its key fields must agree with `params`; bubbles without a
  binary (native imports, edit/write without a diff) stay valid. Real-copy regression: a DSH session
  (853 bubbles / 461 tool bubbles) pushed into `.tmp/cursor-app-test` yields 321 binaries
  (shell 183, grep 86, read 52) and 31/31 verify checks PASS. Schema table and boundaries:
  `research/cursor-toolformer.md` §3.1/§3.2. Desktop card rendering is **not** verified — Cursor has
  no headless entry.

- **Reproducible verification matrix (`pnpm matrix`).** A script writes each source→target pair into an
  isolated target home and then loads the result with the target itself where an entry point exists:
  `claude --resume` TUI (expect + Ctrl+O capture), DSH headless (`--json --session-id`), and structural +
  SDK checks for Cursor/Qoder (no headless entry). Latest run covers 7 pairs: all structural PASS, four
  native loads (Claude ×3, DSH ×1). Results and known boundaries:
  `research/verification-matrix-2026-10-29.md`.

## [0.1.7] — 2026-10-28

npm: `sesport@0.1.7` (bins `sesport` / `sesp` / `sessionport`). Desktop dmg/zip attached to the
`v0.1.7` GitHub release.

### Added

- **Cursor writer: edit cards now render diffs in the desktop app.** Edit bubbles write
  `toolFormerData.toolCallBinary` (base64 of the `agent.v1.ToolCall` edit branch:
  `edit_tool_call.args.path` + `result.success{path, lines_added, lines_removed, diff_string}`) next to
  `additionalData.precomputedDiff`. Cursor only decodes the tool call from that binary when it loads a
  composer; without it the bubble degrades to a plain "Edited <file>" summary and the diff is never
  shown. `verifyCursorSession` gained `toolformer-edit-binary`; unit tests cover the encoder/decoder and
  the existing diff round-trip now asserts the binary payload. Verified visually: the real composer shows
  `README.md +1 −1` cards with red/green lines and a working diff viewer.

- **Qoder writer: native subagent write-back.** With `--include-children`,
  `writeQoderSession` now writes each IR child as
  `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl` plus
  `agent-<agentId>.meta.json` (`agentType` / `toolUseId?` / `description` /
  `invocationName`), matching the real qodercli 1.1.69 layout. Every row carries
  `sessionId` (the parent session), `agentId` and `isSidechain: true`; linked children
  add `parent_tool_use_id`. Child transcripts contain only `user`/`assistant` rows
  (no `active-leaf`/`last-prompt` control rows), the first user row uses the string
  `content` form observed in real files, and assistant rows keep the native snake-case
  `session_id`. `agentId` reuses the source `nativeSessionId` when legal
  (`^[A-Za-z0-9][A-Za-z0-9_-]*$`, ≤64 chars) and falls back to a salted sha256 prefix.
  `toolUseId` is only written when the parent transcript actually contains that
  `Agent` tool_use; otherwise the child is reported as `qoder.subagent-unlinked`
  (warning) instead of being linked to a non-existent call. `QODER_CAPS.subagents`
  is now `true`; the main transcript is unchanged.
- **Qoder reader: subagent title/profile from meta.json.** `readQoderSession` now maps
  `meta.json`'s `description` to the child title and `agentType` to
  `session.meta.profile` (previously the title fell back to the first user line and
  profile was unset). `verifyQoderSession` gained per-child checks (JSONL parses,
  `isSidechain`/`agentId`, parentUuid chain, parent session id, tool pairing,
  `meta.json` fields, and `meta.toolUseId` ↔ `parent_tool_use_id` ↔ parent transcript
  `tool_use`) plus optional `expectedChildren` meta matching;
  `verifyQoderRoundTrip` now also compares the written children (count / title /
  profile / via). Subagent runtimes stay honest: `subagents/task-*.json` is not
  written (it is transient CLI task bookkeeping and is not read by
  `listSubagents`/`getSubagentMessages`), and desktop UI rendering is unverified.

### Notes

- **Qoder desktop task list is not fed by local JSONL (2026-10-28 observation).** A valid imported
  session (with a linked subagent, `verify` all PASS) written into the real `~/.qoder-cn/projects` did
  not show up in the desktop workspace task list ("暂无任务"), while the Qoder SDK read the same file and
  its subagents fine. The UI has server-paginated task-list strings ("正在加载更多任务"), so local
  JSONL imports are CLI/SDK-visible only; the desktop UI limitation is recorded in
  `research/qoder-format.md` §4/§9.7.
- Verified against real Qoder data and the real Qoder SDK (asar, read-only): a real
  Qoder→Qoder import keeps `aExplore-…` agent ids and the SDK returns the linked
  `parent_tool_use_id`; a real WorkBuddy session with 11 subagents imports into an
  isolated Qoder home, reads back 11 children with matching titles, and passes
  `verify --agent qoder` (104 checks). `pnpm test` is 206 tests / 199 pass / 7 skip
  (7 new tests). See `research/qoder-format.md` §5/§6.1/§7.2.

## [0.1.6] — 2026-10-28

npm: `sesport@0.1.6` (bins `sesport` / `sesp` / `sessionport`). Desktop dmg/zip attached to the
`v0.1.6` GitHub release.

### Added

- **Claude Code reader: Edit/Write patches become IR `diff` blocks.** `toolUseResult.structuredPatch`
  (real Claude 2.1.312 field) is converted into a unified diff (`--- a/<repo-relative path>` +
  `@@ -old,count +new,count @@` + hunk lines) and appended to the `tool_result` event while keeping the
  original text. This gives Cursor's `additionalData.precomputedDiff` writeback a real source: a real
  Claude session with two edits imports into Cursor with `toolformer-edit-diff (withDiff=2 bad=0)` and
  reads back both diff blocks. See `research/claude-code-edit-patches.md`.

## [0.1.5] — 2026-10-28

npm: `sesport@0.1.5` (bins `sesport` / `sesp` / `sessionport`). Desktop dmg/zip attached to the
`v0.1.5` GitHub release.

### Added

- **Desktop ⌘K command palette.** Search sessions across every handled harness (title / path / agent /
  session id, tiered fuzzy match), jump to pages, refresh the session list, or cycle the theme — with
  keyboard navigation, aria roles and bilingual strings. A `SESSIONPORT_SMOKE_PALETTE` hook makes the
  palette screenshottable in headless mode.
- **Cursor writer: edit/write diff fidelity.** IR `tool_result` 里的 `{type:'diff'}` block 现在
  会编码成 Cursor 3.25.9 原生的 `additionalData.precomputedDiff`（`{lines,hasChanges}`，含跨
  hunk 的 `isSyntheticUnchanged` 空行），并给 header grouping 补 `editLinesAdded`/`editLinesRemoved`；
  reader 会把原生 `precomputedDiff` 还原成 IR `diff` block。没有 diff 时仍只写路径/结果并显式记
  `cursor.edit-diff-unavailable`。不写 `beforeContentId`/`afterContentId`/`composer.content` 全文
  blob（IR 没有可靠全文来源）。结构已验证；Cursor 无 headless 入口，UI diff 卡片未验证。详见
  `research/cursor-toolformer.md` §1.2。

### Changed

- **Claude Code writer**: children without a matching parent `Agent` tool_use (e.g. DSH imports, where
  subagents are independent sessions) now report a `claude.subagent-unlinked` warning instead of
  silently writing sidecars that the CLI will not surface under the parent conversation.
- **Docs**: `research/dogfooding-2026-10-28.md` records three real migrations done with the published
  0.1.4 CLI (Claude Code → DSH, WorkBuddy → Qoder, DSH → Claude Code), including the Qoder children gap.

## [0.1.4] — 2026-10-28

npm: `sesport@0.1.4` (bins `sesport` / `sesp` / `sessionport`). Desktop dmg/zip attached to the
`v0.1.4` GitHub release.

### Added

- **Claude Code: subagent calls now render in the CLI.** Parent `tool_result` rows for subagents carry a
  Claude-shaped `toolUseResult` including `totalToolUseCount`, `totalDurationMs`, `totalTokens` and a full
  `usage` object; `claude --resume` now shows `Done (N tool uses · X tokens · Ys)` under each Agent call
  (and `Prompt:` / `Response:` in `Ctrl+O` transcript mode). `verifyClaudeSession` checks the link plus
  the stats fields.

### Notes

- Subagent token counts are estimated from transcript text length (the IR has no usage data); tool-use
  counts and durations are real. Claude shows the subagent prompt/response summary, not its full message list.
  See `research/claude-code-subagents.md` for the exact `toolUseResult` field requirements.

## [0.1.3] — 2026-10-26

npm: `sesport@0.1.3` (bins `sesport` / `sesp` / `sessionport`). Desktop dmg/zip attached to the
`v0.1.3` GitHub release.

### Fixed

- `push --to claude-code --include-children` now forwards the flag (it was silently dropped, so
  children were never written), and `sync --to claude-code --home <dir>` maps to the adapter's
  `configDir` instead of ignoring the override and writing to `~/.claude`.

### Added

- **Claude Code writer: native subagent write-back.** With `--include-children`, `writeClaudeSession`
  now writes each IR child as `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl` plus
  `agent-<agentId>.meta.json` (`agentType` / `description` / `requestShape: foreground` /
  `requestNonInteractive: true` / `spawnDepth: 1` / `toolUseId`), instead of standalone top-level
  sessions. Every row carries `isSidechain: true` + `agentId`, the main `sessionId`, and a
  self-contained `parentUuid` chain. `readClaudeSession` restores the same children
  (title / profile / viaToolCallId); `verifyClaudeSession` checks the new files (including
  `expectedChildren` meta correspondence), and `CLAUDE_CAPS.subagents` is now `true`. The
  `claude.subagent-separate-session` loss is gone; unverified UI/resume behavior is reported as an
  info loss instead.

## [0.1.1] — 2026-10-22

First public release.

- npm package is **`sesport`** (`sesp` was rejected by npm as "too similar to existing packages"),
  with bins `sesport` / `sesp` / `sessionport`. The registry treats the CI publish as a staged
  release; the final `latest` tag points at `0.1.1`.
- GitHub repo: <https://github.com/LyaQanYi/Sessionport>; desktop dmg/zip attached to the
  `v0.1.1` GitHub release.

## [0.1.2] — 2026-10-22

npm: `sesport@0.1.2` (bins `sesport` / `sesp` / `sessionport`). Desktop dmg/zip attached to the
`v0.1.2` GitHub release; the app version is now aligned with the release version.

### Added

- **`pnpm typecheck` works and runs in CI.** `typescript` / `@types/node` are declared at the workspace
  root, and core exports a discriminated `IrEventInput` union so adapters no longer rely on
  `Omit<IrEvent, ...>` (which collapsed every event kind to its common fields). The fix surfaced and
  fixed two real bugs: opencode `verify` used a missing import, and the DSH header-frame check printed
  `NaN bytes`.
- **Desktop reader: sub-agent sessions.** Sessions that carry children (Claude Code's on-disk subagent
  transcripts, DSH's native sub agents, ...) now show a sub-agent list in the reader; clicking one loads its
  transcript with a "back to main session" action. The IPC read channel gains an optional `childId`.
- **Docs**: Chinese translations of [README](README.zh-CN.md), [CONTRIBUTING](CONTRIBUTING.zh-CN.md)
  and [SECURITY](SECURITY.zh-CN.md); English stays the default and each page links to the other.
- **Cursor: tool calls are now written as native `toolFormerData`** (previously dropped). Bubble
  values in `state.vscdb` are JSON, not protobuf — only `toolCallBinary` is protobuf, while
  `params`/`result` are protobuf-JSON strings. Shell/read/edit/write/grep/glob/list/delete/todo map
  to Cursor's native tools; a `tool_call` + `tool_result` pair becomes one capability-15 bubble;
  unsupported tools and orphan results stay explicit losses. IR round-trips through a
  `_sessionport` passthrough key that Cursor's loader ignores. `toolCallBinary` is deliberately not
  generated and edit diffs are unavailable; shell tool cards were manually confirmed to render
  command + output in Cursor 3.25.9. See `research/cursor-toolformer.md`.
- **Desktop i18n (zh-CN / en-US)**: zero-dependency dictionary (225 UI keys, typed so the English
  dictionary cannot drift), structured main-process error codes (`AppError` → `code`/`params`),
  English mappings for all current loss/notice codes, and Settings → Language
  (follow system / 中文 / English) persisted in localStorage. Also fixed two pre-existing main-process
  bugs found on the way: `spawn` and `existsSync` were used in `ipc.ts` without imports.

- **Claude Code reader: on-disk subagent transcripts.** Real Claude stores each subagent as
  `<sessionId>/subagents/agent-<agentId>.jsonl` (workflows nested one level deeper, with a
  `journal.jsonl`); these are now read as child sessions and take precedence over the in-file
  `isSidechain` mirror rows. `meta.json` supplies the child title (`description`), profile
  (`agentType`) and `viaToolCallId` (`toolUseId`); workflow labels become titles when there is no
  description. Verified on real data: a 101-subagent session reads in ~0.3 s.
  See `research/claude-code-subagents.md`.

## [0.1.0] — 2026-10-20

### Added

- **IR v0.1 + loss accounting**: append-only event stream with chained parents, plus a
  two-sided loss model (read notices vs export losses, split into accepted trade-offs
  and capability gaps).
- **Adapters (read/write/verify)**
  - Kimi Code (read)
  - Claude Code (write, resume verified)
  - Command Code (read/write, desktop registration, resume verified)
  - DeepSeek Harness (read/write, native workspace layout, headless replay verified)
  - Codex (read/write, threads + session index registration, resume verified)
  - opencode (read/write via export/import, resume verified)
  - Cursor (read/write: composerData/bubbleId keys in state.vscdb; imported composers are
    enumerated on restart — no headless resume, continuing is a manual send)
  - Qoder (read/write: ~/.qoder-cn/projects/*.jsonl; imported sessions verified through Qoder's
    own SDK listSessions/getSessionInfo/getSessionMessages)
  - WorkBuddy (read: ~/.workbuddy/projects/*.jsonl plus subagent transcripts)
  - Claude Code now also reads (readClaudeSession / listClaudeSessions), so it can be a
    migration source (e.g. Claude Code → Cursor).
  - Claude Code reader: in-file `isSidechain` rows are grouped into child sessions (agentId or
    parentUuid connectivity) instead of being skipped; main-session events stay byte-identical.
- **CLI**: `inspect`, `pull`, `push`, `sync`, `verify`, `list` with a sync registry
  and `import --into zcode|qoder` for reusing the target apps' own official migration flows
- **Desktop**: DSH import-mode selector (compressed / full / slim) and summary-engine selector
  (extractive / Claude / Codex, LLM opt-in) wired through preview + run;
  official-import cards on the migration page (open the target app, verify against its
  own store) alongside the direct-write loss-preview flow
  (`~/.sessionport/registry.json`) that refuses to overwrite turns added in the target app
  unless `--fork` or `--force`.
- **Desktop app** (`apps/desktop`, Electron 44): harness-centric sidebar, virtualised session
  browser grouped by project/time, transcript reader with notices and paged loading, and a
  migration flow with dry-run loss preview plus fresh/up-to-date/refresh/diverged decisions.
  Light and dark themes, adapters overview, settings with data-directory detection.
- **DSH `--slim` import**: truncates tool output/arguments, keeps only recent steps' tool events and drops
  reasoning for oversized sessions (each cut recorded as a loss), so migrations stay inside the target
  model's context window.
- **DSH `--summary-llm claude|codex` / `--summary-cmd`**: optional multi-round LLM summarization for compact
  imports, reusing an already-authenticated local CLI (prompt over stdin, extractive fallback on failure).
- **DSH `--compact` import**: keeps the full event log and writes a native DSH compaction chain
  (`compaction/start` → `summary` → checkpoint with `surfaceOp: replace` → `compaction/end`), so the model
  sees a summary plus recent steps while the whole history remains in the log and can be compacted again.
- **Distribution**: unsigned macOS `.app`/`.dmg` via electron-builder
  (`pnpm dist:desktop`), plus a CI packaging job.
- **Docs**: README, DESIGN decision log, CONTRIBUTING (adapter contract), SECURITY,
  ACKNOWLEDGEMENTS, and per-format research notes under `research/`.

### Notes

- Model bindings are intentionally not migrated; the target keeps its own default model.
- No telemetry; everything is local-first.