# sessionport

[![CI](https://github.com/sessionport/sessionport/actions/workflows/ci.yml/badge.svg)](https://github.com/sessionport/sessionport/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Move a live AI coding-agent session from one CLI to another — and keep going.**
A conversation started in Kimi Code becomes a Claude Code session you can `/resume`.
Not a pasted transcript, not a summarized context blob: a native session the target CLI loads by itself.

> **Status: alpha.** Six adapters work today (read/write/verify): `claude-code`, `command-code`,
> `dsh`, `codex`, `opencode` — plus `kimi-code` as a source. Every export prints exactly what it lost.
> Design notes: [DESIGN.md](./DESIGN.md). Format research: [research/](./research/).

## Why

Every agent CLI keeps its conversation history in a private format. Switching tools means losing the thread.
Existing tools either translate one direction, or re-feed a summarized context blob. sessionport does neither:

- **IR**: a normalized append-only event stream (`message` / `reasoning` / `tool_call` / `tool_result` / `boundary`), chained by `parentId`.
- **Adapters**: one per agent, responsible only for `native -> IR` and `IR -> native`.
- **Loss list**: every export reports what could not be preserved, and whether it is a design trade-off or a known gap.
- **Native resume**: the only acceptance test that matters — the target CLI must load the session and continue it.

## Quick start

Requires Node >= 22.18 (TypeScript runs directly via built-in type stripping; no build step).

```bash
git clone https://github.com/sessionport/sessionport && cd sessionport
pnpm install

# 1. What is in this session?
node packages/cli/src/index.ts inspect "kimi:./session_fdefc84f-.../"

# 2. Port it (writes a native session for the target CLI)
node packages/cli/src/index.ts push "kimi:./session_fdefc84f-.../" --to claude-code

# 3. Prove the target can resume it (real model call)
node packages/cli/src/index.ts verify --agent claude-code --cwd /path/to/project --id <session-id> --resume

# The whole chain, both directions, in one shot:
./scripts/demo.sh              # Kimi -> Claude Code
./scripts/demo-interop.sh      # Command Code <-> DeepSeek Harness
```

### Re-push safely

`sync` never silently overwrites turns you added in the target app:

```bash
node packages/cli/src/index.ts sync "dsh:<session-dir>" --to command-code --register
```

| Situation | Behaviour |
|---|---|
| first push / target file gone | fresh write |
| source and target unchanged | **no write** (idempotent) |
| source grew, target untouched | rewrite + update registry |
| **target grew** (you continued there) | **refused**; `--fork` keeps the old session, `--force` overwrites |

State lives in `~/.sessionport/registry.json` (`--state <dir>` to override).

## Supported agents

| Agent | Read | Write | Resume verified | Against |
|---|---|---|---|---|
| Kimi Code | ✅ `state.json` + `agents/*/wire.jsonl` | — | source only | CLI 2.1.1 / format v2 |
| Claude Code | — | ✅ JSONL session files | ✅ `claude -p --resume` | CLI 2.1.303 |
| Command Code | ✅ `projects/<slug>/<uuid>.jsonl` | ✅ + desktop registration | ✅ `cmd -p --session` | 1.82.3 |
| DeepSeek Harness | ✅ multi-frame zstd event log | ✅ native workspace layout | ✅ headless load + replay | 5.8.3 (format v4) |
| Codex | ✅ `sessions/**/rollout-*.jsonl` | ✅ + `threads` / index registration | ✅ `codex exec resume` | 0.163.0 |
| opencode | ✅ `opencode export` JSON | ✅ `opencode import` | ✅ `opencode run --session` | 1.19.3 |

Sub-agent sessions: pass `--include-children`. DSH keeps the native parent/child tree; Claude Code and
Command Code have no parent concept, so children are written as independent sessions (content preserved,
relationship reported as lost).

## How fidelity works

Reading and writing are asymmetric, so losses are tracked separately:

- **notices** (per session, on read): what the source had but IR does not model — UI mirrors, runtime/config events,
  harness-injected messages, reverted turns.
- **losses** (per export, on write): what IR had but the target cannot represent.

Losses are either **accepted design trade-offs** (no mapping exists, or we deliberately do not carry it — e.g. model
bindings are never migrated; the target keeps its own default model and system prompt) or **actionable capability gaps**
(sub-agent relationships on targets without sidechains, image attachments, branch boundaries). See
[DESIGN.md §6.1](./DESIGN.md).

## Commands

```
sessionport inspect <source>
sessionport pull  <source> [--out ir.json]
sessionport push  <source> --to <agent> [options]
sessionport sync  <source> --to <agent> [options]
sessionport verify --agent <agent> [options]
```

Sources: `kimi:<dir>`, `commandcode:<path|id>`, `dsh:<dir>`, `codex:<path|id>`, `opencode:<path|id>`, or an IR `.json`.
Targets: `claude-code`, `command-code`, `dsh`, `codex`, `opencode`.

Registers into the target app instead of just writing files: `--register` (Command Code desktop list / DSH workspace /
Codex `threads` + `session_index.jsonl`).

## Desktop app (early)

An Electron shell lives in `apps/desktop` — the renderer never touches the filesystem; all adapter work happens in
the main process (which imports the same `@sessionport/*` packages as the CLI).

```bash
pnpm install
pnpm dev:desktop     # electron-vite dev (opens a window)
pnpm build:desktop   # production bundles -> apps/desktop/out

# headless smoke (no window; useful in CI)
cd apps/desktop && SESSIONPORT_SMOKE=1 ./node_modules/.bin/electron .
```

Current screens: session browser (all agents), reader (IR events, notices, resume command), migration with
dry-run loss preview before writing. IPC is a small typed allow-list with zod validation in the main process.

## Architecture

```
packages/
├── core/                 # IR schema, loss collector, sync registry, sync planning
├── adapters/
│   ├── kimi-code/        # read
│   ├── claude-code/      # write + verify
│   ├── command-code/     # read/write/verify + desktop registration
│   ├── dsh/              # read/write/verify + workspace registration
│   ├── codex/            # read/write/verify + threads registration
│   └── opencode/         # read/write/verify + import/export
├── cli/                  # inspect / pull / push / sync / verify
└── e2e fixtures live in each adapter’s test/ folder

apps/
└── desktop/              # Electron shell (React + Vite + Tailwind + TanStack Query)
```

## Development

```bash
pnpm install
node --test packages/core/test/*.test.ts packages/adapters/*/test/*.test.ts packages/cli/test/*.test.ts
```

Live resume smoke tests are gated (they cost real model calls):

```bash
SESSIONPORT_CC_RESUME=1     pnpm test   # Command Code
SESSIONPORT_CODEX_RESUME=1  pnpm test   # Codex
SESSIONPORT_OPENCODE_RESUME=1 SESSIONPORT_OPENCODE_MODEL=opencode-go/glm-5.2 pnpm test   # opencode
```

## Contributing & security

Adapter contributions must include golden fixtures with the CLI version they were verified against —
see [CONTRIBUTING.md](./CONTRIBUTING.md). Please report vulnerabilities per [SECURITY.md](./SECURITY.md).

Session logs contain prompts, code, and sometimes secrets: sessionport is local-first with zero telemetry.

## License

[Apache-2.0](./LICENSE).