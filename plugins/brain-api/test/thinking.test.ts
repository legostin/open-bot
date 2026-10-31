// How the API brain thinks and keeps its context: the session's effort in the provider's own parameter, presets per
// variant, and compaction that turns the older part of a long conversation into a summary nobody sees.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions } from "@piomio/shared";
import { startMockLlm, startPlugin, type MockLlm, type PluginHarness } from "@piomio/testkit";
import { startFakeMcp, type FakeMcp } from "./fake-mcp.ts";
import { SUMMARY_HEAD, SUMMARY_SYSTEM } from "../server/history.ts";

const PLUGIN_DIR = join(import.meta.dirname, "..");
const VAULT = { anthropic_api_key: { value: "sk-ant-test" }, openai_api_key: { value: "sk-openai-test" }, openrouter_api_key: { value: "sk-or-test" } };

const text = (events: BrainEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
/** The text of a request's first message (Anthropic content blocks or an OpenAI string). */
const firstText = (body: any) => {
  const c = body.messages[0].content;
  return typeof c === "string" ? c : c.map((b: any) => b.text ?? "").join("");
};

describe("API brain: effort and compaction", () => {
  let llm: MockLlm;
  let mcp: FakeMcp;
  let h: PluginHarness;
  let settings: Record<string, unknown>;

  const opts = (sessionId: string, over: Partial<BrainSessionOptions> = {}): BrainSessionOptions => ({
    sessionId,
    agent: { id: "assistant", name: "Owl", description: "", brains: ["api:anthropic"], initiative: 1, tools: ["*"], skills: ["*"], policyProfile: "default", budget: { backgroundRunsPerDay: 10 }, prompt: "", source: "builtin" },
    variant: "anthropic",
    workspace: mkdtempSync(join(tmpdir(), "owl-api-th-")),
    mcp: { url: mcp.url, token: mcp.token, bridgeCommand: [] },
    systemPrompt: "You are a test assistant.",
    env: {},
    background: false,
    ...over,
  });

  beforeAll(async () => {
    llm = await startMockLlm();
    mcp = await startFakeMcp();
    settings = { anthropicBaseUrl: llm.url, openaiBaseUrl: `${llm.url}/v1`, openrouterBaseUrl: `${llm.url}/v1`, customBaseUrl: `${llm.url}/v1` };
    h = await startPlugin({ dir: PLUGIN_DIR, settings, vault: VAULT });
  });
  afterAll(async () => {
    await h?.stop();
    await llm?.close();
    await mcp?.close();
  });
  beforeEach(() => {
    llm.reset();
    h.setSettings(settings);
  });

  it("says what each preset means on each variant", async () => {
    const a = await h.brainProbe("api", "anthropic");
    expect(a.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(a.modelNames?.["claude-opus-5-5"]).toBe("Opus 5.5");
    expect(a.presets).toEqual({
      fast: { model: "claude-sonnet-5-5", effort: "low" },
      balanced: { model: "claude-opus-5-5", effort: "medium" },
      deep: { model: "claude-opus-5-5", effort: "xhigh" },
    });
    expect((await h.brainProbe("api", "openai")).presets?.deep).toEqual({ effort: "high" });
    const custom = await h.brainProbe("api", "custom");
    expect(custom.efforts).toBeUndefined();
    expect(custom.presets).toEqual({});
  });

  it("sends the session's effort in each provider's own parameter", async () => {
    llm.script([{ text: "ok" }, { text: "ok" }, { text: "ok" }, { text: "ok" }]);
    await h.brainCreate("api", opts("e-anthropic", { model: "claude-opus-5-5", effort: "xhigh" }));
    await h.brainSend("e-anthropic", { text: "hi" });
    expect(llm.requests.at(-1)!.body.output_config).toEqual({ effort: "xhigh" });

    await h.brainCreate("api", opts("e-openai", { variant: "openai", effort: "high" }));
    await h.brainSend("e-openai", { text: "hi" });
    expect(llm.requests.at(-1)!.body.reasoning).toEqual({ effort: "high" });
    expect(llm.requests.at(-1)!.body.reasoning_effort).toBeUndefined();

    await h.brainCreate("api", opts("e-router", { variant: "openrouter", effort: "low" }));
    await h.brainSend("e-router", { text: "hi" });
    expect(llm.requests.at(-1)!.body.reasoning).toEqual({ effort: "low" });

    // An effort the provider does not take is not sent.
    await h.brainCreate("api", opts("e-odd", { effort: "ultra" }));
    await h.brainSend("e-odd", { text: "hi" });
    expect(llm.requests.at(-1)!.body.output_config).toBeUndefined();
  });

  it("goes on without the effort when an OpenAI-compatible model refuses it", async () => {
    llm.script([{ status: 400, error: "Unsupported parameter: 'reasoning.effort' is not supported with this model." }, { text: "fine" }, { text: "again" }]);
    await h.brainCreate("api", opts("e-refused", { variant: "openai", effort: "high" }));
    const ev = await h.brainSend("e-refused", { text: "hi" });
    expect(text(ev)).toBe("fine");
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(llm.requests[0].body.reasoning).toEqual({ effort: "high" });
    expect(llm.requests[1].body.reasoning).toBeUndefined();
    expect(llm.requests[1].body.include).toBeUndefined();
    await h.brainSend("e-refused", { text: "more" });
    expect(llm.requests[2].body.reasoning).toBeUndefined();
  });

  it("folds the older part into a summary while the user reads, and nothing of it reaches the chat", async () => {
    h.setSettings({ ...settings, historyTokenBudget: 1000 });
    const dataDir = h.dataDir;
    llm.script([{ text: "Noted the first part." }, { text: "Noted the second part." }, { text: "SUMMARY: the user is planning a trip to Lisbon in May." }, { text: "Lisbon in May, as we said." }]);
    await h.brainCreate("api", opts("c-sum", { model: "claude-opus-5-5", effort: "high" }));
    const t1 = await h.brainSend("c-sum", { text: `Trip notes: ${words(240)}` });
    const t2 = await h.brainSend("c-sum", { text: `More notes: ${words(240, "more")}` });
    // The summary was written after the second turn, by the session's model with little effort and no tools.
    await new Promise((r) => setTimeout(r, 300));
    expect(llm.requests).toHaveLength(3);
    const sum = llm.requests[2].body;
    expect(sum.system[0].text).toBe(SUMMARY_SYSTEM);
    expect(sum.tools).toBeUndefined();
    expect(sum.model).toBe("claude-opus-5-5");
    expect(sum.output_config).toEqual({ effort: "low" });
    expect(firstText(sum)).toContain("User: Trip notes: word0");

    const t3 = await h.brainSend("c-sum", { text: "Where were we going?" });
    expect(text(t3)).toBe("Lisbon in May, as we said.");
    const next = llm.requests[3].body;
    expect(firstText(next)).toBe(`${SUMMARY_HEAD}\nSUMMARY: the user is planning a trip to Lisbon in May.`);
    expect(next.messages.at(-1).content.at(-1).text).toBe("Where were we going?");
    expect(next.output_config).toEqual({ effort: "high" });
    // Invisible: no turn streamed the summary.
    for (const ev of [t1, t2, t3]) expect(text(ev)).not.toContain("SUMMARY:");
    // The saved history starts from the summary too: a resumed session goes on from it.
    const saved = JSON.parse(readFileSync(join(dataDir, "sessions", "c-sum.json"), "utf8"));
    expect(saved.messages[0].parts[0].text.startsWith(SUMMARY_HEAD)).toBe(true);
  });

  it("keeps a digest of the older part when the model cannot summarize", async () => {
    h.setSettings({ ...settings, historyTokenBudget: 1000 });
    llm.script([{ text: "one" }, { text: "two" }, { status: 500, error: "boom" }, { text: "three" }]);
    await h.brainCreate("api", opts("c-digest"));
    await h.brainSend("c-digest", { text: `First: ${words(240)}` });
    await h.brainSend("c-digest", { text: `Second: ${words(240)}` });
    const ev = await h.brainSend("c-digest", { text: "and?" });
    expect(text(ev)).toBe("three");
    const first = firstText(llm.requests[3].body);
    expect(first.startsWith(SUMMARY_HEAD)).toBe(true);
    expect(first).toContain("- User: First: word0");
    expect(first).toContain("- Me: one");
  });

  it("starts from the hub's recap when the history it was to resume is gone", async () => {
    llm.script([{ text: "Sure, Lisbon." }]);
    await h.brainCreate("api", opts("c-gone", { resume: "c-gone" }));
    await h.brainSend("c-gone", { text: "Book it", recap: "[System] RECAP: we chose Lisbon." });
    expect(firstText(llm.requests[0].body)).toBe("[System] RECAP: we chose Lisbon.\n\n---\nBook it");
    // With its history the recap is not needed.
    llm.script([{ text: "Done." }]);
    await h.brainSend("c-gone", { text: "Thanks", recap: "[System] RECAP: unused" });
    expect(JSON.stringify(llm.requests[1].body.messages)).not.toContain("unused");
  });
});
