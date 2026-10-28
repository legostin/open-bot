import { describe, expect, it } from "vitest";
import { applyActivity, IDLE_VIEW, LIVE_GRACE_MS, liveWindowView, nextChangeAt, phaseOf, PILL_LINGER_MS, type LiveViewState, type LiveWindowChoices } from "./liveview";
import { addLiveView, registry, removePlugin } from "./registry";

const T = 1_000_000;
const none: LiveWindowChoices = { minimized: {}, closed: {} };
const view = (key: string, s: LiveViewState) => ({ key, ...s });

describe("live view phases", () => {
  it("is live while busy and for a grace period after, then a pill, then gone", () => {
    const busy = applyActivity(IDLE_VIEW, { active: true }, T);
    expect(phaseOf(IDLE_VIEW, T)).toBe("gone");
    expect(phaseOf(busy, T + 10 * 60_000)).toBe("live");
    const done = applyActivity(busy, { active: false }, T + 5000);
    expect(phaseOf(done, T + 5000 + LIVE_GRACE_MS - 1)).toBe("live");
    expect(phaseOf(done, T + 5000 + LIVE_GRACE_MS)).toBe("linger");
    expect(phaseOf(done, T + 5000 + LIVE_GRACE_MS + PILL_LINGER_MS)).toBe("gone");
    expect(nextChangeAt([done], T + 6000)).toBe(T + 5000 + LIVE_GRACE_MS);
    expect(nextChangeAt([done], T + 5000 + LIVE_GRACE_MS)).toBe(T + 5000 + LIVE_GRACE_MS + PILL_LINGER_MS);
    expect(nextChangeAt([busy, IDLE_VIEW], T)).toBeUndefined();
  });

  it("counts user control and attention as busy", () => {
    expect(phaseOf(applyActivity(IDLE_VIEW, { userControl: true }, T), T + 99 * 60_000)).toBe("live");
    expect(phaseOf(applyActivity(IDLE_VIEW, { attention: true }, T), T + 99 * 60_000)).toBe("live");
  });

  it("starts a new burst when an idle view gets busy or asks for the user, not between close tool calls", () => {
    const a = applyActivity(IDLE_VIEW, { active: true }, T);
    expect(a.burst).toBe(1);
    const gap = applyActivity(applyActivity(a, { active: false }, T + 1000), { active: true }, T + 3000);
    expect(gap.burst).toBe(1);
    const later = applyActivity(applyActivity(gap, { active: false }, T + 4000), { active: true }, T + 4000 + LIVE_GRACE_MS + 1);
    expect(later.burst).toBe(2);
    expect(applyActivity(later, { attention: true }, T + 5000 + LIVE_GRACE_MS).burst).toBe(3);
  });
});

describe("liveWindowView", () => {
  const busy = view("b", applyActivity(IDLE_VIEW, { active: true }, T));

  it("is hidden with no activity and opens the compact window on its own", () => {
    expect(liveWindowView([view("x", IDLE_VIEW)], none, T).mode).toBe("hidden");
    expect(liveWindowView([busy], none, T)).toMatchObject({ mode: "mini", current: busy });
  });

  it("turns into a pill after the grace period and disappears after the linger", () => {
    const done = view("b", applyActivity(busy, { active: false }, T));
    expect(liveWindowView([done], none, T + LIVE_GRACE_MS + 1).mode).toBe("pill");
    expect(liveWindowView([done], none, T + LIVE_GRACE_MS + PILL_LINGER_MS + 1).mode).toBe("hidden");
  });

  it("keeps minimize and close for the burst only; attention reopens", () => {
    const min = { ...none, minimized: { b: busy.burst } };
    expect(liveWindowView([busy], min, T).mode).toBe("pill");
    const closed = { ...none, closed: { b: busy.burst } };
    expect(liveWindowView([busy], closed, T).mode).toBe("hidden");
    const asks = view("b", applyActivity(busy, { attention: true }, T + 1000));
    expect(liveWindowView([asks], min, T + 1000).mode).toBe("mini");
    expect(liveWindowView([asks], closed, T + 1000).mode).toBe("mini");
  });

  it("shows the expanded view even when idle, and prefers attention, then the selection, then the latest", () => {
    expect(liveWindowView([view("x", IDLE_VIEW)], { ...none, expanded: "x" }, T).mode).toBe("expanded");
    const older = view("o", applyActivity(IDLE_VIEW, { active: true }, T - 5000));
    const newer = view("n", applyActivity(IDLE_VIEW, { active: true }, T));
    expect(liveWindowView([older, newer], none, T).current).toBe(newer);
    expect(liveWindowView([older, newer], { ...none, selected: "o" }, T).current).toBe(older);
    const needs = view("o", applyActivity(older, { attention: true }, T));
    expect(liveWindowView([needs, newer], { ...none, selected: "n" }, T).current).toBe(needs);
  });
});

describe("addLiveView", () => {
  it("registers, updates activity and disposes", () => {
    const C = () => null;
    const h = addLiveView("p", { id: "screen", title: "Screen", component: C });
    const get = () => registry.get().liveViews.find((v) => v.pluginId === "p" && v.id === "screen");
    expect(get()).toMatchObject({ title: "Screen", activity: { active: false }, burst: 0 });
    h.update({ active: true, agentId: "assistant", status: "Working" });
    expect(get()).toMatchObject({ activity: { active: true, agentId: "assistant", status: "Working" }, burst: 1 });
    h.dispose();
    expect(get()).toBeUndefined();
    addLiveView("p", { id: "again", title: "Again", component: C });
    removePlugin("p");
    expect(registry.get().liveViews.filter((v) => v.pluginId === "p")).toEqual([]);
    expect(() => addLiveView("p", { id: "x", title: "X" } as never)).toThrow();
  });
});
