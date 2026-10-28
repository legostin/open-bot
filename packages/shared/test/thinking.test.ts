import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/types.ts";
import { brainsFor, fitEffort, parseThinking, patchChoice, resolveThinking, thinkingFor, withChoice, workKind } from "../src/thinking.ts";

const presets = { fast: { model: "sonnet", effort: "low" }, balanced: { model: "opus", effort: "medium" }, deep: { model: "opus", effort: "xhigh" } };
const claude = { presets, efforts: ["low", "medium", "high", "xhigh", "max"] };
const agent = (thinking: AgentDef["thinking"], brains = ["claude-code@local", "codex@local"]) => ({ brains, thinking });

describe("thinking per kind of work", () => {
  it("tells the kind of work from the task", () => {
    expect(workKind(undefined)).toBe("chat");
    expect(workKind({ kind: "message", createdBy: "agent" })).toBe("chat");
    expect(workKind({ createdBy: "agent" })).toBe("task");
    expect(workKind({ createdBy: "trigger" })).toBe("schedule");
    expect(workKind({ createdBy: "trigger", feedId: "f1" })).toBe("feed");
  });

  it("lets a kind follow the chat until it has its own choice", () => {
    const a = agent({ chat: { preset: "fast" }, task: { preset: "deep" }, feed: { brain: "codex" } });
    expect(thinkingFor(a, "chat")).toEqual({ preset: "fast" });
    expect(thinkingFor(a, "task")).toEqual({ preset: "deep" });
    expect(thinkingFor(a, "schedule")).toEqual({ preset: "fast" });
    // A brain alone keeps the chat's depth.
    expect(thinkingFor(a, "feed")).toEqual({ preset: "fast", brain: "codex" });
    expect(brainsFor(a, "feed")).toEqual(["codex", "claude-code@local"]);
    expect(brainsFor(a, "chat")).toEqual(["claude-code@local", "codex@local"]);
    expect(thinkingFor({ brains: [] }, "task")).toEqual({});
  });

  it("resolves a preset on each brain, exact choices on their own brain, and the old agent-wide model last", () => {
    expect(resolveThinking({ preset: "deep" }, "claude-code@local", claude)).toEqual({ model: "opus", effort: "xhigh", preset: "deep" });
    expect(resolveThinking({ preset: "deep" }, "codex@local", { efforts: ["low", "medium", "high"], presets: { deep: { effort: "high" } } }, "gpt-x")).toEqual({ model: "gpt-x", effort: "high", preset: "deep" });
    const exact = { model: "haiku", effort: "low", brain: "claude-code" };
    expect(resolveThinking(exact, "claude-code@local", claude)).toEqual({ model: "haiku", effort: "low" });
    expect(resolveThinking(exact, "codex@local", { presets: {} })).toEqual({});
    expect(resolveThinking({ preset: "fast", effort: "max", brain: "claude-code@local" }, "claude-code@local", claude)).toEqual({ model: "sonnet", effort: "max" });
    // A brain without presets or efforts: the agent's old model, nothing else.
    expect(resolveThinking({ preset: "fast" }, "fake@local", undefined, "old")).toEqual({ model: "old", preset: "fast" });
  });

  it("fits an effort to what the brain takes", () => {
    expect(fitEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(fitEffort("minimal", ["low", "medium"])).toBe("low");
    expect(fitEffort("max", undefined)).toBe("max");
    expect(fitEffort("high", [])).toBeUndefined();
    expect(fitEffort("weird", ["low"])).toBeUndefined();
  });

  it("changes a choice the way people expect", () => {
    expect(patchChoice({ model: "haiku", effort: "low", brain: "b" }, { preset: "deep" })).toEqual({ preset: "deep", brain: "b" });
    expect(patchChoice({ preset: "deep", brain: "b" }, { model: "opus" })).toEqual({ model: "opus", brain: "b" });
    expect(patchChoice({ preset: "deep", model: "opus", brain: "b" }, { brain: "c" })).toEqual({ preset: "deep", brain: "c" });
    expect(patchChoice({ preset: "deep" }, { follow: true })).toBeUndefined();
    expect(withChoice({ chat: { preset: "fast" }, task: { preset: "deep" } }, "task", undefined)).toEqual({ chat: { preset: "fast" } });
    expect(withChoice({ task: { preset: "deep" } }, "task", undefined)).toBeUndefined();
  });

  it("reads only what is valid from a file or a request", () => {
    expect(parseThinking({ chat: "fast", task: { preset: "deep", model: "--dangerous", effort: "HIGH" }, dreams: { preset: "deep" } })).toEqual({
      chat: { preset: "fast" },
      task: { preset: "deep", effort: "high" },
    });
    expect(parseThinking({ task: { preset: "slow" } })).toBeUndefined();
    expect(parseThinking("deep")).toBeUndefined();
  });
});
