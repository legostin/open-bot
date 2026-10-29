// The front desk (docs/superpowers/specs/2026-10-29-front-desk-design.md): a dialog's brain is ready before the
// person's message (warm), dialogs think on "auto" (fast, on the quickest brain that can take the turn), tasks get the
// brain and depth the agent chose for them, the chat sees what a turn is doing now, and a task's permission question
// shows in the dialog that started it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@owlbot/shared";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("front desk (integration)", () => {
  let hub: Hub;

  /** Say something in the agent's dialog and get its answer. */
  const ask = async (agentId: string, text: string): Promise<string> => {
    const c = hub.store.agentConversation(agentId).id;
    const before = hub.store.listMessages(c, { limit: 500 }).filter((m) => m.role === "assistant").length;
    await hub.runner.userMessage(c, text, { channel: "web" });
    const answer = await until(() => hub.store.listMessages(c, { limit: 500 }).filter((m) => m.role === "assistant" && m.status !== "streaming")[before], `the answer to “${text}”`);
    await until(() => !hub.runner.isRunning(c), "the turn to end");
    return textOf(answer);
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-front-desk-"));
    const config = loadConfig(
      { OWLBOT_PORT: String(port), OWLBOT_DEVICES: "0", OWLBOT_CONSOLE_PORT: String(consolePort), OWLBOT_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2:a@local"), "fake brains to register");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("gets a dialog's brain ready before the message, and keeps it warm; tasks are not", async () => {
    const c = hub.store.agentConversation("assistant").id;
    expect(await hub.runner.warm(c)).toBe(true);
    const opened = hub.store.activeSession(c, "assistant")!;
    expect(await ask("assistant", "WARM?")).toBe("fake warm: yes keep: true");
    // The session it opened is the one the turn used.
    expect(hub.store.activeSession(c, "assistant")!.id).toBe(opened.id);
    const task = hub.store.createTask({ agentId: "assistant", title: "w", goal: "WARM?", createdBy: "user", background: false });
    expect(await hub.runner.warm(task.conversationId)).toBe(false);
  });
});
