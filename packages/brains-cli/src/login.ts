// Sign-in without a terminal: run a CLI's own login command, read the page (and the one-time code) it prints and
// report them, feed back a code the user pasted, and turn the exit into succeeded / failed / cancelled / expired.

import { spawn } from "node:child_process";
import type { BrainLoginUpdate } from "@owlbot/shared";
import type { BrainLoginImpl } from "@owlbot/plugin-sdk";
import type { Translate } from "@owlbot/shared/i18n";
import { resolveCommand } from "./proc.ts";

/** What the output printed so far says: the page, the code, whether the CLI waits for a pasted code. */
export type LoginParser = (output: string, startedAt: number) => Pick<BrainLoginUpdate, "url" | "userCode" | "needsCode" | "expiresAt"> | undefined;

export interface CliLoginOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  onUpdate: (u: BrainLoginUpdate) => void;
  parse: LoginParser;
  /** The CLI is stopped and the sign-in reported as expired after this long. */
  timeoutMs: number;
  /** Messages for people, in their language (brainsT). */
  t: Translate;
  /** What to say when the command does not exist. */
  notInstalled: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Codex `login --device-auth`: "Open this link … https://auth.openai.com/codex/device … one-time code (expires in 15 minutes) ABCD-EFGHI". */
export const parseCodexDeviceLogin: LoginParser = (output, startedAt) => {
  const text = stripAnsi(output);
  const urls = text.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  const url = urls.find((u) => /device/i.test(u)) ?? urls[0];
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)\s*$/im.exec(text)?.[1] ?? /^\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\s*$/m.exec(text)?.[1];
  if (!url || !code) return undefined;
  const minutes = /expires in (\d+) min/i.exec(text)?.[1];
  return { url, userCode: code, expiresAt: minutes ? new Date(startedAt + Number(minutes) * 60_000).toISOString() : undefined };
};

/** Claude Code `auth login` without a terminal: "visit: https://claude.com/cai/oauth/authorize?…", then reads the code from stdin. */
export const parseClaudeBrowserLogin: LoginParser = (output) => {
  const text = stripAnsi(output);
  const url = /https:\/\/[^\s"'<>]*oauth\/authorize[^\s"'<>]*/.exec(text)?.[0];
  return url ? { url, needsCode: true } : undefined;
};

export function runCliLogin(o: CliLoginOptions): BrainLoginImpl {
  const startedAt = Date.now();
  const [file, argv] = resolveCommand(o.command, o.args);
  const child = spawn(file, argv, { env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let shown: BrainLoginUpdate | undefined;
  let ending: "cancelled" | "expired" | undefined;
  let spawnError: string | undefined;

  o.onUpdate({ status: "starting" });
  const read = (chunk: string) => {
    output = (output + chunk).slice(-50_000);
    if (shown) return;
    const found = o.parse(output, startedAt);
    if (!found) return;
    shown = { status: "waiting", ...found, expiresAt: found.expiresAt ?? new Date(startedAt + o.timeoutMs).toISOString() };
    o.onUpdate(shown);
  };
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", read);
  child.stderr!.on("data", read);
  child.stdin!.on("error", () => {});

  const stop = (why: "cancelled" | "expired") => {
    if (ending || child.exitCode !== null || child.signalCode !== null) return;
    ending = why;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 3000).unref();
  };
  const timer = setTimeout(() => stop("expired"), o.timeoutMs);
  timer.unref?.();

  const done = new Promise<BrainLoginUpdate>((resolve) => {
    child.on("error", (e: NodeJS.ErrnoException) => {
      spawnError = e.code === "ENOENT" ? o.notInstalled : e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const base = shown ? { url: shown.url, userCode: shown.userCode, needsCode: shown.needsCode, expiresAt: shown.expiresAt } : {};
      if (ending === "cancelled") return resolve({ status: "cancelled", ...base });
      if (ending === "expired") return resolve({ status: "expired", ...base, error: o.t("login.expired") });
      if (code === 0 && !spawnError) return resolve({ status: "succeeded", ...base });
      const text = stripAnsi(output);
      if (/expired|timed out/i.test(text)) return resolve({ status: "expired", ...base, error: o.t("login.expired") });
      resolve({ status: "failed", ...base, error: spawnError ?? o.t("login.failed", { detail: lastLine(text) || `exit ${code}` }) });
    });
  });

  return {
    done,
    cancel: () => stop("cancelled"),
    submitCode(code: string) {
      const clean = code.trim();
      if (!shown?.needsCode || shown.status !== "waiting" || ending || child.exitCode !== null) throw new Error(o.t("login.noCode"));
      if (!clean || /\s/.test(clean)) throw new Error(o.t("login.badCode"));
      child.stdin!.write(clean + "\n");
      shown = { ...shown, status: "verifying" };
      o.onUpdate(shown);
    },
  };
}

/** The CLI's own explanation: its last line that is not the sign-in page or the prompt it left behind. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^.*Paste code here if prompted >\s*/, "").trim())
    .filter((l) => l && !/https?:\/\//.test(l));
  return (lines.at(-1) ?? "").slice(0, 300);
}
