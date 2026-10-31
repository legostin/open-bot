// The Composio integration against a fake Composio: the entries wait for the key, sign in through Composio's own OAuth
// app (one auth config per app, made again when Composio lost it; a link; polling until the account works), accounts
// nobody waits for are deleted at Composio, a connected app's main tools become tools of their own (a read only when
// tagged read-only and nothing else; the approval card names what they act on), the agent finds and adds other apps
// and tools, and a refused key, a used-up plan, too many calls, an outage, an expired link and signing out each end
// where the person can act.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { approvalOf, effectOf, resultText, specOf, toolName } from "../server/tools.ts";

const dir = join(import.meta.dirname, "..");
const LONG = "SLACK_" + "VERY_LONG_TOOL_NAME_".repeat(4) + "THAT_GOES_ON";

const kits: Record<string, any> = {
  slack: { slug: "slack", name: "Slack", meta: { description: "Team chat" }, composio_managed_auth_schemes: ["OAUTH2"] },
  github: { slug: "github", name: "GitHub", meta: { description: "Code hosting" }, composio_managed_auth_schemes: ["OAUTH2"] },
  dropbox: { slug: "dropbox", name: "Dropbox", meta: { description: "Files" }, composio_managed_auth_schemes: ["OAUTH2"] },
  box: { slug: "box", name: "Box", meta: { description: "Files" }, composio_managed_auth_schemes: ["OAUTH2"] },
  asana: { slug: "asana", name: "Asana", meta: { description: "Tasks and projects" }, composio_managed_auth_schemes: ["OAUTH2"] },
  custom: { slug: "custom", name: "Custom CRM", meta: { description: "Needs your own client" }, composio_managed_auth_schemes: [] },
  hackernews: { slug: "hackernews", name: "Hacker News", meta: { description: "No sign-in" }, no_auth: true },
};

const tools: Record<string, { important: any[]; all: any[] }> = {
  slack: {
    important: [
      {
        slug: "SLACK_SEND_MESSAGE",
        name: "Send message",
        description: "Posts a message",
        input_parameters: { type: "object", properties: { text: { type: "string" }, channel: { type: "string" }, "bad-name": { type: "string" } }, required: ["channel"] },
        tags: ["createHint"],
        version: "20250101_00",
        toolkit: { slug: "slack" },
      },
      { slug: "SLACK_FETCH_CONVERSATION_HISTORY", name: "Fetch history", description: "Reads a channel", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint", "important"], version: "20250101_00", toolkit: { slug: "slack" } },
      { slug: LONG, name: "Long one", description: "Has a long name", input_parameters: { type: "object", properties: {} }, toolkit: { slug: "slack" } },
      { slug: "SLACK_FAIL", name: "Fails", description: "Always fails", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "slack" } },
      { slug: "SLACK_FORBIDDEN", name: "Forbidden", description: "No access", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "slack" } },
    ],
    all: [
      { slug: "SLACK_LIST_REMINDERS", name: "List reminders", description: "Lists reminders", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "slack" } },
      { slug: "SLACK_DELETE_REMINDER", name: "Delete reminder", description: "Deletes a reminder", input_parameters: { type: "object", properties: { id: { type: "string" } } }, tags: ["readOnlyHint", "destructiveHint"], toolkit: { slug: "slack" } },
    ],
  },
  github: {
    important: [],
    all: [
      { slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists issues", input_parameters: { type: "object", properties: { repo: { type: "string" } } }, tags: ["readOnlyHint"], toolkit: { slug: "github" } },
      { slug: "GITHUB_LIST_STARS", name: "List stars", description: "Lists starred repositories", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "github" } },
      { slug: "GITHUB_LIST_WATCHED", name: "List watched", description: "Lists watched repositories", input_parameters: { type: "object", properties: {} }, tags: ["readOnlyHint"], toolkit: { slug: "github" } },
    ],
  },
};

function fakeComposio() {
  const authConfigs: any[] = [];
  const liveConfigs = new Set<string>();
  const links: any[] = [];
  const executed: Array<{ slug: string; body: any }> = [];
  const deleted: string[] = [];
  const accounts = new Map<string, { status: string; toolkit: string }>();
  const state = { mode: "ok" as "ok" | "quota" | "rate" | "down", expired: false, n: 0, failDelete: false };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const key = req.headers["x-api-key"];
      if (key !== "good") return send(401, { error: { message: "Invalid API key" } });
      if (state.mode === "quota") return send(402, { error: { message: "No credits left" } });
      if (state.mode === "rate") return send(429, { error: { message: "Rate limited" } });
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
        const id = `ac_${body.toolkit.slug}_${authConfigs.length}`;
        liveConfigs.add(id);
        return send(201, { toolkit: { slug: body.toolkit.slug }, auth_config: { id, is_composio_managed: true } });
      }
      if (req.method === "POST" && path === "/connected_accounts/link") {
        if (!liveConfigs.has(body.auth_config_id)) return send(404, { error: { message: "Auth config not found" } });
        links.push(body);
        const id = `ca_${++state.n}`;
        accounts.set(id, { status: "INITIATED", toolkit: String(body.auth_config_id).split("_")[1]! });
        return send(201, { redirect_url: `https://connect.composio.dev/link/ln_${state.n}`, link_token: "lt", connected_account_id: id, expires_at: new Date(Date.now() + (state.expired ? -1000 : 600_000)).toISOString() });
      }
      if ((m = /^\/connected_accounts\/([^/]+)$/.exec(path))) {
        const a = accounts.get(m[1]!);
        if (!a) return send(404, { message: "No such account" });
        if (req.method === "DELETE") {
          if (state.failDelete) return send(503, { message: "Service unavailable" });
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
        if (m[1] === "SLACK_FORBIDDEN") return send(403, { error: { message: "Connected account lacks permission for this resource" } });
        // The service refused because the person did not tick every permission on its sign-in page (Google's boxes).
        if (m[1] === "GITHUB_LIST_STARS")
          return send(200, { successful: false, data: { message: "HTTP 403: Request had insufficient authentication scopes.", status_code: 403 }, error: "HTTP 403: Request had insufficient authentication scopes." });
        if (m[1] === "GITHUB_LIST_WATCHED") return send(403, { error: { message: "Request had insufficient authentication scopes." } });
        return send(200, { successful: true, data: { ok: true, echo: body.arguments }, error: null, log_id: "log_1" });
      }
      send(404, { message: `no route ${req.method} ${path}` });
    });
  });
  return { server, authConfigs, liveConfigs, links, executed, deleted, accounts, state };
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
  const keyReads = () => h.vaultGets.filter((id) => id === "composio").length;

  beforeAll(async () => {
    fake = fakeComposio();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({
      dir,
      env: { OWLBOT_COMPOSIO_API: `http://127.0.0.1:${(fake.server.address() as any).port}/api/v3.1`, OWLBOT_COMPOSIO_POLL_MS: "30", OWLBOT_COMPOSIO_GRACE_MS: "1" },
    });
  });

  afterAll(async () => {
    await h?.stop();
    fake?.server.close();
  });

  it("names tools within 64 characters, reads only what is tagged read-only alone, and shows what a write acts on", () => {
    expect(toolName("SLACK_SEND_MESSAGE")).toBe("slack_send_message");
    const long = toolName(LONG);
    expect(long.length).toBeLessThanOrEqual(64 - "composio_".length);
    expect(long).toMatch(/^slack_very_long_.*_[0-9a-f]{6}$/);
    expect(toolName(LONG + "_2")).not.toBe(long);
    expect(effectOf(["readOnlyHint", "idempotentHint"])).toBe("read");
    expect(effectOf(["readOnlyHint", "destructiveHint"])).toBe("external");
    expect(effectOf(["createHint"])).toBe("external");
    expect(effectOf([])).toBe("external");
    const send = { slug: "SLACK_SEND_MESSAGE", name: "Send {message}", description: "Posts", inputSchema: { type: "object", properties: { text: {}, channel: {}, "x-y": {} }, required: ["channel"] }, tags: [], toolkit: "slack" };
    // Required fields first, odd names left out; braces in the name cannot become placeholders.
    expect(approvalOf(send, "Slack")).toBe("Slack: Send message — channel: {channel}, text: {text}");
    expect(approvalOf({ ...send, inputSchema: { type: "object" } }, "Slack")).toBe("Slack: Send message");
    expect(specOf(send, "Slack")).toMatchObject({ name: "slack_send_message", effect: "external", source: true, description: "Slack through Composio: Posts" });
    expect(resultText("x".repeat(30), 10)).toBe("xxxxxxxxxx… (cut: 20 more characters)");
  });

  it("lists its apps waiting for the Composio key", async () => {
    await until(() => h.catalog.length, "the first report");
    expect(h.catalog.map((e) => e.id)).toEqual([
      "slack", "github", "gmail", "googledrive", "googledocs", "googlesheets", "hubspot", "dropbox", "box",
      "googlecalendar", "googletasks", "googlemeet", "outlook", "microsoft_teams", "one_drive", "trello", "jira", "zoom", "calendly", "figma", "salesforce", "linkedin", "youtube", "reddit",
    ]);
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
    expect(fake.links[0]).toMatchObject({ auth_config_id: "ac_slack_1", user_id: expect.stringMatching(/^owlbot-[0-9a-f-]{36}$/) });
    expect(entry("slack")).toMatchObject({ status: "needs-setup", connect: "signin", detail: "%detail.waiting%" });

    fake.accounts.get("ca_1")!.status = "ACTIVE";
    await until(() => entry("slack")?.status === "connected", "slack connected");
    // Its main tools are tools of their own: a read only when tagged so, the card naming what a write acts on.
    expect(h.tools.get("slack_send_message")).toMatchObject({ effect: "external", source: true, approvalSummary: "Slack: Send message — channel: {channel}, text: {text}" });
    expect(h.tools.get("slack_fetch_conversation_history")).toMatchObject({ effect: "read", source: true });
    expect(h.tools.get(toolName(LONG))).toMatchObject({ effect: "external" });
    expect([...h.tools.keys()].every((n) => n.length <= 55)).toBe(true);
  });

  it("runs a connected app's tools on its account, reading the key only once", async () => {
    const reads = keyReads();
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
    // An account without access is the request's problem, not the key's.
    const forbidden = await h.invoke("slack_forbidden", {});
    expect(textOf(forbidden)).toContain("Slack: Connected account lacks permission");
    expect(entry("slack")).toMatchObject({ status: "connected" });
    expect(keyReads()).toBe(reads);
  });

  it("finds a connected app's other tools, makes them tools of their own, and runs one by name", async () => {
    const found = await h.invokeText("tools_search", { app: "composio:slack", query: "reminder" });
    expect(found).toContain("SLACK_LIST_REMINDERS — List reminders (composio_slack_list_reminders) (reads)");
    expect(found).toContain("SLACK_DELETE_REMINDER — Delete reminder (composio_slack_delete_reminder) (changes something: asks the user)");
    expect(h.tools.get("slack_list_reminders")).toMatchObject({ effect: "read" });
    expect(h.tools.get("slack_delete_reminder")).toMatchObject({ effect: "external", approvalSummary: "Slack: Delete reminder — id: {id}" });
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
    expect(fake.authConfigs.map((a) => a.toolkit.slug)).toEqual(["slack", "github"]);
  });

  it("adds apps from the chat when Composio can sign in to them, and drops them on sign-out", async () => {
    const found = await h.invokeText("apps_search", { query: "" });
    expect(found).toContain("asana — Asana: Tasks and projects [Composio signs in by itself]");
    expect(found).toContain("custom — Custom CRM: Needs your own client [Composio cannot sign in by itself: cannot be added]");
    expect(found).toContain("hackernews — Hacker News: No sign-in [Composio cannot sign in by itself: cannot be added]");
    expect(found).toContain("In the catalog as composio:slack, connected.");
    expect((await h.invoke("app_add", { app: "custom" })).isError).toBe(true);
    expect(await h.invokeText("app_add", { app: "slack" })).toContain("in the catalog already as composio:slack");
    expect(await h.invokeText("app_add", { app: "Asana" })).toContain("Added Asana to the catalog as composio:asana");
    expect(entry("asana")).toEqual({ id: "asana", name: "Asana", summary: "%entry.added%", category: "other", icon: "plug", status: "needs-setup", connect: "signin" });
    await h.catalogSignOut("asana");
    expect(entry("asana")).toBeUndefined();
  });

  it("deletes at Composio an account a newer sign-in replaces, and one whose link ran out", async () => {
    await h.catalogSignIn("box");
    const first = fake.links.length;
    await h.catalogSignIn("box");
    // The first link's account goes; only the newer one is waited for.
    await until(() => fake.deleted.includes(`ca_${first}`), "the replaced account deleted");
    fake.accounts.get(`ca_${first + 1}`)!.status = "ACTIVE";
    await until(() => entry("box")?.status === "connected", "box connected");

    fake.state.expired = true;
    await h.catalogSignIn("dropbox");
    fake.state.expired = false;
    const id = `ca_${fake.state.n}`;
    expect(entry("dropbox")).toMatchObject({ detail: "%detail.waiting%" });
    await until(() => entry("dropbox") && !entry("dropbox")!.detail, "the link given up");
    expect(entry("dropbox")).toMatchObject({ status: "needs-setup", connect: "signin" });
    await until(() => fake.deleted.includes(id), "the given-up account deleted");
  });

  it("makes the auth config again when Composio lost it", async () => {
    fake.liveConfigs.delete("ac_slack_1");
    const { url } = await h.catalogSignIn("slack");
    expect(url).toMatch(/^https:\/\/connect\.composio\.dev\/link\//);
    expect(fake.authConfigs.at(-1)).toEqual({ toolkit: { slug: "slack" }, auth_config: { type: "use_composio_managed_auth" } });
    expect(fake.links.at(-1)).toMatchObject({ auth_config_id: `ac_slack_${fake.authConfigs.length}` });
    // Slack still works on its old account while the new sign-in waits.
    expect(entry("slack")).toMatchObject({ status: "connected" });
    fake.accounts.get(`ca_${fake.state.n}`)!.status = "ACTIVE";
    await until(() => fake.deleted.includes("ca_1"), "the old account replaced");
    expect(entry("slack")).toMatchObject({ status: "connected" });
  });

  it("says when the plan is used up, calls come too fast or Composio is down, and asks for a new key when it refuses one", async () => {
    fake.state.mode = "quota";
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Composio's plan has no calls left (No credits left)");
    fake.state.mode = "rate";
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Too many calls just now (Rate limited)");
    fake.state.mode = "down";
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Composio is unreachable right now");
    await expect(h.catalogSignIn("hubspot")).rejects.toThrow(/unreachable/);
    fake.state.mode = "ok";
    expect(entry("slack")).toMatchObject({ status: "connected" });

    h.setVault("composio", { value: "revoked" });
    await until(() => entry("slack")?.status === "broken", "the refused key");
    expect(h.catalog.every((e) => e.status === "broken" && e.connect === "setup" && e.detail === "%detail.key%")).toBe(true);
    expect(textOf(await h.invoke("slack_fetch_conversation_history", {}))).toContain("Composio refused its API key");

    h.setVault("composio", { value: "good" });
    await until(() => entry("slack")?.status === "connected", "slack back with a good key");
  });

  it("checks everything again when the vault is unlocked", async () => {
    const reads = keyReads();
    h.emit("vault.state", { state: "unlocked" });
    await until(() => keyReads() > reads, "the key read again");
    await until(() => entry("slack")?.status === "connected" && h.tools.get("slack_send_message"), "slack still connected");
  });

  it("asks for a new sign-in when the service says a permission was not given, and is fine once it is", async () => {
    await until(() => h.tools.get("github_list_stars"), "github's tools");
    const r = await h.invoke("github_list_stars", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("GitHub was not given the permission this needs");
    expect(textOf(r)).toContain("hub_integration_connect id composio:github");
    await until(() => entry("github")?.status === "broken", "github asking for a new sign-in");
    expect(entry("github")).toMatchObject({ status: "broken", connect: "signin", detail: "%detail.scopes%" });
    // The same refusal as an HTTP error reads the same.
    expect(textOf(await h.invoke("github_list_watched", {}))).toContain("GitHub was not given the permission this needs");

    await h.catalogSignIn("github");
    fake.accounts.get(`ca_${fake.state.n}`)!.status = "ACTIVE";
    await until(() => entry("github")?.status === "connected", "github signed in again");
    expect(entry("github")!.detail).toBeUndefined();
  });

  it("signs out at Composio first, keeps everything when that fails, and takes the app's tools back", async () => {
    const slackAccount = [...fake.accounts.entries()].find(([, a]) => a.toolkit === "slack" && a.status === "ACTIVE")![0];
    fake.state.failDelete = true;
    await expect(h.catalogSignOut("slack")).rejects.toThrow(/unreachable/);
    expect(entry("slack")).toMatchObject({ status: "connected" });
    expect(h.tools.get("slack_send_message")).toBeDefined();
    fake.state.failDelete = false;

    await h.catalogSignOut("slack");
    expect(fake.deleted).toContain(slackAccount);
    expect(entry("slack")).toMatchObject({ status: "needs-setup", connect: "signin" });
    expect(h.tools.get("slack_send_message")).toBeUndefined();
    expect(h.tools.get("slack_list_reminders")).toBeUndefined();
    expect(textOf(await h.invoke("tool_run", { tool: "SLACK_LIST_REMINDERS" }))).toContain("No connected Composio app has SLACK_LIST_REMINDERS");
    expect(h.tools.get("github_list_issues")).toBeDefined();
  });
});
