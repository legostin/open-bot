// First-run setup in the chat: with no working brain the hub answers with a setup card and keeps the message; signing
// a brain in answers it; a fresh hub greets the user through the agent; the default agent leads the rest of the setup.
// The agent runs on `gated@local` (fixtures/plugins/fakegated: signed in while HOME/.gated-ok exists) and the real
// Codex brain on a fake CLI that is not signed in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

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
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A hub on the setup fixtures with its owner signed in to the web API. */
async function startHub() {
  const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
  const dataDir = mkdtempSync(join(tmpdir(), "ob-setup-"));
  const config = loadConfig(
    { OWLBOT_PORT: String(port), OWLBOT_DEVICES: "0", OWLBOT_CONSOLE_PORT: String(consolePort), OWLBOT_EGRESS_PORT: String(egressPort), TZ: "UTC" },
    { dataDir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "setup-agents") },
  );
  const agentHome = join(dataDir, "home", "agent");
  mkdirSync(agentHome, { recursive: true });
  const hub = new Hub(config);
  await hub.start();
  const base = config.publicUrl;
  let cookie = "";
  let csrf = "";
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
  await until(() => hub.brains.has("gated@local") && hub.brains.has("codex@local"), "brains");
  await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
  const boot = await ok("GET", "/api/bootstrap");
  csrf = boot.csrf;
  const conv: string = boot.mainConversationId;
  const messages = async (): Promise<any[]> => ok("GET", `/api/conversations/${conv}/messages`);
  const signIn = async () => {
    writeFileSync(join(agentHome, ".gated-ok"), "");
    return ok("POST", "/api/setup/refresh", {});
  };
  return { hub, ok, conv, messages, signIn };
}

const replies = (msgs: any[]) => msgs.filter((m) => m.role === "assistant" && m.status !== "streaming");
const cards = (msgs: any[]) => msgs.filter((m) => m.parts.some((p: any) => p.type === "brain_setup"));
const textOf = (m: any) => m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");

describe("setup with no working brain", () => {
  let h: Awaited<ReturnType<typeof startHub>>;

  beforeAll(async () => {
    h = await startHub();
  });

  afterAll(async () => {
    await h?.hub.stop();
  });

  it("lists the agent's brains and the steps left", async () => {
    const s = await h.ok("GET", "/api/setup");
    expect(s).toMatchObject({ agentId: "assistant", usable: false, vault: "absent", telegram: false, machines: 0 });
    expect(s.brains).toEqual([
      expect.objectContaining({ ref: "gated@local", kind: "api", signedIn: false }),
      expect.objectContaining({ ref: "codex@local", kind: "cli", installed: true, signedIn: false, canInstall: false }),
    ]);
    expect(s.remaining).toEqual(["telegram", "backupBrain", "machines", "profile"]);
  });

  it("answers a message with one setup card instead of an error, and keeps it", async () => {
    await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text: "привет" });
    await until(async () => cards(await h.messages()).length === 1, "the setup card");
    await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text: "ещё раз" });
    await until(() => h.hub.setup.isHeld(h.conv) && !h.hub.runner.isRunning(h.conv), "the second message to wait");
    const msgs = await h.messages();
    expect(cards(msgs)).toHaveLength(1);
    expect(msgs.flatMap((m) => m.parts).some((p: any) => p.type === "error")).toBe(false);
    expect(replies(msgs)).toEqual([]);
  });

  it("answers the waiting messages once a brain is signed in, without a greeting", async () => {
    const s = await h.signIn();
    expect(s.usable).toBe(true);
    const reply = await until(async () => replies(await h.messages())[0], "the answer");
    expect(textOf(reply)).toBe("gated heard: привет | ещё раз");
    await sleep(1000);
    expect(replies(await h.messages())).toHaveLength(1);
    expect(h.hub.setup.isHeld(h.conv)).toBe(false);
    expect(h.hub.settings.getKey("setup", {} as any).kickoffDone).toBe(true);
  });

  it("gives the default agent the setup section and its tools", async () => {
    const say = async (text: string) => {
      const sent = await h.ok("POST", `/api/conversations/${h.conv}/messages`, { text });
      return textOf(
        await until(async () => {
          const msgs = await h.messages();
          return replies(msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1))[0];
        }, `the reply to ${text}`),
      );
    };
    expect(await say("SETUP?")).toBe("setup section: yes");
    expect(await say('CALL hub_setup_update {"step":"telegram","status":"skipped"}')).toMatch(/"remaining": \[\s*"backupBrain",\s*"machines",\s*"profile"\s*\]/);
    expect((await h.ok("GET", "/api/setup")).skipped).toEqual(["telegram"]);
    expect(await say("CALL hub_setup_status {}")).toMatch(/"skipped": \[\s*"telegram"\s*\]/);
    expect(await say('CALL hub_setup_update {"step":"telegram","status":"todo"}')).toMatch(/"telegram"/);
    expect(await say('CALL hub_setup_update {"step":"profile","status":"done"}')).not.toMatch(/"profile"/);
    expect((await h.ok("GET", "/api/setup")).done).toContain("profile");
  });
});

describe("setup on a fresh hub", () => {
  let h: Awaited<ReturnType<typeof startHub>>;

  beforeAll(async () => {
    h = await startHub();
  });

  afterAll(async () => {
    await h?.hub.stop();
  });

  it("greets the user through the agent when the first brain is signed in, once", async () => {
    // The check after startup has seen that no brain works.
    await until(() => (h.hub.setup as any).sawUnusable, "the first check");
    await h.signIn();
    const greeting = await until(async () => replies(await h.messages())[0], "the greeting");
    expect(textOf(greeting)).toMatch(/^gated heard: \[System\] The hub has just connected its first brain/);
    await h.ok("POST", "/api/setup/refresh", {});
    await sleep(1000);
    expect(replies(await h.messages())).toHaveLength(1);
    // Nobody wrote, so no card was stored.
    expect(cards(await h.messages())).toEqual([]);
  });
});
