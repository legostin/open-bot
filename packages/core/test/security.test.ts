import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rule, ToolDescriptor } from "@owlbot/shared";
import { decide, extractTargets, suggestRule, type PolicyInput } from "../src/policy/engine.ts";
import { Redactor } from "../src/vault/redact.ts";
import { NOT_FOUND_QUIET_MS, VaultService, VaultError, type VaultAccessEntry } from "../src/vault/service.ts";
import { AuditLog } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { sudoSpawn } from "../src/plugins/host.ts";

const tool = (name: string, effect: ToolDescriptor["effect"]): ToolDescriptor => ({ name, description: "", effect, inputSchema: {}, owner: "core" }) as ToolDescriptor;
const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  tool: tool("mail_send", "external"),
  input: { to: "bob@example.com", text: "hi" },
  agentId: "assistant",
  tainted: false,
  background: false,
  initiative: 1,
  profile: "default",
  ...over,
});
const rule = (r: Partial<Rule>): Rule => ({ id: "r1", tool: "mail_send", conditions: [], decision: "allow", createdAt: "", createdVia: "console", ...r }) as Rule;
const unknownTargets = () => false;

describe("policy engine", () => {
  it("reads are allowed, external actions ask by default", () => {
    expect(decide(base({ tool: tool("memory_search", "read") }), [], unknownTargets).decision).toBe("allow");
    expect(decide(base(), [], unknownTargets).decision).toBe("ask");
  });

  it("local writes ask only in the strict profile", () => {
    expect(decide(base({ tool: tool("fs_write", "local-write") }), [], unknownTargets).decision).toBe("allow");
    expect(decide(base({ tool: tool("fs_write", "local-write"), profile: "strict" }), [], unknownTargets).decision).toBe("ask");
  });

  it("after outside content, lasting changes (askWhenTainted) need approval; reading stays free", () => {
    for (const name of ["profile_update", "memory_write", "memory_forget"]) {
      const lasting = { ...tool(name, "local-write"), askWhenTainted: true };
      expect(decide(base({ tool: lasting, input: { path: "x" } }), [], unknownTargets).decision, name).toBe("allow");
      expect(decide(base({ tool: lasting, input: { path: "x" }, tainted: true }), [], unknownTargets).decision, name).toBe("ask");
      expect(decide(base({ tool: lasting, input: {}, tainted: true }), [], unknownTargets).decision, name).toBe("allow");
    }
    expect(decide(base({ tool: tool("fs_write", "local-write"), tainted: true }), [], unknownTargets).decision).toBe("allow");
  });

  it("deny rules win over allow rules", () => {
    const rules = [rule({ id: "a", decision: "allow" }), rule({ id: "d", decision: "deny" })];
    expect(decide(base(), rules, unknownTargets)).toMatchObject({ decision: "deny", ruleId: "d" });
  });

  it("allow rules match on conditions", () => {
    const r = rule({ conditions: [{ field: "to", op: "domain", value: "example.com" }] });
    expect(decide(base(), [r], unknownTargets).decision).toBe("allow");
    expect(decide(base({ input: { to: "eve@evil.test" } }), [r], unknownTargets).decision).toBe("ask");
  });

  it("tainted sessions re-ask for new recipients even with an allow rule", () => {
    const r = rule({});
    expect(decide(base({ tainted: true }), [r], unknownTargets).decision).toBe("ask");
    expect(decide(base({ tainted: true }), [r], (t) => t === "bob@example.com").decision).toBe("allow");
  });

  it("background tasks below initiative 2 cannot act externally but may notify", () => {
    expect(decide(base({ background: true }), [rule({})], unknownTargets).decision).toBe("deny");
    expect(decide(base({ background: true, tool: tool("notify", "external") }), [], unknownTargets).decision).toBe("ask");
    expect(decide(base({ background: true, initiative: 2 }), [rule({})], unknownTargets).decision).toBe("allow");
  });

  it("extracts recipients and hosts", () => {
    expect(extractTargets({ to: "A@B.com", body: "see https://x.example.org/p and c@d.io" }).sort()).toEqual(["a@b.com", "c@d.io", "x.example.org"]);
  });

  it("suggests a rule narrowed by recipient or domain", () => {
    expect(suggestRule("mail_send", { to: "bob@example.com" }, "assistant")).toMatchObject({ tool: "mail_send", agentId: "assistant", conditions: [{ field: "to", op: "eq", value: "bob@example.com" }] });
    expect(suggestRule("web_post", { url: "https://api.example.com/x" }).conditions).toEqual([{ field: "url", op: "domain", value: "api.example.com" }]);
  });
});

describe("redactor", () => {
  it("removes secrets and their encodings", () => {
    const r = new Redactor();
    r.setSecrets([{ id: "tok", value: "sk-secret-123" }, { id: "short", value: "abc" }]);
    const b64 = Buffer.from("sk-secret-123").toString("base64");
    const out = r.text(`key=sk-secret-123 b64=${b64} short=abc`);
    expect(out).not.toContain("sk-secret-123");
    expect(out).not.toContain(b64);
    expect(out).toContain("[redacted: vault://tok]");
    expect(out).toContain("short=abc");
  });
});

describe("vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-vault-"));

  it("encrypts, seals, unlocks and enforces scopes", () => {
    const v = new VaultService(join(dir, "v.db"));
    expect(v.state()).toBe("uninitialized");
    expect(() => v.init("short")).toThrow(VaultError);
    v.init("correct horse battery");
    v.upsert({ id: "api", type: "secret", name: "API", fields: { value: "secret-value-1" }, scope: { plugins: ["web"] } });
    v.upsert({ id: "site", type: "login", name: "Site", fields: { url: "https://shop.example.com/login", username: "me", password: "pw-123456" } });

    const raw = JSON.stringify(v.db.prepare("select secret from vault_items").all());
    expect(raw).not.toContain("secret-value-1");
    expect(v.redactor.text("x secret-value-1 pw-123456")).not.toMatch(/secret-value-1|pw-123456/);

    expect(v.access("vault://api", { actor: "plugin:web", pluginId: "web" })).toEqual({ value: "secret-value-1" });
    expect(() => v.access("vault://api", { actor: "plugin:x", pluginId: "x" })).toThrow(/denied/);
    expect(v.access("site", { actor: "plugin:browser", pluginId: "browser", domain: "shop.example.com" }).password).toBe("pw-123456");
    expect(() => v.access("site", { actor: "plugin:browser", pluginId: "browser", domain: "evil.test" })).toThrow(/domain evil\.test/);
    expect(() => v.access("site", { actor: "plugin:web", pluginId: "web" })).toThrow(/outside the item's scope/);
    // The same error reads in Russian for a Russian reader.
    try {
      v.access("site", { actor: "plugin:web", pluginId: "web" });
    } catch (e) {
      expect((e as VaultError).localized("ru")).toBe("Доступ к vault://site запрещён: плагин web не в области записи");
    }

    v.seal();
    expect(v.state()).toBe("sealed");
    expect(() => v.read("api")).toThrow(/sealed/);
    expect(v.list().map((m) => m.id).sort()).toEqual(["api", "site"]);
    expect(() => v.unlock("wrong passphrase")).toThrow(/Wrong vault passphrase/);
    v.unlock("correct horse battery");
    expect(v.read("api").fields.value).toBe("secret-value-1");

    v.changePassphrase("correct horse battery", "new passphrase 2");
    v.seal();
    v.unlock("new passphrase 2");
    expect(v.read("site").fields.username).toBe("me");
    v.db.close();
  });

  it("folds repeated lookups of a missing item, never denials of an item that exists", () => {
    let now = 1_000_000;
    const log: VaultAccessEntry[] = [];
    const changes: string[][] = [];
    const v = new VaultService(join(dir, "quiet.db"), { onAccess: (e) => log.push(e), onChange: (ids) => changes.push(ids), now: () => now });
    v.init("correct horse battery");
    const ask = (id: string, plugin: string) => expect(() => v.access(`vault://${id}`, { actor: `plugin:${plugin}`, pluginId: plugin })).toThrow(VaultError);
    const notFound = { actor: "plugin:telegram", itemId: "telegram_bot_token", allowed: false, reason: "not_found" };

    for (let i = 0; i < 5; i++) ask("telegram_bot_token", "telegram");
    expect(log).toEqual([notFound]);
    // Another actor, another item: entries of their own.
    ask("telegram_bot_token", "web");
    ask("brave_api_key", "web");
    expect(log).toHaveLength(3);
    // An hour later: one entry again, counting the lookups folded since the last one.
    now += NOT_FOUND_QUIET_MS - 1;
    ask("telegram_bot_token", "telegram");
    expect(log).toHaveLength(3);
    now += 1;
    ask("telegram_bot_token", "telegram");
    expect(log.at(-1)).toEqual({ ...notFound, repeats: 5 });

    // An item that exists but is outside the asker's scope: every refusal is logged.
    v.upsert({ id: "api", type: "secret", name: "API", fields: { value: "secret-value-1" }, scope: { plugins: ["web"] } });
    for (let i = 0; i < 4; i++) ask("api", "telegram");
    expect(log.filter((e) => e.itemId === "api")).toHaveLength(4);
    expect(log.filter((e) => e.itemId === "api").every((e) => !e.allowed && /outside the item's scope/.test(e.reason ?? ""))).toBe(true);

    // The token stored and removed again: the next miss is news, logged at once.
    v.upsert({ id: "telegram_bot_token", type: "secret", name: "Bot", fields: { value: "123:abc" } });
    v.remove("telegram_bot_token");
    ask("telegram_bot_token", "telegram");
    expect(log.at(-1)).toEqual(notFound);

    // Every change is announced (removing what is not there is not a change).
    v.updateScope("api", { plugins: ["web", "telegram"] });
    v.remove("nothing_here");
    expect(changes).toEqual([["api"], ["telegram_bot_token"], ["telegram_bot_token"], ["api"]]);
    v.db.close();
  });
});

describe("audit log", () => {
  it("chains hashes, redacts and detects tampering", () => {
    const db = openDb(":memory:");
    const r = new Redactor();
    r.setSecrets([{ id: "k", value: "super-secret" }]);
    const log = new AuditLog(db, r);
    log.append("user", "a", "t1", { note: "super-secret" });
    log.append("core", "b");
    log.append("agent:x", "c", undefined, { n: 1 });
    expect(log.verify()).toEqual({ ok: true, count: 3 });
    expect(JSON.stringify(log.list())).not.toContain("super-secret");
    db.prepare("update audit set action = 'evil' where seq = 2").run();
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 2 });
  });
});

describe("isolated child processes", () => {
  it("keep secrets off the command line", () => {
    const s = sudoSpawn("plugin", { PATH: "/usr/bin", API_KEY: "sk-very-secret", HTTP_PROXY: "http://tok:x@127.0.0.1:8089" }, "node", ["server.js"]);
    expect(s.command).toBe("sudo");
    expect(s.args).toEqual(["-n", "--preserve-env=PATH,API_KEY,HTTP_PROXY", "-u", "plugin", "--", "node", "server.js"]);
    expect(s.args.join(" ")).not.toMatch(/sk-very-secret|tok:x/);
    expect(s.env.API_KEY).toBe("sk-very-secret");
    expect(() => sudoSpawn("plugin", { "A,B": "x" }, "node", [])).toThrow(/invalid environment variable/);
  });
});
