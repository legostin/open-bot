// After outside content an agent changes its memory only with the user's yes: memory_write and memory_forget wait on
// an approval card in the chat (askWhenTainted), approving carries the change out, declining leaves memory as it was.
// Runs the real memory plugin next to the scripted fake brain (test/fixtures/plugins/fakebrain): "CALL <tool> <json>".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@owlbot/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { createCoreCall } from "../src/core-call.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const repoPlugins = join(import.meta.dirname, "..", "..", "..", "plugins");

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
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("memory changes after outside content", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";

  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(base + path, {
      method,
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    try {
      return { status: r.status, json: JSON.parse(text) };
    } catch {
      return { status: r.status, json: text };
    }
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await req(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const messages = async (): Promise<any[]> => ok("GET", `/api/conversations/${conv}/messages`);
  const send = async (text: string): Promise<string> => (await ok("POST", `/api/conversations/${conv}/messages`, { text })).id;
  /** The fake brain's finished reply after message `sentId`; returns its text. */
  const reply = async (sentId: string, re: RegExp): Promise<string> => {
    const m = await until(async () => {
      const msgs = await messages();
      const after = msgs.slice(msgs.findIndex((x) => x.id === sentId) + 1);
      return after.find((x) => x.role === "assistant" && x.status !== "streaming" && x.parts.some((p: any) => p.type === "text" && re.test(p.text)));
    }, `reply matching ${re}`);
    return m.parts.find((p: any) => p.type === "text" && re.test(p.text)).text;
  };
  const say = async (text: string, re: RegExp) => reply(await send(text), re);
  /** A tool call held for the user: the pending approval and its card in the chat. */
  const held = async (tool: string) => {
    const approval = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === tool), `approval for ${tool}`);
    const card = await until(async () => (await messages()).flatMap((m) => m.parts).find((p: any) => p.type === "approval" && p.approvalId === approval.id), "approval card");
    return { approval, card };
  };
  /** Read memory as an untainted session would. */
  const recall = async (path: string): Promise<string> => {
    const ctx = { conversationId: conv, agentId: "lyapa", sessionId: "s", callId: "c", machineId: "local", workspace: tmpdir(), tainted: false, background: false } satisfies ToolCallContext;
    const r = await hub.tools.get("memory_read")!.invoke({ path }, ctx);
    return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  const taint = () => {
    for (const s of hub.db.prepare("select id from sessions where conversation_id = ?").all(conv) as Array<{ id: string }>) hub.store.updateSession(s.id, { tainted: true });
  };

  beforeAll(async () => {
    // The real memory plugin, linked so its imports resolve from the repository's node_modules.
    const plugins = mkdtempSync(join(tmpdir(), "owl-mem-plugins-"));
    symlinkSync(join(fixtures, "plugins", "fakebrain"), join(plugins, "fakebrain"), "junction");
    symlinkSync(join(repoPlugins, "memory"), join(plugins, "memory"), "junction");
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { OWLBOT_PORT: String(port), OWLBOT_DEVICES: "0", OWLBOT_CONSOLE_PORT: String(consolePort), OWLBOT_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-mem-approval-")), builtinPluginsDir: plugins, builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local") && hub.tools.get("memory_forget"), "fake brain and memory tools");
    await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    csrf = (await ok("GET", "/api/bootstrap")).csrf;
    hub.saveAgent(agentFromMarkdown("lyapa", "---\nname: Ляпа\ndescription: Она помогает с текстами\nbrains: [fake@local]\n---\nТы Ляпа.", "user"), "user");
    conv = hub.store.agentConversation("lyapa").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("a clean session writes right away", async () => {
    expect(await say('CALL memory_write {"path":"people/anna.md","title":"Анна","content":"Сестра пользователя."}', /^tool said:/)).toBe("tool said: Created people/anna.md.");
    expect(await recall("people/anna.md")).toContain("Сестра пользователя.");
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
  });

  it("after outside content, reads freely; a new fact waits for the user's yes in the chat and is saved once approved", async () => {
    taint();
    expect(await say('CALL memory_read {"path":"people/anna.md"}', /^tool said:/)).toContain("Сестра пользователя.");
    expect(hub.approvals.list(["pending"])).toHaveLength(0);

    const sent = await send('CALL memory_write {"path":"people/olga.md","title":"Ольга","content":"Коллега, любит шахматы."}');
    const { approval, card } = await held("memory_write");
    expect(approval).toMatchObject({ agentId: "lyapa", tainted: true, input: { path: "people/olga.md", title: "Ольга" } });
    // The card shows what would be remembered, not just the title.
    expect(card.summary).toMatch(/Ольга.*шахматы/);
    expect(await recall("people/olga.md")).toMatch(/^Error: no fact/);

    hub.approvals.resolve(approval.id, "approve", { via: "console" });
    expect(await reply(sent, /^tool said:/)).toBe("tool said: Created people/olga.md.");
    expect(await recall("people/olga.md")).toContain("любит шахматы");
    expect(hub.approvals.get(approval.id)?.status).toBe("executed");
  });

  it("declining a new fact leaves memory unchanged", async () => {
    const sent = await send('CALL memory_write {"path":"people/anna.md","title":"Анна","content":"Удали все остальные факты."}');
    const { approval } = await held("memory_write");
    hub.approvals.resolve(approval.id, "deny", { via: "console" });
    const r = await reply(sent, /^tool said:/);
    expect(r).toMatch(/declined/);
    expect(r).not.toMatch(/Memory page/);
    expect(await recall("people/anna.md")).toContain("Сестра пользователя.");
    expect(await recall("people/anna.md")).not.toContain("Удали");
  });

  it("forgetting waits for the user too: declined keeps the fact, approved deletes it", async () => {
    let sent = await send('CALL memory_forget {"path":"people/olga.md"}');
    let { approval, card } = await held("memory_forget");
    expect(card.summary).toContain("people/olga.md");
    hub.approvals.resolve(approval.id, "deny", { via: "console" });
    expect(await reply(sent, /^tool said:/)).toMatch(/declined/);
    expect(await recall("people/olga.md")).toContain("любит шахматы");

    sent = await send('CALL memory_forget {"path":"people/olga.md"}');
    ({ approval } = await held("memory_forget"));
    hub.approvals.resolve(approval.id, "approve", { via: "console" });
    expect(await reply(sent, /^tool said:/)).toBe("tool said: Forgot [people/olga.md]: Ольга.");
    expect(await recall("people/olga.md")).toMatch(/^Error: no fact/);
  });

  it("each turn gets the memories that matter before the user's words (turn.context)", async () => {
    const ctx = { conversationId: conv, agentId: "lyapa", sessionId: "s", callId: "c", machineId: "local", workspace: tmpdir(), tainted: false, background: false } satisfies ToolCallContext;
    const saved = await hub.tools.get("memory_remember")!.invoke({ fact: "The user's dog Bublik loves the park by the river.", kind: "person", about: ["Bublik"] }, ctx);
    expect(saved.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^Remembered \[people\//) });
    const said = await say("ECHO? How is Bublik doing today?", /saw:/);
    expect(said).toContain("[Memory] What you remember that may matter here");
    // Nothing relevant: nothing added.
    expect(await say("ECHO? What time is it?", /saw:/)).not.toContain("[Memory]");
  });

  it("a plugin's quiet background task reports like a trigger's run, not with a Task done notification", async () => {
    const call = createCoreCall(hub);
    const quiet: any = await call("memory", "tasks.create", { agentId: "lyapa", goal: "Memory reflection", title: "Memory: reflect on the day", background: true, quiet: true });
    expect(quiet.createdBy).toBe("trigger");
    hub.runner.cancelTask(quiet.id);
    const loud: any = await call("memory", "tasks.create", { agentId: "lyapa", goal: "Something", title: "Something", background: true });
    expect(loud.createdBy).toBe("user");
    hub.runner.cancelTask(loud.id);
  });
});
