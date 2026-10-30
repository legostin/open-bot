import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCodexes, compareVersions, newestCodex, resolveCli } from "../src/brains.ts";
import { nodeWsUrl, normalizeHubUrl } from "../src/home.ts";
import { generateKey, publicKeyOf, signChallenge, NODE_AUTH_PREFIX } from "../src/keys.ts";
import { ed25519 } from "@noble/curves/ed25519.js";

const root = mkdtempSync(join(tmpdir(), "obn-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveCli (Windows npm shims)", () => {
  const bin = join(root, "npm");
  mkdirSync(join(bin, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(join(bin, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
  writeFileSync(
    join(bin, "codex.cmd"),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  );
  writeFileSync(join(bin, "claude.exe"), "");
  const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("maps an npm .cmd shim to the JS entry it wraps", () => {
    expect(resolveCli("codex", env, "win32")).toBe(join(bin, "node_modules", "@openai", "codex", "bin", "codex.js"));
  });

  it("finds .exe on PATH and leaves scripts and other platforms alone", () => {
    expect(resolveCli("claude", env, "win32")).toBe(join(bin, "claude.exe"));
    expect(resolveCli("/x/fake-claude.mjs", env, "win32")).toBe("/x/fake-claude.mjs");
    expect(resolveCli("codex", env, "linux")).toBe("codex");
    expect(resolveCli("missing-cli", env, "win32")).toBe("missing-cli");
  });
});

describe("the newest Codex on this machine", () => {
  const app = (name: string, version: string) => {
    const dir = join(root, name, "Contents", "Resources", "codex-cli");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "codex"), "#!/bin/sh\n");
    writeFileSync(join(dir, "codex-package.json"), JSON.stringify({ version, entrypoint: "bin/codex" }));
    return dir;
  };
  const onPath = (version: string) => {
    const file = join(root, `codex-${version}`);
    writeFileSync(file, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
    return file;
  };

  it("compares versions, a release above its own pre-release", () => {
    expect(compareVersions("codex-cli 0.165.0-alpha.1.2", "codex-cli 0.153.4")).toBeGreaterThan(0);
    expect(compareVersions("0.165.0", "0.165.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("0.99.0", "0.153.4")).toBeLessThan(0);
    expect(compareVersions("1.0.0", undefined)).toBeGreaterThan(0);
  });

  it("takes the app's copy when the one on PATH is older, and the one on PATH when it is newer", () => {
    const apps = appCodexes([app("ChatGPT.app", "0.165.0-alpha.1.2"), join(root, "Missing.app")]);
    expect(apps).toEqual([{ command: join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"), version: "0.165.0-alpha.1.2" }]);
    expect(newestCodex(onPath("0.153.4"), apps)).toBe(apps[0].command);
    expect(newestCodex(onPath("0.166.0"), apps)).toBe(join(root, "codex-0.166.0"));
    expect(newestCodex(join(root, "no-codex"), apps)).toBe(apps[0].command);
    expect(newestCodex("codex", [])).toBe("codex");
  });
});

describe("hub URLs", () => {
  it("normalizes and derives the WebSocket endpoint", () => {
    expect(normalizeHubUrl("http://100.64.0.1:8080/")).toBe("http://100.64.0.1:8080");
    expect(nodeWsUrl("http://100.64.0.1:8080")).toBe("ws://100.64.0.1:8080/node/ws");
    expect(nodeWsUrl("https://bot.example.com/owlbot")).toBe("wss://bot.example.com/owlbot/node/ws");
    expect(() => normalizeHubUrl("bot.example.com")).toThrow(/Invalid hub address/);
    expect(() => normalizeHubUrl("ftp://x")).toThrow(/http/);
  });
});

describe("keys", () => {
  it("signs the hub challenge in the format the hub verifies", () => {
    const k = generateKey();
    expect(Buffer.from(k.publicKey, "base64url")).toHaveLength(32);
    expect(publicKeyOf(k.secretKey)).toBe(k.publicKey);
    const sig = signChallenge("nonce-1", k.secretKey);
    const ok = ed25519.verify(Buffer.from(sig, "base64url"), new TextEncoder().encode(NODE_AUTH_PREFIX + "nonce-1"), Buffer.from(k.publicKey, "base64url"));
    expect(ok).toBe(true);
  });
});
