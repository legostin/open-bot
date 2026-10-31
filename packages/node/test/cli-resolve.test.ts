import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCli } from "../src/brains.ts";
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

describe("hub URLs", () => {
  it("normalizes and derives the WebSocket endpoint", () => {
    expect(normalizeHubUrl("http://100.64.0.1:8080/")).toBe("http://100.64.0.1:8080");
    expect(nodeWsUrl("http://100.64.0.1:8080")).toBe("ws://100.64.0.1:8080/node/ws");
    expect(nodeWsUrl("https://bot.example.com/piomio")).toBe("wss://bot.example.com/piomio/node/ws");
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
