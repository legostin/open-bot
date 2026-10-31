import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "@piomio/shared";
import { before, partsText, recap } from "../src/continuity.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

let n = 0;
const msg = (role: Message["role"], text: string, extra: MessagePart[] = []): Message => ({
  id: `m${++n}`,
  conversationId: "c",
  role,
  parts: [...(text ? [{ type: "text" as const, text }] : []), ...extra],
  status: "complete",
  createdAt: new Date(Date.UTC(2026, 9, 29, 0, 0, n)).toISOString(),
});
const speaker = (m: Message) => (m.role === "user" ? "User" : m.role === "assistant" ? "You" : "System");

describe("the recap a fresh session starts from", () => {
  it("is nothing before the agent has said anything", () => {
    expect(recap([msg("user", "hi")], { speaker, self: "Owl" })).toBeUndefined();
  });

  it("leaves out the input of the turn now starting", () => {
    const ms = [msg("user", "plan a trip"), msg("assistant", "Lisbon?"), msg("user", "yes, in May"), msg("system", "[System] a note")];
    expect(before(ms).map((m) => m.id)).toEqual(ms.slice(0, 2).map((m) => m.id));
    const r = recap(ms, { speaker, self: "Owl" })!;
    expect(r).toMatch(/^\[System\] Your session in this conversation was renewed: you are still Owl/);
    expect(r).toContain("It started with:\nUser: plan a trip");
    expect(r).toContain("Most recent:\nYou: Lisbon?");
    expect(r).not.toContain("yes, in May");
  });

  it("keeps the recent turns in full and the older ones a line each, within its budget", () => {
    const ms: Message[] = [msg("user", "The task: compare three laptops")];
    for (let i = 0; i < 80; i++) ms.push(msg("user", `question ${i} ${"q".repeat(300)}`), msg("assistant", `answer ${i} ${"a".repeat(300)}`, [{ type: "tool_call", id: `t${i}`, name: "web_search", input: {} }]));
    const r = recap(ms, { speaker, self: "Owl", maxChars: 6000 })!;
    expect(r.length).toBeLessThan(6600);
    expect(r).toContain("It started with:\nUser: The task: compare three laptops");
    expect(r).toMatch(/Earlier, in short \(oldest first; \d+ older messages left out\):/);
    expect(r).toContain("You: answer 79");
    expect(r).toContain("[called web_search]");
    expect(r.indexOf("answer 70")).toBeLessThan(r.indexOf("answer 79"));
  });

  it("shows the conversation's first message when the list does not reach back to it", () => {
    const first = msg("user", "Task: fix the build");
    const r = recap([msg("assistant", "on it"), msg("user", "and?"), msg("assistant", "done")], { speaker, self: "Owl", first })!;
    expect(r).toContain("It started with:\nUser: Task: fix the build");
    expect(r).toContain("You: on it");
  });

  it("puts what the agent did in words", () => {
    expect(partsText([{ type: "choices", options: ["yes", "no"], chosen: 0 }, { type: "map", lat: 1, lon: 2, title: "Lisbon" }])).toBe("[offered: yes / no; chosen: yes] [showed a map of Lisbon at 1, 2]");
  });
});

describe("the system prompt says how the session thinks", () => {
  const agent = { id: "owl", name: "Owl", description: "", brains: [], initiative: 1 as const, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 1 }, prompt: "", source: "builtin" };
  const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, skills: [], nativeSkills: false, appended: [] };

  it("names the brain, the model, the effort and the user's preset", () => {
    const p = buildSystemPrompt({ ...base, thinking: { brain: "Claude Code", kind: "task", model: "opus", effort: "xhigh", preset: "deep" } });
    expect(p).toContain('You think with Claude Code: model opus, effort xhigh (the user\'s "deep" choice for tasks).');
    expect(p).toContain("`thinking_set`");
    expect(buildSystemPrompt({ ...base, thinking: { brain: "Codex", kind: "chat" } })).toContain("You think with Codex: its default model.");
  });
});
