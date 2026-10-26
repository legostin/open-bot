// End-to-end tests of the hub with a scripted brain plugin (test/fixtures/plugins/fakebrain).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { createCoreCall } from "../src/core-call.ts";

const fixtures = join(import.meta.dirname, "fixtures");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

/** Minimal browser-like client: one cookie jar, Origin header, CSRF header when known. */
class Client {
  cookie = "";
  csrf = "";
  base: string;
  origin: string;
  constructor(base: string, origin = base) {
    this.base = base;
    this.origin = origin;
  }
  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.origin ? { origin: this.origin } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-csrf": this.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json };
  }
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
}

describe("hub (integration)", () => {
  let hub: Hub;
  let web: Client;
  let consoleClient: Client;
  let conv: string;

  const lastReply = async (conversationId: string, match: RegExp) =>
    until(async () => {
      const msgs: any[] = await web.req("GET", `/api/conversations/${conversationId}/messages`);
      return msgs.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && match.test(p.text)));
    }, `reply matching ${match}`);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { OWLBOT_PORT: String(port), OWLBOT_CONSOLE_PORT: String(consolePort), OWLBOT_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-hub-")), builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    consoleClient = new Client(config.consoleUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2@local"), "fake brains to register");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("requires setup token, session cookie, CSRF and same Origin", async () => {
    expect((await web.raw("GET", "/api/bootstrap")).status).toBe(401);
    expect((await web.raw("POST", "/api/auth/setup", { token: "wrong", password: "integration-pass-1" })).status).toBeGreaterThanOrEqual(400);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await web.req("GET", "/api/bootstrap");
    conv = boot.mainConversationId;

    expect((await web.raw("POST", "/api/conversations", { title: "x" })).status).toBe(403); // no CSRF yet
    web.csrf = boot.csrf;
    expect((await web.raw("POST", "/api/conversations", { title: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await web.raw("POST", "/api/conversations", { title: "x" })).status).toBe(200);
    await web.req("PATCH", "/api/settings", { approvalInlineWaitSec: 1 });
  });

  it("runs a chat turn on the first brain", async () => {
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: "hello there" });
    const m = await lastReply(conv, /fake heard: hello there/);
    expect(m.brainRef).toBe("fake@local");
  });

  it("routes channel messages to the default agent's dialog and shows it in the team", async () => {
    const seen: any[] = [];
    const off = hub.bus.on("team.updated", (m) => seen.push(m));
    try {
      const r = (await createCoreCall(hub)("fakebrain", "channels.inbound", { channel: "test", text: "from the channel" })) as any;
      expect(r.conversationId).toBe(conv);
      expect(hub.store.agentConversation("assistant").id).toBe(conv);
      await lastReply(conv, /fake heard: from the channel/);
      await until(() => {
        const mine = seen.filter((m) => m.conversationId === conv);
        return mine.some((m) => m.running) && mine.at(-1)?.running === false;
      }, "the turn to start and end");

      const team: any[] = await web.req("GET", "/api/team");
      const me = team.find((m) => m.agentId === "assistant");
      expect(me).toMatchObject({ conversationId: conv, running: false, lastMessage: { role: "assistant", text: "fake heard: from the channel" } });
      expect(me.unread).toBeGreaterThan(0);
      await web.req("POST", `/api/conversations/${conv}/read`, {});
      expect(((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "assistant").unread).toBe(0);
      expect((await web.raw("POST", "/api/conversations/nope/read", {})).status).toBe(404);
    } finally {
      off();
    }
  });

  it("mirrors the main agent's replies to web messages into the channels, once", async () => {
    const sent: any[] = [];
    const peer = { closed: false, request: async (_m: string, p: any) => (sent.push(p), {}) } as any;
    hub.channels.register("mirror", "Mirror", "mirror-test", peer);
    try {
      // Typed in the web UI: the reply also goes to the channel, with the question quoted.
      await web.req("POST", `/api/conversations/${conv}/messages`, { text: "web question" });
      await lastReply(conv, /fake heard: web question/);
      const out = await until(() => sent.find((s) => /fake heard: web question/.test(s.message.text)), "the mirrored reply");
      expect(out).toMatchObject({ channelId: "mirror", message: { kind: "reply", quote: "web question", conversationId: conv } });

      // Only the answer leaves the web: no tool calls, their results or the narration around them.
      await web.req("POST", `/api/conversations/${conv}/messages`, { text: "THINK about it" });
      const full = await lastReply(conv, /fake found it/);
      expect(full.parts.map((p: any) => p.type)).toEqual(["text", "tool_call", "tool_result", "text"]);
      const answer = await until(() => sent.find((s) => /fake found it/.test(s.message.text)), "the mirrored answer");
      expect(answer.message.text).toBe("fake found it");

      // Written in the channel: the answer goes back there once, without quoting the user to themselves.
      await createCoreCall(hub)("mirror-test", "channels.inbound", { channel: "mirror", text: "phone question" });
      await lastReply(conv, /fake heard: phone question/);
      await until(() => sent.some((s) => /fake heard: phone question/.test(s.message.text)), "the channel reply");
      await new Promise((r) => setTimeout(r, 200));
      const phone = sent.filter((s) => /fake heard: phone question/.test(s.message.text));
      expect(phone).toHaveLength(1);
      expect(phone[0].message.quote).toBeUndefined();

      // Another agent's dialog stays in the web.
      await web.req("PUT", "/api/agents/quiet", { name: "Quiet", description: "Stays home", brains: ["fake@local"], prompt: "Be quiet." });
      const quiet = ((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "quiet");
      await web.req("POST", `/api/conversations/${quiet.conversationId}/messages`, { text: "side question" });
      await lastReply(quiet.conversationId, /fake heard: side question/);

      // And the user can turn mirroring off.
      await web.req("PATCH", "/api/settings", { channelMirror: false });
      await web.req("POST", `/api/conversations/${conv}/messages`, { text: "private question" });
      await lastReply(conv, /fake heard: private question/);
      await new Promise((r) => setTimeout(r, 200));
      expect(sent.some((s) => /side question|private question/.test(s.message.text))).toBe(false);
    } finally {
      await web.req("PATCH", "/api/settings", { channelMirror: true });
      await web.req("DELETE", "/api/agents/quiet");
      hub.channels.unregisterPlugin("mirror-test");
    }
  });

  it("gives each agent its own dialog, keeps it when the agent leaves", async () => {
    await web.req("PUT", "/api/agents/scout", { name: "Scout", description: "Looks around", brains: ["fake@local"], prompt: "Look around." });
    const scout = ((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "scout");
    expect(scout.conversationId).not.toBe(conv);
    expect(scout.unread).toBe(0);

    // The agent's proactive messages land in its own dialog.
    await hub.notifier.notify({ level: "ask", title: "scout found something", body: "details", agentId: "scout" });
    const msgs: any[] = await web.req("GET", `/api/conversations/${scout.conversationId}/messages`);
    expect(msgs.some((m) => m.parts.some((p: any) => p.type === "notification" && p.title === "scout found something"))).toBe(true);
    expect(((await web.req("GET", "/api/team")) as any[]).find((m) => m.agentId === "scout").unread).toBe(1);

    // Talking in the dialog runs that agent, and the dialog cannot be handed to another agent.
    await web.req("POST", `/api/conversations/${scout.conversationId}/messages`, { text: "hi scout" });
    expect((await lastReply(scout.conversationId, /fake heard: hi scout/)).agentId).toBe("scout");
    expect((await web.raw("PATCH", `/api/conversations/${scout.conversationId}`, { agentId: "assistant" })).status).toBe(400);

    // "/" follows the default agent; deleting it falls back to the assistant.
    await web.req("PATCH", "/api/settings", { defaultAgent: "scout" });
    expect((await web.req("GET", "/api/bootstrap")).mainConversationId).toBe(scout.conversationId);
    await web.req("DELETE", "/api/agents/scout");
    expect((await web.req("GET", "/api/settings")).defaultAgent).toBe("assistant");
    expect((await web.req("GET", "/api/bootstrap")).mainConversationId).toBe(conv);
    expect(((await web.req("GET", "/api/team")) as any[]).some((m) => m.agentId === "scout")).toBe(false);
    expect(((await web.req("GET", `/api/conversations/${scout.conversationId}/messages`)) as any[]).length).toBeGreaterThan(0);
  });

  it("serves tools to brains over MCP with per-session tokens", async () => {
    expect((await web.raw("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer nope" })).status).toBe(401);
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: 'CALL notify {"level":"silent","title":"from-mcp"}' });
    await lastReply(conv, /tool said:/);
    const notes: any[] = await web.req("GET", "/api/notifications");
    expect(notes.some((n) => n.title === "from-mcp")).toBe(true);
  });

  it("holds external actions for approval and runs them after the user approves", async () => {
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: 'CALL fake_send {"text":"to bob"}' });
    await lastReply(conv, /awaiting_approval|waiting for the user.s approval/);

    // The approval is only visible and resolvable in the isolated console.
    expect((await consoleClient.raw("GET", "/console-api/approvals")).status).toBe(401);
    const login = await consoleClient.req("POST", "/console-api/auth/login", { password: "integration-pass-1" });
    consoleClient.csrf = login.csrf;
    const pending: any[] = await consoleClient.req("GET", "/console-api/approvals");
    const a = pending.find((p) => p.tool === "fake_send");
    expect(a.summary).toBe("Отправить to bob");
    expect((await consoleClient.raw("POST", `/console-api/approvals/${a.id}`, { decision: "approve" }, { "content-type": "text/plain" })).status).toBe(415);
    await consoleClient.req("POST", `/console-api/approvals/${a.id}`, { decision: "approve" });
    expect((await consoleClient.raw("POST", `/console-api/approvals/${a.id}`, { decision: "approve" })).status).toBe(409);
    expect((await consoleClient.raw("POST", "/console-api/approvals/nope", { decision: "approve" })).status).toBe(404);
    expect((await consoleClient.raw("GET", "/console-api/auth/state")).json).toMatchObject({ language: "en", locales: ["en", "ru"] });
    expect((await consoleClient.raw("PUT", "/console-api/vault/items", { id: "../x", name: "x", type: "note", fields: {} })).status).toBe(400);

    await until(async () => {
      const msgs: any[] = await web.req("GET", `/api/conversations/${conv}/messages`);
      return msgs.some((m) => m.role === "system" && m.parts.some((p: any) => p.type === "text" && p.text.includes("sent: to bob")));
    }, "deferred result note");
    const audit: any[] = await consoleClient.req("GET", "/console-api/audit?limit=200");
    expect(audit.some((e) => e.action === "tool.call" && e.target === "fake_send")).toBe(true);
    expect((await consoleClient.req("GET", "/console-api/audit/verify")).ok).toBe(true);
  });

  it("speaks the reader's language and keeps a hub language", async () => {
    expect((await web.raw("GET", "/api/tasks/nope")).json.error).toBe("Task not found");
    expect((await web.raw("GET", "/api/tasks/nope", undefined, { "x-owlbot-locale": "ru" })).json.error).toBe("Задача не найдена");
    expect((await web.raw("GET", "/api/tasks/nope", undefined, { "accept-language": "ru-RU,ru;q=0.9" })).json.error).toBe("Задача не найдена");
    const state = (await web.raw("GET", "/api/auth/state")).json;
    expect(state.locales).toEqual(["en", "ru"]);
    expect((await web.raw("PATCH", "/api/settings", { language: "xx" })).status).toBe(400);
    await web.req("PATCH", "/api/settings", { language: "ru-RU" });
    expect((await web.req("GET", "/api/bootstrap")).language).toBe("ru");
    const agents: any[] = await web.req("GET", "/api/agents");
    expect(agents.find((a) => a.id === "assistant")).toBeTruthy();
    await web.req("PATCH", "/api/settings", { language: "en" });

    // Editing a translated agent in Russian changes the Russian name only.
    await web.req("PUT", "/api/agents/polyglot", { name: "Polyglot", description: "Speaks", prompt: "x", i18n: { ru: { name: "Полиглот" } } });
    const ru = await web.raw("PUT", "/api/agents/polyglot", { name: "Полиглот 2", description: "Говорит" }, { "x-owlbot-locale": "ru" });
    expect(ru.status).toBe(200);
    const byLang = async (l: string) => ((await web.raw("GET", "/api/agents", undefined, { "x-owlbot-locale": l })).json as any[]).find((a) => a.id === "polyglot");
    expect(await byLang("en")).toMatchObject({ name: "Polyglot", description: "Speaks" });
    expect(await byLang("ru")).toMatchObject({ name: "Полиглот 2", description: "Говорит" });
    await web.req("DELETE", "/api/agents/polyglot");
  });

  it("delivers plugin files into the session workspace", async () => {
    const s = hub.db.prepare("select id from sessions order by created_at limit 1").get() as { id: string };
    const call = createCoreCall(hub);
    const first = (await call("fakebrain", "files.deliver", { sessionId: s.id, name: "../../evil/отчёт.txt", data: Buffer.from("hel").toString("base64") })) as any;
    expect(first.path).toBe("downloads/отчёт.txt");
    await call("fakebrain", "files.deliver", { sessionId: s.id, name: "x", path: first.path, data: Buffer.from("lo").toString("base64") });
    expect(readFileSync(first.absolutePath, "utf8")).toBe("hello");
    const second = (await call("fakebrain", "files.deliver", { sessionId: s.id, name: "отчёт.txt", data: "" })) as any;
    expect(second.path).toBe("downloads/отчёт (1).txt");
    await expect(call("fakebrain", "files.deliver", { sessionId: s.id, path: "downloads/../../x", data: "" })).rejects.toThrow(/invalid path/);
    await expect(call("fakebrain", "files.deliver", { sessionId: "nope", name: "a", data: "" })).rejects.toThrow(/session not found/);
  });

  it("lets the security console grant a plugin extra vault items", async () => {
    const r = await consoleClient.req("PUT", "/console-api/plugins/fakebrain/vault", { items: ["vault://my_key", "my_key", "other"] });
    expect(r.extraVault).toEqual(["my_key", "other"]);
    const list: any[] = await consoleClient.req("GET", "/console-api/plugins");
    expect(list.find((p) => p.id === "fakebrain").extraVault).toEqual(["my_key", "other"]);
    await expect(consoleClient.req("PUT", "/console-api/plugins/fakebrain/vault", { items: ["../x"] })).rejects.toThrow(/400/);
    // The main UI origin cannot do this.
    await expect(web.req("PUT", "/console-api/plugins/fakebrain/vault", { items: ["x"] })).rejects.toThrow();
    await consoleClient.req("PUT", "/console-api/plugins/fakebrain/vault", { items: [] });
  });

  it("falls back to the next brain when a subscription limit is hit", async () => {
    await web.req("POST", `/api/conversations/${conv}/messages`, { text: "LIMIT please" });
    const m = await lastReply(conv, /fake2 heard/);
    expect(m.brainRef).toBe("fake2@local");
    const brains: any[] = await web.req("GET", "/api/brains");
    expect(brains.find((b) => b.ref === "fake@local").limitedUntil).toBeTruthy();
    expect(brains.find((b) => b.ref === "fake2:a@local")).toMatchObject({ label: "fake2 (a)", connected: true });
    expect(brains.find((b) => b.ref === "fake2@local")?.connected).toBe(true);
    await web.req("DELETE", `/api/brains/limits/${encodeURIComponent("fake@local")}`);
  });

  it("lets the default agent run the hub from chat, and nobody else", async () => {
    const say = async (c: string, tool: string, args: unknown) => {
      const sent = await web.req("POST", `/api/conversations/${c}/messages`, { text: `CALL ${tool} ${JSON.stringify(args)}` });
      const reply = await until(async () => {
        const msgs: any[] = await web.req("GET", `/api/conversations/${c}/messages`);
        const after = msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1);
        return after.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && /tool said:/.test(p.text)));
      }, `reply to ${tool}`);
      return reply.parts.find((p: any) => p.type === "text" && /tool said:/.test(p.text)).text as string;
    };
    const chat = (await web.req("POST", "/api/conversations", { title: "hub admin" })).id;

    expect(await say(chat, "hub_settings_update", { patch: { digestTimes: ["08:30"], timezone: "Europe/Berlin" } })).toMatch(/Settings updated/);
    expect((await web.req("GET", "/api/settings")).digestTimes).toEqual(["08:30"]);
    expect(await say(chat, "hub_settings_update", { patch: { brainEgressAllow: ["evil.example"] } })).toMatch(/only be changed by the user/);
    expect((await web.req("GET", "/api/settings")).brainEgressAllow).toEqual([]);

    expect(await say(chat, "hub_agent_save", { name: "Helper", avatar: { color: "pink", shape: "star" }, brains: ["fake@local"], prompt: "Help." })).toMatch(/helper created/);
    const helper = ((await web.req("GET", "/api/agents")) as any[]).find((a) => a.id === "helper");
    expect(helper).toMatchObject({ name: "Helper", avatar: { color: "pink", shape: "star" }, source: "user" });
    expect(await say(chat, "hub_agent_save", { id: "helper", avatar: { color: "nope", shape: "star" } })).toMatch(/Invalid avatar/);

    // Another agent does not even see the hub tools.
    const other = (await web.req("POST", "/api/conversations", { title: "helper chat", agentId: "helper" })).id;
    expect(await say(other, "hub_settings_get", {})).toMatch(/not available to this agent/);

    // A session that read outside content may look but not change anything.
    for (const s of hub.db.prepare("select id from sessions where conversation_id = ?").all(chat) as Array<{ id: string }>) hub.store.updateSession(s.id, { tainted: true });
    expect(await say(chat, "hub_settings_update", { patch: { digestTimes: ["07:00"] } })).toMatch(/Refused: this conversation has read outside content/);
    expect(await say(chat, "hub_plugins_list", {})).toMatch(/fakebrain/);

    // The brain of this very conversation cannot be switched off from it.
    const fresh = (await web.req("POST", "/api/conversations", { title: "plugins" })).id;
    expect(await say(fresh, "hub_plugin_enable", { id: "fakebrain", enabled: false })).toMatch(/runs the brain of this conversation/);
    await web.req("DELETE", "/api/agents/helper");
    await web.req("PATCH", "/api/settings", { digestTimes: ["09:00", "19:00"], timezone: "UTC" });
  });

  it("runs background tasks to completion", async () => {
    const t = await web.req("POST", "/api/tasks", { goal: "summarize the day" });
    const done = await until(async () => {
      const x = await web.req("GET", `/api/tasks/${t.id}`);
      return x.status === "done" || x.status === "failed" ? x : undefined;
    }, "task to finish");
    expect(done.status).toBe("done");
    expect(done.result).toMatch(/heard/);
  });
});
