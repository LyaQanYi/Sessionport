#!/usr/bin/env node
// Probe harness: write synthetic Claude Code session JSONL, resume headlessly against
// the local mock Anthropic API, and report exactly what context Claude replayed.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const SPIKE = path.dirname(TOOLS);
const HOME = path.join(SPIKE, "home");
const CWD = path.join(SPIKE, "tmp");
const EVIDENCE = path.join(SPIKE, "evidence");
const MOCK_LOG = path.join(TOOLS, "mock-requests.jsonl");
const CACHE_LOG = path.join(TOOLS, "mock-cache.jsonl");

const MOCK_ENV = {
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:18999",
    ANTHROPIC_AUTH_TOKEN: "mock-token",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-5-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-opus-5-5",
  },
};
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const PROJECT_DIR = path.join(HOME, "projects", slug(CWD));

function iso(offsetSec = 0) {
  return new Date(Date.parse("2026-10-19T05:00:00.000Z") + offsetSec * 1000).toISOString();
}

let counter = 0;
function newUUID() {
  counter++;
  return "aaaaaaaa-bbbb-4ccc-8ddd-" + String(counter).padStart(12, "0");
}

function newSessionId() {
  counter++;
  return "99999999-8888-4777-8666-" + String(counter).padStart(12, "0");
}

function userLine(opts) {
  const { sid, uuid, parentUuid = null, content, cwd = CWD, extra = {}, omit = {} } = opts;
  const line = {
    parentUuid,
    isSidechain: false,
    promptId: "prompt-" + uuid,
    type: "user",
    message: { role: "user", content },
    uuid,
    timestamp: iso(opts.t || 0),
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId: sid,
    version: "2.1.303",
    gitBranch: "HEAD",
    ...extra,
  };
  for (const k of Object.keys(omit)) if (omit[k]) delete line[k];
  return line;
}

function assistantLine(opts) {
  const { sid, uuid, parentUuid, content, cwd = CWD, extra = {}, messageExtra = {}, omit = {} } = opts;
  const line = {
    parentUuid,
    isSidechain: false,
    message: {
      id: "msg_" + uuid.slice(-6),
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      ...messageExtra,
    },
    apiBlockIndex: 0,
    requestedModel: "claude-opus-5-5",
    type: "assistant",
    uuid,
    timestamp: iso((opts.t || 0)),
    effort: "high",
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId: sid,
    version: "2.1.303",
    gitBranch: "HEAD",
    ...extra,
  };
  for (const k of Object.keys(omit)) if (omit[k]) delete line[k];
  return line;
}

const SECRET = "ZAPHIR-4471";
const SECRET_PROMPT = "What is the secret word? Reply with exactly the secret word.";

function baseTranscript(sid) {
  const u1 = newUUID();
  const u2 = newUUID();
  return {
    ids: { u1, u2 },
    lines: [
      userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + ". Remember it." }),
      assistantLine({ sid, uuid: u2, parentUuid: u1, content: [{ type: "text", text: "Understood. The secret word is " + SECRET + "." }] }),
    ],
  };
}

function summariseContent(content) {
  if (typeof content === "string") return "text:" + JSON.stringify(content.slice(0, 120));
  if (!Array.isArray(content)) return JSON.stringify(content).slice(0, 80);
  return content.map((b) => {
    if (b.type === "text") return "text:" + JSON.stringify((b.text || "").slice(0, 120));
    if (b.type === "thinking") return "thinking(len=" + (b.thinking || "").length + ",sigLen=" + (b.signature ? b.signature.length : "none") + ")";
    if (b.type === "tool_use") return "tool_use(" + b.name + "," + b.id + ")";
    if (b.type === "tool_result") return "tool_result(" + b.tool_use_id + ")";
    return b.type;
  }).join(" | ");
}

function runResume({ uuid, prompt = SECRET_PROMPT, sessionDir = PROJECT_DIR, extraArgs = [], useMock = true, timeoutMs = 120000, debug = false, debugName = "run" }) {
  fs.mkdirSync(sessionDir, { recursive: true });
  try { fs.writeFileSync(MOCK_LOG, ""); } catch {}
  const args = ["-p", "--resume", uuid, "--output-format", "json"];
  let debugFile = null;
  if (debug) {
    debugFile = path.join(EVIDENCE, "debug-" + debugName + ".log");
    args.push("--debug-file", debugFile);
  }
  if (useMock) args.push("--settings", JSON.stringify(MOCK_ENV));
  args.push(...extraArgs, prompt);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: HOME,
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const started = Date.now();
  const r = spawnSync("claude", args, { cwd: CWD, env, encoding: "utf8", timeout: timeoutMs });
  const elapsed = Date.now() - started;
  let stdoutJson = null;
  try { stdoutJson = JSON.parse(r.stdout); } catch {}
  let replay = [];
  let rawRequests = [];
  try {
    rawRequests = fs.readFileSync(MOCK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {}
  const apiReqs = rawRequests.filter((x) => (x.url || "").includes("/v1/messages") && x.body && Array.isArray(x.body.messages));
  // main request = the one containing the resume prompt, prefer most messages
  const containing = apiReqs.filter((x) => JSON.stringify(x.body.messages).includes(prompt.slice(0, 30)));
  const main = containing.sort((a, b) => b.body.messages.length - a.body.messages.length)[0] || apiReqs.sort((a, b) => b.body.messages.length - a.body.messages.length)[0];
  if (main) {
    replay = main.body.messages.map((m) => ({ role: m.role, content: summariseContent(m.content) }));
  }
  const replayText = JSON.stringify(replay);
  return {
    resumed: r.status === 0 && stdoutJson && stdoutJson.type === "result" && !stdoutJson.is_error,
    exitCode: r.status,
    elapsedMs: elapsed,
    resultText: stdoutJson ? stdoutJson.result : null,
    numTurns: stdoutJson ? stdoutJson.num_turns : null,
    sessionId: stdoutJson ? stdoutJson.session_id : null,
    stderr: (r.stderr || "").slice(0, 3000),
    stdoutText: (r.stdout || "").slice(0, 500),
    apiRequests: apiReqs.length,
    replay,
    debugFile,
    secretInReplay: replayText.includes(SECRET),
    replayAssistantCount: replay.filter((m) => m.role === "assistant").length,
    replayUserCount: replay.filter((m) => m.role === "user").length,
    rawRequests,
  };
}

function writeLines(lines, { uuid = newSessionId(), dir = PROJECT_DIR, extraRaw = [], trailingNewline = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, uuid + ".jsonl");
  const all = [...lines, ...extraRaw];
  const body = all.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (trailingNewline && all.length ? "\n" : "");
  fs.writeFileSync(file, body);
  return { file, uuid };
}

const experiments = [];
function experiment(name, fn) { experiments.push({ name, fn }); }

// ------------------------- experiments -------------------------
experiment("00_baseline_full_2turn", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

experiment("01_single_user_line_only", () => {
  const sid = newSessionId();
  const u1 = newUUID();
  const lines = [userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + ". Remember it." })];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

experiment("02_drop_social_meta_fields", () => {
  // drop userType/entrypoint/cwd/version/gitBranch, keep chain+uuid+timestamp+sessionId+message
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const omit = { userType: true, entrypoint: true, cwd: true, version: true, gitBranch: true };
  const trimmed = lines.map((l, i) => {
    const c = JSON.parse(JSON.stringify(l));
    for (const k of Object.keys(omit)) delete c[k];
    if (i === 1) { delete c.apiBlockIndex; delete c.requestedModel; delete c.effort; delete c.isSidechain; }
    return c;
  });
  const { uuid } = writeLines(trimmed, { uuid: sid });
  return runResume({ uuid });
});

experiment("03_drop_uuid_and_parentUuid", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const trimmed = lines.map((l) => { const c = JSON.parse(JSON.stringify(l)); delete c.uuid; delete c.parentUuid; return c; });
  const { uuid } = writeLines(trimmed, { uuid: sid });
  return runResume({ uuid });
});

experiment("04_drop_timestamp", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const trimmed = lines.map((l) => { const c = JSON.parse(JSON.stringify(l)); delete c.timestamp; return c; });
  const { uuid } = writeLines(trimmed, { uuid: sid });
  return runResume({ uuid });
});

experiment("05_drop_sessionId_field", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const trimmed = lines.map((l) => { const c = JSON.parse(JSON.stringify(l)); delete c.sessionId; return c; });
  const { uuid } = writeLines(trimmed, { uuid: sid });
  return runResume({ uuid });
});

experiment("06_sessionId_mismatch_filename", () => {
  const sid = newSessionId();
  const otherSid = newSessionId();
  const { lines } = baseTranscript(sid); // lines carry sid, filename will be otherSid
  const { uuid } = writeLines(lines, { uuid: otherSid });
  return runResume({ uuid });
});

experiment("07_unknown_and_malformed_lines", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const extraRaw = [
    { type: "some-unknown-future-line", foo: 1 },
    "{ this is not json",
    { type: "cost-state", sessionId: sid, totalCostUSD: 0 },
    { type: "last-prompt", leafUuid: lines[1].uuid, sessionId: sid },
  ];
  const { uuid } = writeLines(lines, { uuid: sid, extraRaw });
  return runResume({ uuid });
});

experiment("08_parent_chain_broken", () => {
  // 2 turns; assistant's parentUuid points to a nonexistent uuid; user line present.
  const sid = newSessionId();
  const { lines, ids } = baseTranscript(sid);
  lines[1].parentUuid = "deadbeef-0000-4000-8000-000000000000";
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

experiment("09_no_parentUuid_only", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  for (const l of lines) l.parentUuid = null;
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

experiment("10_min_guess", () => {
  // guess at true minimum: type/message/uuid/parentUuid/sessionId/timestamp only
  const sid = newSessionId();
  const u1 = newUUID();
  const u2 = newUUID();
  const lines = [
    { parentUuid: null, type: "user", message: { role: "user", content: "The secret word is " + SECRET + ". Remember it." }, uuid: u1, timestamp: iso(0), sessionId: sid },
    { parentUuid: u1, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Understood. The secret word is " + SECRET + "." }] }, uuid: u2, timestamp: iso(1), sessionId: sid },
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});


// ===================== phase 2: timestamps =====================
function baselineVariant(sid, mutate) {
  const { lines } = baseTranscript(sid);
  return mutate(lines, sid);
}
experiment("ts_user_missing", () => {
  const sid = newSessionId();
  const lines = baselineVariant(sid, (ls) => { delete ls[0].timestamp; return ls; });
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("ts_assistant_missing", () => {
  const sid = newSessionId();
  const lines = baselineVariant(sid, (ls) => { delete ls[1].timestamp; return ls; });
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid, debug: true, debugName: "ts_assistant_missing" });
});
experiment("ts_assistant_null", () => {
  const sid = newSessionId();
  const lines = baselineVariant(sid, (ls) => { ls[1].timestamp = null; return ls; });
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("ts_assistant_epoch_number", () => {
  const sid = newSessionId();
  const lines = baselineVariant(sid, (ls) => { ls[1].timestamp = Date.parse(iso(1)); return ls; });
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("ts_assistant_invalid_string", () => {
  const sid = newSessionId();
  const lines = baselineVariant(sid, (ls) => { ls[1].timestamp = "not-a-date"; return ls; });
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

// ===================== chain semantics =====================
experiment("chain_3_full", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u2 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "text", text: "Noted." }], t: 1 }),
    userLine({ sid, uuid: u2, parentUuid: a1, content: "Also remember the number 42.", t: 2 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("chain_branch_last_wins", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u2 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "text", text: "Noted." }], t: 1 }),
    userLine({ sid, uuid: u2, parentUuid: u1, content: "Branch: ignore the assistant.", t: 2 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("chain_unlinked_last", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u3 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "text", text: "Noted." }], t: 1 }),
    userLine({ sid, uuid: u3, parentUuid: null, content: "Unlinked tail record.", t: 2 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("chain_lastprompt_stale", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u2 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "text", text: "Noted." }], t: 1 }),
    userLine({ sid, uuid: u2, parentUuid: a1, content: "Third record.", t: 2 }),
  ];
  const extraRaw = [{ type: "last-prompt", lastPrompt: "Third record.", leafUuid: a1, sessionId: sid }];
  const { uuid } = writeLines(lines, { uuid: sid, extraRaw });
  return runResume({ uuid });
});
experiment("chain_attachment_between", () => {
  const sid = newSessionId();
  const u1 = newUUID(), x1 = newUUID(), a1 = newUUID();
  const att = {
    parentUuid: u1, isSidechain: false,
    attachment: { type: "total_tokens_reminder", text: "<total_tokens>15000000 tokens left</total_tokens>" },
    type: "attachment", uuid: x1, timestamp: iso(1), userType: "external", entrypoint: "cli", cwd: CWD, sessionId: sid, version: "2.1.303", gitBranch: "HEAD",
  };
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    att,
    assistantLine({ sid, uuid: a1, parentUuid: x1, content: [{ type: "text", text: "Noted." }], t: 2 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("chain_unknown_type_between", () => {
  const sid = newSessionId();
  const u1 = newUUID(), x1 = newUUID(), a1 = newUUID();
  const unknown = { type: "future-line-type", parentUuid: u1, uuid: x1, sessionId: sid, timestamp: iso(1) };
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    unknown,
    assistantLine({ sid, uuid: a1, parentUuid: x1, content: [{ type: "text", text: "Noted." }], t: 2 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

// ===================== tool_use / tool_result =====================
experiment("tool_pair_ok", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u2 = newUUID(), a2 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + ". Run echo." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo secret" } }], messageExtra: { stop_reason: "tool_use" }, t: 1 }),
    userLine({ sid, uuid: u2, parentUuid: a1, content: [{ type: "tool_result", tool_use_id: "toolu_01", content: SECRET }], t: 2 }),
    assistantLine({ sid, uuid: a2, parentUuid: u2, content: [{ type: "text", text: "Command returned " + SECRET + "." }], t: 3 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("tool_orphan_use", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "tool_use", id: "toolu_orphan", name: "Bash", input: { command: "echo x" } }], messageExtra: { stop_reason: "tool_use" }, t: 1 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("tool_orphan_result", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    { ...userLine({ sid, uuid: newUUID(), parentUuid: u1, content: [{ type: "tool_result", tool_use_id: "toolu_ghost", content: "ghost" }], t: 1 }) },
    assistantLine({ sid, uuid: a1, parentUuid: lines[0] ? undefined : undefined, content: [{ type: "text", text: "Noted." }], t: 2 }),
  ];
  lines[2].parentUuid = lines[1].uuid;
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("tool_mismatched_ids", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u2 = newUUID(), a2 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "tool_use", id: "toolu_A", name: "Bash", input: { command: "x" } }], messageExtra: { stop_reason: "tool_use" }, t: 1 }),
    userLine({ sid, uuid: u2, parentUuid: a1, content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "wrong" }], t: 2 }),
    assistantLine({ sid, uuid: a2, parentUuid: u2, content: [{ type: "text", text: "Noted." }], t: 3 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

// ===================== thinking =====================
experiment("think_fake_signature", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [
      { type: "thinking", thinking: "I should remember " + SECRET, signature: "ZmFrZS1zaWduYXR1cmU=" },
      { type: "text", text: "Noted." },
    ], t: 1 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("think_no_signature", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [
      { type: "thinking", thinking: "I should remember " + SECRET },
      { type: "text", text: "Noted." },
    ], t: 1 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("think_empty_signature", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [
      { type: "thinking", thinking: "I should remember " + SECRET, signature: "" },
      { type: "text", text: "Noted." },
    ], t: 1 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

// ===================== lookup / location =====================
experiment("loc_other_slug", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const otherDir = path.join(HOME, "projects", "-some-other-project-slug");
  const { uuid } = writeLines(lines, { uuid: sid, dir: otherDir });
  return runResume({ uuid });
});
experiment("loc_outside_projects", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const otherDir = path.join(HOME, "notprojects");
  const { uuid } = writeLines(lines, { uuid: sid, dir: otherDir });
  return runResume({ uuid });
});
experiment("loc_filename_not_uuid", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const dir = PROJECT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return runResume({ uuid: sid });
});
experiment("loc_id_equals_sessionId_not_filename", () => {
  const sid = newSessionId();
  const otherSid = newSessionId();
  const { lines } = baseTranscript(sid);
  const { uuid } = writeLines(lines, { uuid: otherSid }); // filename otherSid, sessionId sid
  return runResume({ uuid: sid });
});
experiment("loc_empty_file", () => {
  const sid = newSessionId();
  writeLines([], { uuid: sid });
  return runResume({ uuid });
});
experiment("loc_only_metadata_lines", () => {
  const sid = newSessionId();
  const extraRaw = [
    { type: "cost-state", sessionId: sid, totalCostUSD: 0 },
    { type: "last-prompt", lastPrompt: "x", leafUuid: newUUID(), sessionId: sid },
  ];
  const { uuid } = writeLines([], { uuid: sid, extraRaw });
  return runResume({ uuid });
});

// ===================== ordering / trailing metadata =====================
experiment("order_trailing_metadata_after_assistant", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const extraRaw = [
    { type: "cost-state", sessionId: sid, totalCostUSD: 0 },
    { type: "last-prompt", lastPrompt: "x", leafUuid: lines[1].uuid, sessionId: sid },
    { type: "atis-latch", atis: "", sessionId: sid },
  ];
  const { uuid } = writeLines(lines, { uuid: sid, extraRaw });
  return runResume({ uuid });
});
experiment("order_firstline_metadata_before_user", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  const meta = { type: "file-history-snapshot", messageId: newUUID(), snapshot: {}, isSnapshotUpdate: false };
  const { uuid } = writeLines([meta, ...lines], { uuid: sid });
  return runResume({ uuid });
});
experiment("odr_last_record_user", () => {
  const sid = newSessionId();
  const u1 = newUUID(), a1 = newUUID(), u2 = newUUID();
  const lines = [
    userLine({ sid, uuid: u1, content: "The secret word is " + SECRET + "." }),
    assistantLine({ sid, uuid: a1, parentUuid: u1, content: [{ type: "text", text: "Noted." }], t: 1 }),
    userLine({ sid, uuid: u2, parentUuid: a1, content: "The secret word again please.", t: 2 }),
  ];
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

// ===================== field minimality =====================
experiment("field_no_type_on_assistant", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  delete lines[1].type;
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("field_no_message_on_assistant", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  delete lines[1].message;
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("field_assistant_content_string", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  lines[1].message.content = "Understood. The secret word is " + SECRET + ".";
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("field_user_no_message_role", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  delete lines[0].message.role;
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});
experiment("field_no_uuid_on_assistant_leaf", () => {
  const sid = newSessionId();
  const { lines } = baseTranscript(sid);
  delete lines[1].uuid;
  const { uuid } = writeLines(lines, { uuid: sid });
  return runResume({ uuid });
});

// ------------------------- runner -------------------------
const only = process.argv[2] || "";
const patterns = only.split(",").filter(Boolean);
const results = [];
for (const ex of experiments) {
  if (patterns.length && !patterns.some((p) => ex.name.includes(p))) continue;
  process.stdout.write("RUN " + ex.name + " ... ");
  let res;
  const t0 = Date.now();
  try {
    res = ex.fn();
  } catch (e) {
    res = { error: String(e && e.stack || e) };
  }
  const ms = Date.now() - t0;
  results.push({ name: ex.name, ms, ...res });
  console.log(
    (res.error ? "ERROR " + res.error :
      (res.resumed ? "RESUMED" : "FAILED") +
      " exit=" + res.exitCode +
      " ctxUsers=" + res.replayUserCount + " ctxAssistants=" + res.replayAssistantCount +
      " secretInCtx=" + res.secretInReplay +
      " apiReqs=" + res.apiRequests +
      " result=" + JSON.stringify(res.resultText || res.stdoutText || "").slice(0, 80) +
      (res.stderr ? " stderr=" + JSON.stringify(res.stderr.slice(0, 200)) : ""))
  );
}
for (const r of results) {
  if (!r.rawRequests) continue;
  const dir = path.join(EVIDENCE, "requests");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, r.name + ".json"), JSON.stringify(r.rawRequests, null, 1));
}
const reportPath = path.join(EVIDENCE, "probes-" + (only ? only.replace(/[^a-z0-9]+/gi, "-") : "all") + ".json");
fs.mkdirSync(EVIDENCE, { recursive: true });
// strip rawRequests body for report size, keep messages summary only
const slim = results.map((r) => ({ ...r, rawRequests: undefined, apiRequestSummaries: (r.rawRequests || []).map((x) => ({ url: x.url, model: x.body && x.body.model, stream: x.body && x.body.stream, msgCount: x.body && x.body.messages && x.body.messages.length })) }));
fs.writeFileSync(reportPath, JSON.stringify(slim, null, 2));
console.log("report:", reportPath);
