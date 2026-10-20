# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are pre-1.0.

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
- **CLI**: `inspect`, `pull`, `push`, `sync`, `verify`, `list` with a sync registry
  (`~/.sessionport/registry.json`) that refuses to overwrite turns added in the target app
  unless `--fork` or `--force`.
- **Desktop app** (`apps/desktop`, Electron 44): harness-centric sidebar, virtualised session
  browser grouped by project/time, transcript reader with notices and paged loading, and a
  migration flow with dry-run loss preview plus fresh/up-to-date/refresh/diverged decisions.
  Light and dark themes, adapters overview, settings with data-directory detection.
- **Distribution**: unsigned macOS `.app`/`.dmg` via electron-builder
  (`pnpm dist:desktop`), plus a CI packaging job.
- **Docs**: README, DESIGN decision log, CONTRIBUTING (adapter contract), SECURITY,
  ACKNOWLEDGEMENTS, and per-format research notes under `research/`.

### Notes

- Model bindings are intentionally not migrated; the target keeps its own default model.
- No telemetry; everything is local-first.