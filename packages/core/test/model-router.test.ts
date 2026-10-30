// Choosing a brain, model and effort per request (model-router.ts) from what each brain's models are like.
import { describe, expect, it } from "vitest";
import { catalogOf, markLegacy, modelVersion, profileFrom, profileOf } from "@owlbot/shared";
import { needOf, needOfMessage, route, skillOfGoal, type RouteBrain } from "../src/model-router.ts";

const claude: RouteBrain = { ref: "claude-code@local", probe: { models: ["fable", "opus", "sonnet", "haiku"], efforts: ["low", "medium", "high", "xhigh", "max"] } };
const codex: RouteBrain = { ref: "codex@local", probe: { models: ["gpt-5.5-codex", "gpt-5.5-codex-mini"], efforts: ["minimal", "low", "medium", "high"] } };
const deepseek: RouteBrain = { ref: "api:deepseek", probe: { models: ["deepseek-chat", "deepseek-reasoner"] } };
const haikuApi: RouteBrain = { ref: "api:anthropic", probe: { models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"], efforts: ["low", "medium", "high", "xhigh", "max"] } };

describe("model profiles", () => {
  it("knows the families of every provider, and a middling profile for the rest", () => {
    expect(profileOf("haiku")).toMatchObject({ tier: 2, speed: 3, cost: 1 });
    expect(profileOf("claude-opus-5-5")).toMatchObject({ tier: 5 });
    expect(profileOf("gpt-5.5-codex").good).toContain("code");
    expect(profileOf("kimi-k2-0905").tier).toBe(4);
    expect(profileOf("deepseek-reasoner").good).toContain("reasoning");
    expect(profileOf("glm-4.6")).toMatchObject({ tier: 4, cost: 1 });
    expect(profileOf("glm-4.5-air")).toMatchObject({ tier: 3, speed: 3 });
    expect(profileOf("gemini-2.5-flash-lite")).toMatchObject({ tier: 2, speed: 3 });
    expect(profileOf("qwen3-coder-plus").good).toContain("code");
    expect(profileOf("llama3.1")).toMatchObject({ tier: 2 });
    expect(profileOf("something-new")).toEqual({ id: "something-new", tier: 3, speed: 2, cost: 2 });
    // A brain's own profile wins over the table.
    expect(catalogOf(["haiku", "x"], {}, [{ id: "x", tier: 5, speed: 3, cost: 1 }]).map((p) => [p.id, p.tier])).toEqual([["x", 5], ["haiku", 2]]);
  });
});

describe("routing a request", () => {
  it("answers a word in passing with the cheapest quick model, and the front desk with a strong quick one at low effort", () => {
    expect(route([claude], { need: "light" })[0]).toEqual(expect.objectContaining({ ref: "claude-code@local", model: "haiku", effort: "low" }));
    expect(route([claude], { need: "quick" })[0]).toEqual(expect.objectContaining({ model: "sonnet", effort: "low" }));
  });

  it("gives hard thinking the most capable model with the most effort, and code to a coding model", () => {
    expect(route([claude], { need: "deep" })[0]).toMatchObject({ effort: "xhigh" });
    expect(["fable", "opus"]).toContain(route([claude], { need: "deep" })[0].model);
    expect(route([claude, codex], { need: "standard", skill: "code", hands: true })[0]).toMatchObject({ ref: "codex@local", model: "gpt-5.5-codex", effort: "medium" });
  });

  it("chooses across providers by what their models are like, and keeps brains without hands off work that needs them", () => {
    const light = route([claude, deepseek, haikuApi], { need: "light" });
    expect(light[0]).toMatchObject({ model: expect.stringMatching(/haiku/) });
    const reasoning = route([deepseek], { need: "deep", skill: "reasoning" })[0];
    expect(reasoning).toEqual({ ref: "api:deepseek", model: "deepseek-reasoner", score: expect.any(Number) });
    expect(route([claude, deepseek], { need: "standard", hands: true }).map((r) => r.ref)).toEqual(["claude-code@local"]);
    // A brain that lists no models takes its default, as a middling one.
    expect(route([{ ref: "fake@local" }], { need: "deep" })[0]).toMatchObject({ ref: "fake@local" });
  });

  it("reads Codex's own line-up, and learns nothing from presets that name one model for every role", () => {
    // What the installed Codex lists (2026-10-30): its presets name the default model for every role.
    const live: RouteBrain = {
      ref: "codex@local",
      probe: {
        models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        presets: { fast: { model: "gpt-6-astra", effort: "low" }, balanced: { model: "gpt-6-astra", effort: "medium" }, deep: { model: "gpt-6-astra", effort: "xhigh" } },
      },
    };
    // GPT-5.6 is an older generation next to GPT-6: every request goes to Astra, with the effort that fits.
    expect(route([live], { need: "light" })[0]).toMatchObject({ model: "gpt-6-astra", effort: "low" });
    expect(route([live], { need: "quick" })[0]).toMatchObject({ model: "gpt-6-astra", effort: "low" });
    expect(route([live], { need: "deep" })[0]).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    // What Codex itself says of them (its model/list, 2026-10-30) gives the same answer.
    const told: RouteBrain = {
      ref: "codex@local",
      probe: {
        models: live.probe!.models,
        efforts: live.probe!.efforts,
        catalog: markLegacy([
          profileFrom({ id: "gpt-6-astra", description: "Frontier intelligence for the most demanding work." }),
          profileFrom({ id: "gpt-5.6-sol", description: "Older generation workhorse model." }),
          profileFrom({ id: "gpt-5.6-terra", description: "Older balanced model for straightforward work." }),
          profileFrom({ id: "gpt-5.6-luna", description: "Older fast and efficient model." }),
        ]),
      },
    };
    expect(route([told], { need: "light" })[0]).toMatchObject({ model: "gpt-6-astra", effort: "low" });
    // With nothing current, an older model still works.
    expect(route([{ ref: "x@local", probe: { catalog: [profileFrom({ id: "old-1", description: "Older fast model." })] } }], { need: "light" })[0]).toMatchObject({ model: "old-1" });
  });

  it("reads a provider's own words for its models, and marks older generations", () => {
    expect(profileFrom({ id: "gpt-6-astra", description: "Frontier intelligence for the most demanding work." })).toMatchObject({ tier: 5 });
    expect(profileFrom({ id: "zeta-1", description: "Fast and affordable agentic coding model." })).toMatchObject({ tier: 3, speed: 3, cost: 1, good: ["code"] });
    expect(profileFrom({ id: "gpt-5.6-luna", description: "Older fast and efficient model." })).toMatchObject({ speed: 3, legacy: true });
    expect(profileFrom({ id: "pricey", price: { input: 15, output: 75 } }).cost).toBe(3);
    expect(profileFrom({ id: "cheap", price: { input: 0.1, output: 0.4 } }).cost).toBe(1);
    expect(modelVersion("gpt-5.6-luna")).toEqual({ vendor: "gpt", family: "gpt-luna", version: 5.6 });
    expect(modelVersion("claude-haiku-4-5-20251001")).toMatchObject({ family: "claude-haiku", version: 4.5 });
    expect(modelVersion("mistral-large-2411")).toMatchObject({ version: undefined });
    expect(modelVersion("deepseek/deepseek-v3.2")).toMatchObject({ vendor: "deepseek", version: 3.2 });
    const marked = markLegacy(["gpt-6-astra", "gpt-5.6-sol", "claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5-5", "glm-4.6", "glm-4.5-air"].map((id) => profileOf(id)));
    expect(marked.filter((m) => m.legacy).map((m) => m.id)).toEqual(["gpt-5.6-sol", "claude-haiku-4-5"]);
  });

  it("tells what a request needs", () => {
    expect(needOfMessage("Спасибо!")).toBe("light");
    expect(needOfMessage("👍")).toBe("light");
    expect(needOfMessage("Какая погода завтра?")).toBe("quick");
    expect(needOf("auto", "chat", "ok")).toBe("light");
    expect(needOf("auto", "feed", "x")).toBe("light");
    expect(needOf("auto", "task", "x")).toBe("standard");
    expect(needOf("deep", "chat", "ok")).toBe("deep");
    expect(needOf("fast", "task", "x")).toBe("light");
    expect(skillOfGoal("Почини баг в скрипте сборки")).toBe("code");
    expect(skillOfGoal("Сравни Bun и Deno")).toBe("reasoning");
    expect(skillOfGoal("Напомни купить хлеб")).toBeUndefined();
  });
});
