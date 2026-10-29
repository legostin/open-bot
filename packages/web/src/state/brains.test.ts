// The brains list follows the hub: every change asks again, also one that comes while a request is on its way
// (right after a restart the hub answers before its brains have connected).
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the brains list", () => {
  it("asks the hub again after each change, and once more for a change during a request", async () => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {}, location: { pathname: "/", hash: "", search: "" } });
    vi.stubGlobal("location", { pathname: "/", hash: "", search: "", href: "http://hub.local/", protocol: "http:", host: "hub.local" });
    vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: "visible", cookie: "", documentElement: { lang: "" } });
    const answers = [[{ ref: "claude-code@local", label: "Claude Code", connected: false }], [{ ref: "claude-code@local", label: "Claude Code", connected: true }]];
    let n = 0;
    const fetch = vi.fn(async () => new Response(JSON.stringify(answers[Math.min(n++, answers.length - 1)]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { brains, refreshBrains } = await import("./brains");

    const first = refreshBrains();
    // A brain connects while the first answer is on its way.
    void refreshBrains();
    await first;
    expect(brains.get()?.[0].connected).toBe(false);
    await vi.waitFor(() => expect(brains.get()?.[0].connected).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(2);

    // Later changes are asked again, not answered from the first request.
    await refreshBrains();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
