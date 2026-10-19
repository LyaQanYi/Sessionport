#!/usr/bin/env node
// Mock Anthropic Messages API server for Claude Code resume probes.
// Captures every request body to mock-requests.jsonl and returns a canned reply.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MOCK_PORT || 18999);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CFG_PATH = path.join(ROOT, "mock-response.json");
const LOG_PATH = path.join(ROOT, "mock-requests.jsonl");

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, "utf8")); } catch { return {}; }
}

function sse(res, body, cfg) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "request-id": "req_mock_" + Date.now(),
  });
  const id = "msg_mock_" + Date.now();
  const model = (body && body.model) || "mock-model";
  const send = (evt, data) => {
    res.write("event: " + evt + "\ndata: " + JSON.stringify(data) + "\n\n");
  };
  send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  let idx = 0;
  for (const block of cfg.blocks || [{ type: "text", text: cfg.text || "MOCK_OK" }]) {
    if (block.type === "thinking") {
      send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: block.thinking || "mock thinking" } });
      send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: block.signature || "mock-signature" } });
    } else if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id || "toolu_mock", name: block.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
    }
    send("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
  send("message_delta", { type: "message_delta", delta: { stop_reason: cfg.stop_reason || "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function jsonReply(res, body, cfg) {
  const id = "msg_mock_" + Date.now();
  res.writeHead(200, { "content-type": "application/json", "request-id": "req_mock_" + Date.now() });
  res.end(JSON.stringify({
    id, type: "message", role: "assistant", model: (body && body.model) || "mock-model",
    content: cfg.blocks || [{ type: "text", text: cfg.text || "MOCK_OK" }],
    stop_reason: cfg.stop_reason || "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    const rec = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => /anthropic|authorization|content-type|x-app|x-stainless|user-agent/i.test(k))),
      body,
    };
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n");
    const cfg = loadCfg();
    if ((req.url || "").includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(404); res.end("not found"); return; }
    if (body && body.stream === false) jsonReply(res, body, cfg);
    else sse(res, body, cfg);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("MOCK_LISTENING http://127.0.0.1:" + PORT);
});
