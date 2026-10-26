#!/usr/bin/env node
// stdio ↔ HTTP bridge: lets harness CLIs (Claude Code, Codex) that speak MCP over stdio reach the hub's /mcp endpoint.
// Env: OPENBOT_URL (e.g. http://127.0.0.1:8080/mcp) and the per-session bearer token in OPENBOT_TOKEN_FILE
// (preferred: a 0600 file, so the token never shows up in process listings) or OPENBOT_TOKEN.

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const url = new URL(process.env.OPENBOT_URL ?? "http://127.0.0.1:8080/mcp");
const token = process.env.OPENBOT_TOKEN_FILE ? readFileSync(process.env.OPENBOT_TOKEN_FILE, "utf8").trim() : (process.env.OPENBOT_TOKEN ?? "");
const client = url.protocol === "https:" ? https : http;

function post(body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      },
    );
    // Tool calls may legitimately run for a long time (approvals, browser work): no client timeout.
    req.on("error", reject);
    req.end(body);
  });
}

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function forward(line: string): Promise<void> {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const id = Array.isArray(parsed) ? null : (parsed?.id ?? null);
  try {
    const r = await post(line);
    if (r.status === 202 || !r.text.trim()) return;
    if (r.status >= 400 && !r.text.trim().startsWith("{")) throw new Error(`HTTP ${r.status}`);
    const out = JSON.parse(r.text);
    for (const m of Array.isArray(out) ? out : [out]) write(m);
  } catch (e: any) {
    if (id !== null) write({ jsonrpc: "2.0", id, error: { code: -32603, message: `openbot hub unreachable: ${e?.message ?? e}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) void forward(line);
  }
});
process.stdin.on("end", () => {
  // Let in-flight requests finish, then exit.
  setTimeout(() => process.exit(0), 100).unref();
});
