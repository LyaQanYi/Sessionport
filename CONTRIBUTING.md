# Contributing to sessionport

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping. sessionport exists because session formats are private and change constantly — the
project is designed so that **adding an adapter is a bounded, reviewable job**, and so that no adapter can
silently lose data.

## Ground rules

1. **Local-first, zero telemetry.** No network calls in adapters; nothing leaves the machine.
2. **Never commit real session content.** Fixtures must be sanitized (replace message text, paths, tool output)
   and may live under `fixtures/private/` (gitignored) during development.
3. **No silent losses.** Anything an adapter cannot carry must be reported through the loss collector.
4. **Runtime dependencies stay minimal.** Prefer Node built-ins (`node:*`). New dependencies need a reason
   in the PR description.

## Development setup

Requires **Node >= 24** (TypeScript is executed via Node’s type stripping — no build step) and pnpm.

```bash
pnpm install
node --test packages/core/test/*.test.ts packages/adapters/*/test/*.test.ts packages/cli/test/*.test.ts
```

Live resume smoke tests cost real model calls and are gated by environment variables, e.g.
`SESSIONPORT_CC_RESUME=1`, `SESSIONPORT_CODEX_RESUME=1`, `SESSIONPORT_OPENCODE_RESUME=1`.
They must never be required for a normal `pnpm test` run.

## The adapter contract

Adapters translate only `native <-> IR`; they do not know about each other. See
[DESIGN.md §6](./DESIGN.md) for the full rationale. The practical shape:

- `src/wire.ts` — types and parsing for the native format (tolerant: unknown fields are ignored, unknown
  rows are skipped and counted).
- `src/read.ts` — `readXxxSession(input, options): Promise<IrBundle>`. Chooses the source (path/id), maps
  events, records `notices` for anything dropped while reading.
- `src/write.ts` — `writeXxxSession(bundle, options): Promise<WriteReport>` with `rows`, `paths` and a sorted
  `losses` list. Support `dryRun` (generate without writing).
- `src/verify.ts` — structural checks (`{ name, ok, detail }[]`) plus an optional headless resume smoke.
- `src/index.ts` — exports; keep names consistent with the other adapters.

A new adapter is done when all of these exist:

- [ ] reader against a real (sanitized) fixture, with a test that skips when the fixture is absent
- [ ] writer round-trip: IR -> native -> IR keeps the conversation and tool pairing
- [ ] `verify` returns a check list that fails loudly on malformed output
- [ ] **a real resume proof**: the exact command, the target CLI version, and the observed output
- [ ] CLI wiring (`loadBundle`, `writeTarget`, `countTarget`, verify branch) + package dependency
- [ ] `research/<agent>-format.md` documenting the format as you found it (what you verified, what you did not)

## Loss-list conventions

Every dropped thing gets one entry, added through the core `LossCollector`:

```ts
losses.add('codex.reasoning-opaque', 'reasoning is encrypted and cannot be replayed', { severity: 'warning' });
```

- Codes are `<agent>.<what>-<why>`; the message is written for users, not developers.
- `severity: "info"` = design trade-off or harmless normalisation; `"warning"` = content the user would notice.
- If the target genuinely has no concept for something, say so and keep it as a **design trade-off**.
  If it is something a future version could carry, list it under **capability gaps** in the PR.

## Version registry

Formats drift. Every adapter records what it was verified against (CLI version and/or format version) in the
research document and in tests. If the local CLI version is not in the verified set, the adapter should still
work but must be honest about it: add a notice/loss and mention the untested version in the report.

## Pull requests

Small, focused PRs. In the description include:

1. what the adapter covers (and what it deliberately does not),
2. the exact resume command and its output,
3. a sample loss list,
4. the CLI version you tested against.

By contributing you agree your work is licensed under [Apache-2.0](./LICENSE).
