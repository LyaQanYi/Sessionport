# Security policy

**English** | [简体中文](SECURITY.zh-CN.md)

sessionport works on files that contain **prompts, source code, tool output and sometimes secrets**.
It is local-first: adapters never make network calls and there is no telemetry. The only network traffic
comes from the target CLIs when *you* ask them to resume a session.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub’s private vulnerability reporting on
the repository (Security → Report a vulnerability) or contact the maintainers directly. Include a
minimal reproduction and the affected adapter/version.

## Scope

In scope: path traversal or arbitrary file writes driven by session content, unsafe deserialisation of
session files, loss-of-data bugs that can destroy a user’s target-side conversation, accidental credential
exposure in reports or logs.

Out of scope: the security posture of the agent CLIs themselves, and the fact that imported sessions can
contain everything the source session contained.

## Handling of session data

- sessionport reads session stores read-only by default; it writes only when you run `push` / `sync`.
- Desktop registrations (Command Code, DSH) back up the index files they modify under `.tmp/cc-backups/`.
- Golden fixtures must be sanitized before they are committed; see [CONTRIBUTING.md](./CONTRIBUTING.md).
- `.sessionport/registry.json` stores source identifiers and target paths — no message content.

## Hardening suggestions

- Treat exported IR JSON as sensitive: it contains the full conversation.
- Run `git diff` before committing anything that came out of a session store.
- Prefer `--dry-run` first when pointing sessionport at a production home directory.
