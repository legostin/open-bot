import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "../src/index.ts";

describe("plugin harness", () => {
  let h: PluginHarness;
  beforeAll(async () => {
    h = await startPlugin({ dir: join(import.meta.dirname, "fixtures", "echo-plugin"), vault: { demo: { value: "secret" } } });
  });
  afterAll(() => h?.stop());

  it("registers and invokes tools through the runner", async () => {
    expect([...h.tools.keys()]).toEqual(["say"]);
    expect(await h.invokeText("say", { text: "hi" })).toBe("echo: hi (6)");
    expect(h.coreCalls).toEqual([{ method: "notify", params: { level: "silent", title: "hi" } }]);
  });

  it("routes http and brains", async () => {
    expect((await h.http({ path: "/x" })).body).toEqual({ path: "/x" });
    await h.brainCreate("echo", { sessionId: "s1" } as any);
    const events = await h.brainSend("s1", { text: "yo" });
    expect(events).toEqual([{ type: "text", delta: "you said: yo" }, { type: "done", resumeToken: "r1" }]);
  });
});
