// The Composio integration against a fake Composio: the entries wait for the key, sign in through Composio's own OAuth
// app (one auth config per app, a link, polling until the account works), a connected app's main tools become tools
// of their own (a read only when tagged readOnlyHint), the agent finds and adds other apps and tools, and a refused
// key, a used-up quota, an outage, an expired link and signing out each end where the person can act.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { effectOf, resultText, specOf, toolName } from "../server/tools.ts";

const dir = join(import.meta.dirname, "..");
const LONG = "SLACK_" + "VERY_LONG_TOOL_NAME_".repeat(4) + "THAT_GOES_ON";

const kits: Record<string, any> = {
  slack: { slug: "slack", name: "Slack", meta: { description: "Team chat" }, composio_managed_auth_schemes: ["OAUTH2"] },
  github: { slug: "github", name: "GitHub", meta: { description: "Code hosting" }, composio_managed_auth_schemes: ["OAUTH2"] },
  dropbox: { slug: "dropbox", name: "Dropbox", meta: { description: "Files" }, composio_managed_auth_schemes: ["OAUTH2"] },
  trello: { slug: "trello", name: "Trello", meta: { description: "Boards and cards" }, composio_managed_auth_schemes: ["OAUTH1"] },
  custom: { slug: "custom", name: "Custom CRM", meta: { description: "Needs your own client" }, composio_managed_auth_schemes: [] },
};

const tools: Record<string, { important: any[]; all: any[] }> = {
  slack: {
    important: [
      { slug: "SLACK_SEND_MESSAGE", name: "Send message", description: "Posts a message", input_parameters: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } }, tags: ["createHint"], version: "20250101_00", toolkit: { slug: "slack" } },
      { slug: "SLACK_FETCH_CONVERSATION_HISTORY", name: "Fetch history", description: "Reads a channel", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint", "important"], version: "20250101_00", toolkit: { slug: "slack" } },
      { slug: LONG, name: "Long one", description: "Has a long name", input_parameters: { type: "object", properties: {} }, toolkit: { slug: "slack" } },
      { slug: "SLACK_FAIL", name: "Fails", description: "Always fails", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "slack" } },
    ],
    all: [{ slug: "SLACK_LIST_REMINDERS", name: "List reminders", description: "Lists reminders", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "slack" } }],
  },
  github: {
    important: [],
    all: [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues", input_parameters: { type: "object", properties: { repo: { type: "string" } } }, tags: ["readOnlyHint"], toolkit: { slug: "github" } }],
  },
};

function fakeComposio() {
  const authConfigs: any[] = [];
  const links: any[] = [];
  const executed: Array<{ slug: string; body: any }> = [];
  const deleted: string[] = [];
  const accounts = new Map<string, { status: string; toolkit: string }>();
  const state = { mode: "ok" as "ok" | "limit" | "down", expired: false, n: 0 };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const key = req.headers["x-api-key"];
      if (key !== "good") return send(401, { error: { message: "Invalid API key" } });
      if (state.mode === "limit") return send(429, { error: { message: "Monthly limit reached" } });
      if (state.mode === "down") return send(503, { message: "Service unavailable" });
      const path = u.pathname.replace(/^\/api\/v3\.1/, "");
      let m: RegExpExecArray | null;
      if (req.method === "GET" && path === "/toolkits") {
        const q = (u.searchParams.get("search") ?? "").toLowerCase();
        return send(200, { items: Object.values(kits).filter((k) => k.slug.includes(q) || k.name.toLowerCase().includes(q)) });
      }
      if (req.method === "GET" && (m = /^\/toolkits\/([^/]+)$/.exec(path))) return kits[m[1]!] ? send(200, kits[m[1]!]) : send(404, { message: "No such toolkit" });
      if (req.method === "POST" && path === "/auth_configs") {
        authConfigs.push(body);
        return send(201, { toolkit: { slug: body.toolkit.slug }, auth_config: { id: `ac_${body.toolkit.slug}`, is_composio_managed: true } });
      }
      if (req.method === "POST" && path === "/connected_accounts/link") {
        links.push(body);
        const id = `ca_${++state.n}`;
        accounts.set(id, { status: "INITIATED", toolkit: String(body.auth_config_id).replace(/^ac_/, "") });
        return send(201, { redirect_url: `https://connect.composio.dev/link/ln_${state.n}`, link_token: "lt", connected_account_id: id, expires_at: new Date(Date.now() + (state.expired ? -1000 : 600_000)).toISOString() });
      }
      if ((m = /^\/connected_accounts\/([^/]+)$/.exec(path))) {
        const a = accounts.get(m[1]!);
        if (!a) return send(404, { message: "No such account" });
        if (req.method === "DELETE") {
          accounts.delete(m[1]!);
          deleted.push(m[1]!);
          return send(200, { success: true });
        }
        return send(200, { id: m[1], status: a.status, toolkit: { slug: a.toolkit }, status_reason: null });
      }
      if (req.method === "GET" && path === "/tools") {
        const t = tools[u.searchParams.get("toolkit_slug") ?? ""];
        if (!t) return send(200, { items: [] });
        if (u.searchParams.get("important") === "true") return send(200, { items: t.important });
        const q = (u.searchParams.get("query") ?? "").toLowerCase();
        return send(200, { items: t.all.filter((x) => !q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)) });
      }
      if (req.method === "POST" && (m = /^\/tools\/execute\/([^/]+)$/.exec(path))) {
        executed.push({ slug: m[1]!, body });
        if (m[1] === "SLACK_FAIL") return send(200, { successful: false, data: { ok: false }, error: "channel_not_found" });
        return send(200, { successful: true, data: { ok: true, echo: body.arguments }, error: null, log_id: "log_1" });
      }
      send(404, { message: `no route ${req.method} ${path}` });
    });
  });
  return { server, authConfigs, links, executed, deleted, accounts, state };
}

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("the Composio integration", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let h: PluginHarness;
  const entry = (id: string) => h.catalog.find((e) => e.id === id);

  beforeAll(async () => {
    fake = fakeComposio();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({ dir, settings: { apiUrl: `http://127.0.0.1:${(fake.server.address() as any).port}/api/v3.1`, pollMs: 30 } });
  });

  afterAll(async () => {
    await h?.stop();
    fake?.server.close();
  });

  it("names tools within 64 characters and reads only what is tagged read-only", () => {
    expect(toolName("SLACK_SEND_MESSAGE")).toBe("slack_send_message");
    const long = toolName(LONG);
    expect(long.length).toBeLessThanOrEqual(64 - "composio_".length);
    expect(long).toMatch(/^slack_very_long_.*_[0-9a-f]{6}$/);
    expect(toolName(LONG + "_2")).not.toBe(long);
    expect(effectOf(["readOnlyHint", "idempotentHint"])).toBe("read");
    expect(effectOf(["createHint"])).toBe("external");
    expect(effectOf([])).toBe("external");
    const spec = specOf({ slug: "SLACK_SEND_MESSAGE", name: "Send {message}", description: "Posts", inputSchema: { type: "object" }, tags: [], toolkit: "slack" }, "Slack");
    expect(spec).toMatchObject({ name: "slack_send_message", effect: "external", source: true, approvalSummary: "Slack: Send message", description: "Slack through Composio: Posts" });
    expect(resultText("x".repeat(30), 10)).toBe("xxxxxxxxxx… (cut: 20 more characters)");
  });

  it("lists its apps waiting for the Composio key", async () => {
    await until(() => h.catalog.length, "the first report");
    expect(h.catalog.map((e) => e.id)).toEqual(["slack", "github", "gmail", "googledrive", "googledocs", "googlesheets", "hubspot", "dropbox", "box"]);
    expect(h.catalog.every((e) => e.status === "needs-setup" && e.connect === "setup")).toBe(true);
    const r = await h.invoke("apps_search", { query: "trello" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Composio has no key yet");
    await expect(h.catalogSignIn("slack")).rejects.toThrow(/no key/);
  });

  it("signs in to an app with Composio's own OAuth app once the key is stored", async () => {
    h.setVault("composio", { value: "good" });
    await until(() => entry("slack")?.connect === "signin", "the Sign in step");
    const { url } = await h.catalogSignIn("slack");
    expect(url).toBe("https://connect.composio.dev/link/ln_1");
    expect(fake.authConfigs).toEqual([{ toolkit: { slug: "slack" }, auth_config: { type: "use_composio_managed_auth" } }]);
    expect(fake.links[0]).toMatchObject({ auth_config_id: "ac_slack", user_id: expect.stringMatching(/^owlbot-[0-9a-f-]{36}$/) });
    expect(entry("slack")).toMatchObject({ status: "needs-setup", connect: "signin", detail: "%detail.waiting%" });

    fake.accounts.get("ca_1")!.status = "ACTIVE";
    await until(() => entry("slack")?.status === "connected", "slack connected");
    // Its main tools are tools of their own: a read only when tagged so, the long name cut.
    expect(h.tools.get("slack_send_message")).toMatchObject({ effect: "external", source: true, approvalSummary: "Slack: Send message" });
    expect(h.tools.get("slack_fetch_conversation_history")).toMatchObject({ effect: "read", source: true });
    expect(h.tools.get(toolName(LONG))).toMatchObject({ effect: "external" });
    expect([...h.tools.keys()].every((n) => n.length <= 55)).toBe(true);
  });

  it("runs a connected app's tools on its account, with the pinned version", async () => {
    const r = await h.invoke("slack_send_message", { channel: "general", text: "hi" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ ok: true, echo: { channel: "general", text: "hi" } });
    expect(fake.executed.at(-1)).toMatchObject({
      slug: "SLACK_SEND_MESSAGE",
      body: { connected_account_id: "ca_1", user_id: fake.links[0].user_id, arguments: { channel: "general", text: "hi" }, version: "20250101_00" },
    });
    const failed = await h.invoke("slack_fail", {});
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("Slack did not do it: channel_not_found");
  });

  it("finds and runs a connected app's other tools", async () => {
    const found = await h.invokeText("tools_search", { app: "composio:slack", query: "reminders" });
    expect(found).toContain("SLACK_LIST_REMINDERS — List reminders (reads)");
    expect(h.tools.get("tool_run")).toMatchObject({ effect: "external", approvalSummary: "%approval.run%" });
    const r = await h.invoke("tool_run", { tool: "slack_list_reminders", arguments: { user: "me" } });
    expect(r.isError).toBeFalsy();
    expect(fake.executed.at(-1)).toMatchObject({ slug: "SLACK_LIST_REMINDERS", body: { connected_account_id: "ca_1", arguments: { user: "me" } } });
    const none = await h.invoke("tool_run", { tool: "HUBSPOT_LIST_DEALS" });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain("connected ones are composio:slack");
  });

  it("gives an app without main tools its first ones", async () => {
    await h.catalogSignIn("github");
    fake.accounts.get("ca_2")!.status = "ACTIVE";
    await until(() => entry("github")?.status === "connected", "github connected");
    await until(() => h.tools.get("github_list_issues"), "github's tools");
    expect(h.tools.get("github_list_issues")).toMatchObject({ effect: "read" });
    // Signing in to Slack again reuses its auth config.
    expect(fake.authConfigs.map((a) => a.toolkit.slug)).toEqual(["slack", "github"]);
  });

  it("adds apps from the chat when Composio can sign in to them, and drops them on sign-out", async () => {
    const found = await h.invokeText("apps_search", { query: "" });
    expect(found).toContain("trello — Trello: Boards and cards [Composio signs in by itself]");
    expect(found).toContain("custom — Custom CRM: Needs your own client [needs its own OAuth client: cannot be added]");
    expect(found).toContain("In the catalog as composio:slack, connected.");
    const refused = await h.invoke("app_add", { app: "custom" });
    expect(refused.isError).toBe(true);
    expect(await h.invokeText("app_add", { app: "slack" })).toContain("in the catalog already as composio:slack");
    expect(await h.invokeText("app_add", { app: "Trello" })).toContain("Added Trello to the catalog as composio:trello");
    expect(entry("trello")).toEqual({ id: "trello", name: "Trello", summary: "%entry.added%", category: "other", icon: "plug", status: "needs-setup", connect: "signin" });
    await h.catalogSignOut("trello");
    expect(entry("trello")).toBeUndefined();
  });

  it("stops waiting when the link runs out", async () => {
    fake.state.expired = true;
    await h.catalogSignIn("dropbox");
    fake.state.expired = false;
    expect(entry("dropbox")).toMatchObject({ detail: "%detail.waiting%" });
    await until(() => entry("dropbox") && !entry("dropbox")!.detail, "the link given up");
    expect(entry("dropbox")).toMatchObject({ status: "needs-setup", connect: "signin" });
  });

  it("says when Composio's quota is used up or it is down, and asks for a new key when it refuses one", async () => {
    fake.state.mode = "limit";
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Composio's limit of calls is used up (Monthly limit reached)");
    fake.state.mode = "down";
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Composio is unreachable right now");
    await expect(h.catalogSignIn("box")).rejects.toThrow(/unreachable/);
    fake.state.mode = "ok";

    h.setVault("composio", { value: "revoked" });
    await until(() => entry("slack")?.status === "broken", "the refused key");
    expect(h.catalog.every((e) => e.status === "broken" && e.connect === "setup" && e.detail === "%detail.key%")).toBe(true);
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Composio refused its API key");

    h.setVault("composio", { value: "good" });
    await until(() => entry("slack")?.status === "connected", "slack back with a good key");
  });

  it("signs out at Composio and takes the app's tools back", async () => {
    await h.catalogSignOut("slack");
    expect(fake.deleted).toContain("ca_1");
    expect(entry("slack")).toMatchObject({ status: "needs-setup", connect: "signin" });
    expect(h.tools.get("slack_send_message")).toBeUndefined();
    expect(textOf(await h.invoke("tool_run", { tool: "SLACK_LIST_REMINDERS" }))).toContain("No connected Composio app has SLACK_LIST_REMINDERS");
    expect(h.tools.get("github_list_issues")).toBeDefined();
  });
});
