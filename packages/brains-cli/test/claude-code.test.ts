import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions } from "@openbot/shared";
import { ClaudeStreamParser, createClaudeCodeProvider, CodexStreamParser, parseCodexReset } from "../src/index.ts";

const fake = join(import.meta.dirname, "fixtures", "fake-claude.mjs");

function opts(over: Partial<BrainSessionOptions> = {}): BrainSessionOptions {
  return {
    sessionId: "s_" + Math.random().toString(36).slice(2),
    agent: {} as any,
    workspace: mkdtempSync(join(tmpdir(), "ob-cc-ws-")),
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok-secret", bridgeCommand: ["node", "bridge.ts"] },
    systemPrompt: "SYSTEM",
    env: {},
    background: false,
    ...over,
  };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("ClaudeStreamParser", () => {
  it("streams text once, maps tools, skips subagent output", () => {
    const p = new ClaudeStreamParser();
    const ev = [
      ...p.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, parent_tool_use_id: null, api_message_id: "m1" }),
      ...p.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "mcp__openbot__memory_search", input: { q: 1 } }] }, parent_tool_use_id: null }),
      ...p.push({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: "inner" }] }, parent_tool_use_id: "t" }),
    ];
    expect(ev).toEqual([
      { type: "text", delta: "hi" },
      { type: "tool_call", id: "t", name: "memory_search", input: { q: 1 } },
    ]);
  });

  it("detects subscription limits", () => {
    const p = new ClaudeStreamParser();
    p.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour" } });
    expect(p.limit?.resetAt).toBe(new Date(1893456000 * 1000).toISOString());
  });
});

describe("Claude Code provider (fake CLI)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ob-cc-state-"));
  const provider = createClaudeCodeProvider({ command: () => fake, stateDir });

  it("probes version and login", async () => {
    const r = await provider.probe();
    expect(r.available).toBe(true);
    expect(r.version).toBe("9.9.9");
  });

  it("runs turns, resumes, and keeps the MCP token out of args", async () => {
    const o = opts({ model: "sonnet" });
    const s = await provider.createSession(o);
    const first = await collect(s.send({ text: "ping" }));
    expect(first.filter((e) => e.type === "text").map((e: any) => e.delta).join("")).toBe("echo:pingresume=none model=sonnet");
    expect(first).toContainEqual({ type: "tool_call", id: "tu1", name: "notify", input: { level: "silent", title: "x" } });
    expect(first).toContainEqual({ type: "tool_result", id: "tu1", output: "ok", isError: false });
    expect(first).toContainEqual({ type: "usage", inputTokens: 15, outputTokens: 3, costUsd: 0.01 });
    expect(first.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });
    const second = await collect(s.send({ text: "again" }));
    expect(second.some((e) => e.type === "text" && e.delta.includes("resume=sess-1"))).toBe(true);
    const mcp = readFileSync(join(stateDir, "sessions", o.sessionId, "mcp.json"), "utf8");
    expect(mcp).not.toContain("tok-secret");
    expect(readFileSync(join(stateDir, "sessions", o.sessionId, "prompt.md"), "utf8")).toBe("SYSTEM");
  });

  it("starts fresh when the resume id is gone", async () => {
    const s = await provider.createSession(opts({ resume: "missing" }));
    const ev = await collect(s.send({ text: "x" }));
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(ev.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });
  });

  it("reports limit_hit", async () => {
    const s = await provider.createSession(opts());
    const ev = await collect(s.send({ text: "LIMIT" }));
    expect(ev).toContainEqual({ type: "limit_hit", resetAt: new Date(1893456000 * 1000).toISOString(), detail: "Claude: subscription limit (five_hour)" });
  });

  it("reports a missing CLI as a fatal error", async () => {
    const p = createClaudeCodeProvider({ command: () => "definitely-not-a-claude-binary", stateDir });
    expect((await p.probe()).available).toBe(false);
    const s = await p.createSession(opts());
    const ev = await collect(s.send({ text: "x" }));
    expect(ev.find((e) => e.type === "error")).toMatchObject({ fatal: true });
  });

  it("speaks the language it is given", async () => {
    const missing = { command: () => "definitely-not-a-claude-binary", stateDir };
    expect((await createClaudeCodeProvider(missing).probe()).detail).toBe("Claude Code is not installed");
    expect((await createClaudeCodeProvider({ ...missing, locale: () => "ru" }).probe()).detail).toBe("Claude Code не установлен");
  });
});

describe("CodexStreamParser", () => {
  it("maps codex exec --json events", () => {
    const p = new CodexStreamParser();
    const ev = [
      ...p.push({ type: "thread.started", thread_id: "th1" }),
      ...p.push({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "openbot", tool: "notify", arguments: { title: "x" } } }),
      ...p.push({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", status: "completed", result: { content: [{ type: "text", text: "ok" }] } } }),
      ...p.push({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Готово" } }),
      ...p.push({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 } }),
    ];
    expect(p.threadId).toBe("th1");
    expect(ev).toEqual([
      { type: "tool_call", id: "i1", name: "notify", input: { title: "x" } },
      { type: "tool_result", id: "i1", output: "ok", isError: false },
      { type: "text", delta: "Готово\n" },
      { type: "usage", inputTokens: 6, outputTokens: 2 },
    ]);
  });

  it("parses limit reset hints", () => {
    const now = Date.parse("2026-10-26T10:00:00Z");
    expect(parseCodexReset("You have hit your usage limit. Try again in 2 hours 5 minutes.", now)).toBe("2026-10-26T12:05:00.000Z");
    const p = new CodexStreamParser();
    p.push({ type: "turn.failed", error: { message: "usage limit reached, try again in 30 minutes" } });
    expect(p.limit).toBeTruthy();
  });
});
