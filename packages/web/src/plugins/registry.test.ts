import { describe, expect, it } from "vitest";
import type { SlotName } from "@piomio/ui";
import { addContribution, addRoute, inSlot, matchRoute, normalizePath, pickMessageRenderer, pickOverride, pickToolRenderer, registry, removePlugin, type Contribution } from "./registry";
import { resolveActivate } from "./activate";

const C = () => null;
let seq = 0;
const c = (slot: SlotName, extra: Partial<Contribution> = {}): Contribution => ({ id: `c${++seq}`, key: `k${seq}`, seq, pluginId: "p", slot, component: C, ...extra });

describe("pickToolRenderer", () => {
  it("matches tool names by glob and prefers priority, then specificity, then latest", () => {
    const generic = c("chat.toolResult", { match: { tool: ["browser_*"] } });
    const exact = c("chat.toolResult", { match: { tool: ["browser_screenshot"] } });
    const other = c("chat.toolResult", { match: { tool: ["memory_*"] } });
    const list = [generic, exact, other];
    expect(pickToolRenderer(list, "browser_open")).toBe(generic);
    expect(pickToolRenderer(list, "browser_screenshot")).toBe(exact);
    expect(pickToolRenderer(list, "fs_read")).toBeUndefined();
    const prio = c("chat.toolResult", { match: { tool: ["*"] }, priority: 5 });
    expect(pickToolRenderer([...list, prio], "browser_screenshot")).toBe(prio);
  });
  it("accepts a single glob string", () => {
    const x = c("chat.toolResult", { match: { tool: "browser.*" as unknown as string[] } });
    expect(pickToolRenderer([x], "browser.open")).toBe(x);
  });
});

describe("pickMessageRenderer / pickOverride", () => {
  it("filters by role and agent", () => {
    const anyMsg = c("chat.message");
    const userOnly = c("chat.message", { match: { role: "user" }, priority: 1 });
    const agentOnly = c("chat.message", { match: { agentId: "coder" }, priority: 2 });
    const list = [anyMsg, userOnly, agentOnly];
    expect(pickMessageRenderer(list, { role: "assistant", agentId: "assistant" })).toBe(anyMsg);
    expect(pickMessageRenderer(list, { role: "user" })).toBe(userOnly);
    expect(pickMessageRenderer(list, { role: "assistant", agentId: "coder" })).toBe(agentOnly);
  });
  it("picks the highest-priority override, latest on ties", () => {
    const a = c("chat.composer", { priority: 10 });
    const b = c("chat.composer", { priority: 1 });
    const d = c("chat.composer", { priority: 10 });
    expect(pickOverride([a, b, d], "chat.composer")).toBe(d);
    expect(pickOverride([b], "chat.message")).toBeUndefined();
  });
  it("orders slot contents by priority then registration", () => {
    const a = c("sidebar.panel");
    const b = c("sidebar.panel", { priority: 3 });
    expect(inSlot([a, b, c("pane.right")], "sidebar.panel")).toEqual([b, a]);
  });
});

describe("registry store", () => {
  it("adds and removes contributions per plugin", () => {
    const off = addContribution("alpha", "pane.right", { id: "x", component: C });
    addContribution("beta", "pane.right", { id: "y", component: C });
    addRoute("alpha", { path: "plugins/alpha/", title: "A", component: C });
    expect(registry.get().contributions.map((x) => x.pluginId)).toEqual(["alpha", "beta"]);
    expect(registry.get().routes[0].path).toBe("/plugins/alpha");
    off();
    expect(registry.get().contributions.map((x) => x.pluginId)).toEqual(["beta"]);
    removePlugin("alpha");
    removePlugin("beta");
    expect(registry.get().contributions).toEqual([]);
    expect(registry.get().routes).toEqual([]);
  });
  it("rejects contributions without a component", () => {
    expect(() => addContribution("p", "pane.right", { id: "x" } as never)).toThrow();
  });
});

describe("routes", () => {
  const r = (path: string) => ({ pluginId: "p", key: path, path, title: path, component: C, nav: true });
  it("normalizes paths", () => {
    expect(normalizePath("x/y/")).toBe("/x/y");
    expect(normalizePath("/")).toBe("/");
  });
  it("matches exact paths and /* prefixes", () => {
    const routes = [r("/plugins/browser"), r("/plugins/files/*")];
    expect(matchRoute(routes, "/plugins/browser")?.path).toBe("/plugins/browser");
    expect(matchRoute(routes, "/plugins/browser/x")).toBeUndefined();
    expect(matchRoute(routes, "/plugins/files/a/b")?.path).toBe("/plugins/files/*");
    expect(matchRoute(routes, "/plugins/files")?.path).toBe("/plugins/files/*");
    expect(matchRoute(routes, "/plugins")).toBeUndefined();
  });
});

describe("resolveActivate", () => {
  it("finds activate in named, definePluginUI-style default, or function default exports", () => {
    const fn = () => {};
    expect(resolveActivate({ activate: fn })).toBe(fn);
    expect(typeof resolveActivate({ default: { activate: fn } })).toBe("function");
    expect(resolveActivate({ default: fn })).toBe(fn);
    expect(resolveActivate({ other: 1 })).toBeUndefined();
    expect(resolveActivate(null)).toBeUndefined();
  });
});
