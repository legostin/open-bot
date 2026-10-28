import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDef, BrainEvent } from "@owlbot/shared";
import { PolicyStore } from "../src/policy.ts";
import { BrainHost } from "../src/brains.ts";

const ENV_CLAUDE = fileURLToPath(new URL("./fixtures/env-claude.mjs", import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-brains-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const agent = { id: "a", name: "a", description: "", brains: [], initiative: 0, tools: [], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 0 }, prompt: "", source: "builtin" } as AgentDef;

describe("BrainHost", () => {
  const home = join(root, "home");
  const userHome = join(root, "user");
  const policy = new PolicyStore(home, { userHome });
  const raw = JSON.parse(readFileSync(policy.file, "utf8"));
  raw.brains["claude-code"].command = ENV_CLAUDE;
  raw.brains["claude-code"].allowedTools = ["Read", "mcp__owlbot"];
  raw.brains.codex.enabled = false;
  writeFileSync(policy.file, JSON.stringify(raw));
  const host = new BrainHost({ home, policy, hubUrl: "http://hub.test:8080", bridgeCommand: ["bridge-cmd"] });

  it("probes enabled brains and reports disabled ones as unavailable", async () => {
    const clis = await host.probeAll();
    expect(clis.find((c) => c.brainId === "claude-code")).toMatchObject({ available: true, authenticated: true, version: "1.0.0" });
    expect(clis.find((c) => c.brainId === "codex")).toMatchObject({ available: false, detail: "disabled in policy.json" });
    expect(host.available().map((b) => b.id)).toEqual(["claude-code"]);
    await expect(host.probe({ brainId: "codex" })).rejects.toThrow(/disabled/);
    await expect(host.probe({ brainId: "gemini" })).rejects.toThrow(/Unknown brain/);
  });

  it("runs sessions in the workspace with the owner's tools and only harmless hub env", async () => {
    await host.create({
      brainId: "claude-code",
      opts: {
        sessionId: "s1",
        agent,
        workspace: "a/c1",
        mcp: { url: "http://elsewhere/mcp", token: "t", bridgeCommand: [] },
        systemPrompt: "sys",
        env: { TZ: "Europe/Moscow", NODE_OPTIONS: "--require /tmp/evil.js", ANTHROPIC_BASE_URL: "http://evil.test" },
        background: false,
      },
    });
    const events: BrainEvent[] = [];
    process.env.OWLBOT_NODE_HOME = home; // daemon env must not leak into the brain
    try {
      await host.send({ sessionId: "s1", turn: { text: "hi" } }, (e) => events.push(e));
    } finally {
      delete process.env.OWLBOT_NODE_HOME;
    }
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const ws = join(userHome, "owlbot-workspace", "a", "c1");
    const seen = JSON.parse(readFileSync(join(ws, "env.json"), "utf8"));
    expect(seen.cwd.toLowerCase()).toBe(ws.toLowerCase());
    expect(seen.TZ).toBe("Europe/Moscow");
    expect(seen.NODE_OPTIONS).not.toBe("--require /tmp/evil.js");
    expect(seen.ANTHROPIC_BASE_URL).not.toBe("http://evil.test");
    expect(seen.OWLBOT_NODE_HOME).toBeNull();
    expect(seen.args[seen.args.indexOf("--allowedTools") + 1]).toBe("Read,mcp__owlbot");
    const mcp = JSON.parse(readFileSync(join(home, "brains", "claude-code", "sessions", "s1", "mcp.json"), "utf8")).mcpServers.owlbot;
    expect(mcp.command).toBe("bridge-cmd");
    expect(mcp.env.OWLBOT_URL).toBe("http://hub.test:8080/mcp");
    await host.closeAll();
    expect(host.sessionCount).toBe(0);
  });

  it("refuses hub values that would turn into CLI flags", async () => {
    const base = { sessionId: "s3", agent, workspace: "a/c3", mcp: { url: "", token: "t", bridgeCommand: [] }, systemPrompt: "", env: {}, background: false };
    await expect(host.create({ brainId: "claude-code", opts: { ...base, resume: "--dangerously-skip-permissions" } })).rejects.toThrow(/resume/);
    await expect(host.create({ brainId: "claude-code", opts: { ...base, model: "-x" } })).rejects.toThrow(/model/);
    await host.create({ brainId: "claude-code", opts: { ...base, model: "sonnet[1m]", resume: "0f8e1c2a-1b2c-4d5e-8f90-123456789abc" } });
    await host.closeAll();
  });

  it("refuses unknown sessions and disabled brains", async () => {
    await expect(host.send({ sessionId: "nope", turn: { text: "x" } }, () => {})).rejects.toThrow(/Unknown brain session/);
    // Nothing to join: the hub sends the input as the next turn.
    expect(await host.steer({ sessionId: "nope", turn: { text: "x" } })).toBe(false);
    await expect(host.create({ brainId: "codex", opts: { sessionId: "s2", workspace: "a/b" } as any })).rejects.toThrow(/disabled/);
  });
});
