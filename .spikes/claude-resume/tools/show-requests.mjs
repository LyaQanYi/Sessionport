#!/usr/bin/env node
// Pretty-print captured mock requests compactly.
import fs from "node:fs";
const p = process.argv[2] || new URL("./mock-requests.jsonl", import.meta.url).pathname;
const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
lines.forEach((l, i) => {
  const r = JSON.parse(l);
  const b = r.body || {};
  console.log("=== request", i + 1, r.method, r.url, "model=" + b.model, "stream=" + b.stream);
  const msgs = b.messages || [];
  console.log("messages:", msgs.length);
  msgs.forEach((m, j) => {
    let desc;
    if (typeof m.content === "string") desc = JSON.stringify(m.content.slice(0, 200));
    else if (Array.isArray(m.content)) desc = m.content.map((c) => {
      if (c.type === "text") return "text:" + JSON.stringify((c.text || "").slice(0, 120));
      if (c.type === "thinking") return "thinking(len=" + (c.thinking || "").length + ",sig=" + JSON.stringify((c.signature || "").slice(0, 20)) + ")";
      if (c.type === "tool_use") return "tool_use:" + c.name + ":" + c.id;
      if (c.type === "tool_result") return "tool_result:" + c.tool_use_id + ":" + JSON.stringify(String(typeof c.content === "string" ? c.content : JSON.stringify(c.content)).slice(0, 120));
      return c.type;
    }).join(" | ");
    console.log("  [" + j + "]", m.role, "|", desc);
  });
  const sys = b.system;
  if (sys) console.log("system:", typeof sys === "string" ? "string len " + sys.length : Array.isArray(sys) ? "blocks " + sys.length : typeof sys);
  if (b.tools) console.log("tools:", b.tools.length);
});
