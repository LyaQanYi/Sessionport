# sessionport

Move an AI coding-agent session from one CLI to another and keep going.
A conversation started in Kimi Code becomes a Claude Code session you can `/resume` — natively, not as a pasted transcript.

> **Status: alpha, vertical slice.** Two adapters exist today: `kimi-code` (read) and `claude-code` (write + verify).
> The design and roadmap live in [DESIGN.md](./DESIGN.md); the format research lives in [research/agent-formats.md](./research/agent-formats.md).

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

## Supported formats

| Agent | Read | Write | Verified against |
|---|---|---|---|
| Kimi Code | ✅ `state.json` + `agents/*/wire.jsonl` | — | CLI 2.1.1 / session format v2 / wire protocol 1.5 |
| Claude Code | — | ✅ JSONL session files | CLI 2.1.303 |
| Codex | planned | planned | — |
| opencode | planned | planned | — |

## How fidelity is handled

Reading and writing are asymmetric, so losses are tracked separately:

- **`notices`** (per session, on read): what the source had but IR does not model — e.g. Kimi's UI message mirror, runtime/config events, and turns reverted by `undo` (reverted turns are cut so the target sees the post-undo context).
- **`losses`** (per export, on write): what IR had but the target cannot represent — dropped thinking blocks, dropped sub-agent sessions, collapsed branch boundaries.

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
