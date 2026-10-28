# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are pre-1.0.

## [Unreleased]

### Added

- **Claude Code: native subagent linking.** Parent `tool_result` rows for subagents now carry a
  Claude-shaped `toolUseResult` (`status`, `agentId`, `agentType`, `prompt`, `content`,
  `resolvedModel`, `totalToolUseCount`, `canContinueAgent`), matching what Claude Code itself writes
  for Agent calls; `verifyClaudeSession` gained a `subagent-<id>-tool-use-result` check.

### Notes

- Claude Code 2.1.31x CLI does **not** render historical subagent transcripts when resuming a session
  (including in `Ctrl+O` transcript mode); native sessions behave the same. The transcripts are used by
  `/share` and background agents. We therefore treat file-level parity as the acceptance bar and record
  the UI limitation in `research/claude-code-subagents.md`.

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