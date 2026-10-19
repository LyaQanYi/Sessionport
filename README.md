# sessionport

Move an AI coding-agent session from one CLI to another and keep going.
A conversation started in Kimi Code becomes a Claude Code session you can `/resume` — natively, not as a pasted transcript.

> **Status: alpha, vertical slice.** Two adapters exist today: `kimi-code` (read) and `claude-code` (write + verify).
> The design and roadmap live in [DESIGN.md](./DESIGN.md); the format research lives in [research/agent-formats.md](./research/agent-formats.md).
>
> **Verified end-to-end (2026-10-19)**: a real Kimi Code session (92 events + 1 sub-agent, 92 events) was converted
> into a 45-row Claude Code transcript and `claude -p --resume <id>` returned `RESUME_OK` — the model answered from the
> ported history. See [research/claude-code-resume-spec.md](./research/claude-code-resume-spec.md) for the load contract.

## Why

Every agent CLI keeps its conversation history in a private format. Switching tools means losing the thread.
Existing tools either translate one direction, or re-feed a summarized context blob. sessionport does neither:

- **IR (intermediate representation)**: a normalized append-only event stream (`message` / `reasoning` / `tool_call` / `tool_result` / `boundary`), chained by `parentId`.
- **Adapters**: one per agent, responsible only for `native → IR` and `IR → native`.
- **Loss list**: every export prints exactly what could not be preserved. Nothing is dropped silently.
- **Native resume**: the only acceptance test that matters is "the target CLI can resume it and continue".

## Quick start

```bash
pnpm install

# 1. Inspect a Kimi Code session (an exported bundle or the native session directory)
node packages/cli/src/index.ts inspect kimi:./session_<uuid>/

# 2. Convert it into IR
node packages/cli/src/index.ts pull kimi:./session_<uuid>/ --out session.ir.json

# 3. Write it as a Claude Code session
node packages/cli/src/index.ts push session.ir.json --to claude-code

# 4. Structural verification (fast, offline)
node packages/cli/src/index.ts verify --cwd /path/to/project --session-id <uuid>

# 5. Real resume smoke test (calls the model once)
node packages/cli/src/index.ts verify --cwd /path/to/project --session-id <uuid> --resume
```

`push` writes to `$CLAUDE_CONFIG_DIR/projects/<project-slug>/<session-id>.jsonl`
(`~/.claude` by default; point `--config-dir` elsewhere for isolated tests).

### Sample report

```
target      claude-code
rows        45
written     events=92 messages=27 tool_calls=21 tool_results=21 reasoning=18
losses
  [warning] claude.reasoning-dropped x18 — thinking / reasoning 块未导出（Claude 要求带 Anthropic 签名的 thinking 块，跨源无法伪造）
  [warning] claude.subagent-dropped x1 — 子代理会话未导出（Claude 的 sidechain 行内语义尚未实现）
  [info] claude.boundary-dropped x5 — 会话边界事件（分支/撤销/压缩/取消）在 Claude 中没有对应结构
```

### Command Code ↔ DeepSeek Harness 互传

```bash
# Command Code -> DSH（隔离 DSH_HOME，确认无误后再指向 ~/.dsh）
node packages/cli/src/index.ts push "commandcode:$HOME/.commandcode/projects/<slug>/<uuid>.jsonl" \
  --to dsh --home .tmp/dsh-home

# DSH -> Command Code（transcript 落在任意目录即可直接 resume）
node packages/cli/src/index.ts push "dsh:$HOME/.dsh/sessions/--<workspace>--/session-<uuid>" \
  --to command-code --home .tmp/cc-home

# 一条命令跑通双向（含结构校验）
./scripts/demo-interop.sh
```
### 导入到真实的 app 数据目录

```bash
# DSH：--home 指向 ~/.dsh，--register 让运行中的 app 重启后立刻看到
node packages/cli/src/index.ts push "commandcode:<transcript>" \
  --to dsh --home "$HOME/.dsh" --register

# 重启 DSH 应用后，会话会出现在对应 workspace 下（projcache 由 app 重建）
```
## Supported formats

| Agent | Read | Write | Resume verified | Against |
|---|---|---|---|---|
| Kimi Code | ✅ `state.json` + `agents/*/wire.jsonl` | — | n/a (source only) | CLI 2.1.1 / session format v2 / wire protocol 1.5 |
| Claude Code | — | ✅ JSONL session files | ✅ real `claude -p --resume` | CLI 2.1.303 |
| Command Code | ✅ `projects/<slug>/<uuid>.jsonl` | ✅ same layout + `.meta.json` | ✅ real `cmd -p --session <path>` | 1.82.3 |
| DeepSeek Harness | ✅ `session.v4.jsonl.zstd` (multi-frame zstd) | ✅ same + workspace layout | ✅ headless load + full turn replay | 5.8.3 (format v4) |
| Codex | planned | planned | — | — |
| opencode | planned | planned | — | — |

## How fidelity is handled

Reading and writing are asymmetric, so losses are tracked separately:

- **`notices`** (per session, on read): what the source had but IR does not model — e.g. Kimi's UI message mirror, runtime/config events, and turns reverted by `undo` (reverted turns are cut so the target sees the post-undo context).
- **`losses`** (per export, on write): what IR had but the target cannot represent — dropped thinking blocks, dropped sub-agent sessions, collapsed branch boundaries.

Losses are either **accepted design trade-offs** (no mapping exists, or we deliberately don't carry it —
e.g. model bindings are not migrated, the target keeps its own default model and system prompt) or
**actionable capability gaps** (sub-agent sessions, image attachments, branch boundaries). The former is
reported but never "fixed"; the latter is roadmap work and must come with a verification case. See
[DESIGN.md §6.1](./DESIGN.md).

## Privacy

Session logs contain prompts, code, and sometimes secrets. sessionport is local-first with zero telemetry.
Exported Kimi bundles include diagnostic logs by default (`kimi export --no-include-global-log` disables the global log);
those files are not part of the conversation and adapters ignore them.

## Development

```bash
node --test packages/core/test/*.test.ts packages/adapters/*/test/*.test.ts
```

Requires Node >= 22.18 (TypeScript is executed directly via Node's built-in type stripping; no build step).

## License

Apache-2.0