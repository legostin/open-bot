// Signing CLI brains in without a terminal, against fake CLIs: Codex's device code flow (fixtures/fake-codex.mjs) and
// Claude Code's browser flow that reads the pasted code from stdin (fixtures/fake-claude.mjs).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainLoginUpdate } from "@openbot/shared";
import type { BrainProviderImpl } from "@openbot/plugin-sdk";
import { createClaudeCodeProvider, createCodexProvider, parseClaudeBrowserLogin, parseCodexDeviceLogin } from "../src/index.ts";

const fakeCodex = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const fakeClaude = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Output of `codex login --device-auth` 0.164 in the container, colours included. */
const CODEX_OUTPUT =
  "\nWelcome to Codex [v\x1b[90m0.164.0\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
  "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
  "1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mINQ9-PB9KT\x1b[0m\n\n";

/** Output of `claude auth login` 2.1 without a terminal (shortened URL). */
const CLAUDE_OUTPUT =
  "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=IFBF\nPaste code here if prompted > ";

async function signIn(provider: BrainProviderImpl, env: Record<string, string>) {
  const updates: BrainLoginUpdate[] = [];
  const login = await provider.login!({ env, onUpdate: (u) => updates.push(u) });
  return { login, updates, waiting: () => until(() => updates.find((u) => u.status === "waiting")) };
}

async function until<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("reading the sign-in page from CLI output", () => {
  it("finds the Codex device page, code and expiry", () => {
    const at = Date.parse("2026-10-26T12:00:00Z");
    expect(parseCodexDeviceLogin(CODEX_OUTPUT, at)).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "INQ9-PB9KT", expiresAt: "2026-10-26T12:15:00.000Z" });
    expect(parseCodexDeviceLogin(CODEX_OUTPUT.slice(0, CODEX_OUTPUT.indexOf("2. Enter")), at)).toBeUndefined();
  });

  it("finds the Claude Code sign-in page, which hands back a code", () => {
    expect(parseClaudeBrowserLogin(CLAUDE_OUTPUT, 0)).toEqual({ url: expect.stringMatching(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&.*state=IFBF$/), needsCode: true });
    expect(parseClaudeBrowserLogin("Opening browser to sign in…\n", 0)).toBeUndefined();
  });
});

describe("Codex device sign-in (fake codex)", () => {
  const codex = (home: string, extra: Partial<Parameters<typeof createCodexProvider>[0]> = {}) =>
    createCodexProvider({ command: () => fakeCodex, stateDir: tmp("ob-cx-state-"), authEnv: async () => ({ HOME: home }), ...extra });

  it("shows the page and the code, then signs in as the same HOME the sessions use", async () => {
    const home = tmp("ob-cx-home-");
    const provider = codex(home);
    expect((await provider.probe()).authenticated).toBe(false);

    const { login, updates, waiting } = await signIn(provider, { HOME: home, HTTPS_PROXY: "http://proxy.invalid:1" });
    expect(updates[0]).toEqual({ status: "starting" });
    const shown = await waiting();
    expect(shown).toMatchObject({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGHI" });
    expect(Date.parse(shown.expiresAt!) - Date.now()).toBeGreaterThan(14 * 60_000);

    expect(await login.done).toMatchObject({ status: "succeeded", userCode: "ABCD-EFGHI" });
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(true);
    expect(await provider.probe()).toMatchObject({ authenticated: true, version: "9.9.9" });
  });

  it("reports the CLI's own reason when the sign-in fails", async () => {
    const home = tmp("ob-cx-home-");
    const { login } = await signIn(codex(home), { HOME: home, FAKE_CODEX_LOGIN: "fail" });
    expect(await login.done).toMatchObject({ status: "failed", error: expect.stringMatching(/^Sign-in failed: .*device code was declined/) });
  });

  it("stops the CLI when the code runs out", async () => {
    const home = tmp("ob-cx-home-");
    const { login } = await signIn(codex(home, { loginTimeoutMs: 700 }), { HOME: home, FAKE_CODEX_LOGIN: "hang" });
    expect(await login.done).toMatchObject({ status: "expired", error: "The code expired before the sign-in was finished", userCode: "ABCD-EFGHI" });
  });

  it("cancels", async () => {
    const home = tmp("ob-cx-home-");
    const { login, waiting } = await signIn(codex(home), { HOME: home, FAKE_CODEX_LOGIN: "hang" });
    await waiting();
    expect(() => login.submitCode?.("ABCD")).toThrow(/not waiting for a code/);
    login.cancel();
    expect((await login.done).status).toBe("cancelled");
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(false);
  });

  it("says when Codex is not installed", async () => {
    const provider = createCodexProvider({ command: () => join(tmp("ob-cx-none-"), "no-such-codex"), stateDir: tmp("ob-cx-state-") });
    const { login } = await signIn(provider, {});
    expect(await login.done).toMatchObject({ status: "failed", error: "Codex CLI is not installed" });
  });

  it("speaks the hub language", async () => {
    const home = tmp("ob-cx-home-");
    const { login } = await signIn(codex(home, { locale: () => "ru", loginTimeoutMs: 500 }), { HOME: home, FAKE_CODEX_LOGIN: "hang" });
    expect((await login.done).error).toBe("Код истёк раньше, чем вход был завершён");
  });
});

describe("Claude Code browser sign-in (fake claude)", () => {
  const claude = (home: string) => createClaudeCodeProvider({ command: () => fakeClaude, stateDir: tmp("ob-cc-state-"), authEnv: async () => ({ HOME: home }) });

  it("shows the page, takes the code the page gave and signs in", async () => {
    const home = tmp("ob-cc-home-");
    const provider = claude(home);
    expect((await provider.probe()).authenticated).toBe(false);
    const { login, updates, waiting } = await signIn(provider, { HOME: home });
    expect(await waiting()).toMatchObject({ url: expect.stringMatching(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/), needsCode: true });
    expect(() => login.submitCode!("two words")).toThrow(/whole code/);
    await login.submitCode!("  good-code#xyz \n");
    expect(updates.at(-1)?.status).toBe("verifying");
    expect((await login.done).status).toBe("succeeded");
    expect((await provider.probe()).authenticated).toBe(true);
  });

  it("fails on a code the server refuses", async () => {
    const home = tmp("ob-cc-home-");
    const { login, waiting } = await signIn(claude(home), { HOME: home });
    await waiting();
    await login.submitCode!("stale-code#xyz");
    expect(await login.done).toMatchObject({ status: "failed", error: "Sign-in failed: Login failed: Request failed with status code 400" });
  });
});
