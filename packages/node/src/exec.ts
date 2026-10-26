// exec.run: shell commands inside allowed dirs, with an output cap and a timeout that kills the whole process tree.

import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { matchesAny } from "@owlbot/shared";
import { DEFAULT_MAX_TIMEOUT_MS, type Policy } from "./policy.ts";
import { resolveAllowedPath, type GuardOptions } from "./guard.ts";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_EXIT_CODE = 124;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ExecDenied extends Error {
  code = "EXEC_DENIED";
}

/** With an allowlist, shell control characters would let one allowed command smuggle in another. */
const SHELL_META = /[;&|`$<>\r\n]|%[^%\s]+%|\^/;

/** Throws ExecDenied unless the policy allows this command. */
export function checkCommand(command: unknown, policy: Policy): string {
  if (!policy.exec.enabled) throw new ExecDenied("Running commands is not allowed on this machine (exec.enabled = false in policy.json)");
  if (typeof command !== "string" || !command.trim()) throw new ExecDenied("No command given");
  const cmd = command.trim();
  const allow = policy.exec.allowCommands ?? [];
  if (allow.length) {
    if (SHELL_META.test(cmd)) throw new ExecDenied("With exec.allowCommands set, ; & | ` $ < > ^ %VAR% and line breaks are not allowed");
    if (!matchesAny(cmd, allow)) throw new ExecDenied(`The command is not in exec.allowCommands: ${cmd}`);
  }
  return cmd;
}

/** Kill a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    k.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // detached → the child leads its own process group
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("OWLBOT_")) out[k] = v;
  return out;
}

/** Collects up to `max` bytes shared between stdout and stderr. */
class Capped {
  private used = 0;
  truncated = false;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  take(chunk: Buffer, into: Buffer[]): void {
    if (this.used >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.used;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    into.push(part);
    this.used += part.length;
  }
}

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  shell?: string;
  maxOutput?: number;
  /** Running children, so the daemon can kill them on disconnect/shutdown. */
  track?: Set<ChildProcess>;
}

export function runShell(o: RunOptions): Promise<ExecResult> {
  const win = process.platform === "win32";
  // cmd.exe prints in the OEM code page by default; switch the console to UTF-8 first.
  const command = win && !o.shell ? `chcp 65001>nul & ${o.command}` : o.command;
  const child = spawn(command, {
    cwd: o.cwd,
    env: childEnv(),
    shell: o.shell ?? true,
    detached: !win,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  o.track?.add(child);
  const cap = new Capped(o.maxOutput ?? MAX_OUTPUT_BYTES);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on("data", (c: Buffer) => cap.take(c, out));
  child.stderr!.on("data", (c: Buffer) => cap.take(c, err));
  let timedOut = false;
  let spawnError: Error | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, o.timeoutMs);

  return new Promise<ExecResult>((resolvePromise) => {
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.track?.delete(child);
      let stdout = Buffer.concat(out).toString("utf8");
      let stderr = Buffer.concat(err).toString("utf8");
      if (cap.truncated) stderr += `\n[owlbot-node] output truncated to ${Math.round(cap.max / 1024)} KB`;
      let exit = code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : -1);
      if (timedOut) {
        exit = TIMEOUT_EXIT_CODE;
        stderr += `\n[owlbot-node] timed out after ${Math.round(o.timeoutMs / 1000)} s, the process was stopped`;
      }
      if (spawnError) {
        exit = exit === 0 ? -1 : exit;
        stderr += `\n[owlbot-node] could not start the command: ${spawnError.message}`;
      }
      resolvePromise({ code: exit, stdout, stderr: stderr.replace(/^\n/, "") });
    };
    child.on("error", (e) => {
      spawnError = e;
      finish(-1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // A grandchild that escaped the kill may keep the pipes open: don't wait for it forever.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 2000).unref();
    });
  });
}

/** exec.run handler body: policy + path checks, then run. */
export async function execRun(
  params: { command?: unknown; cwd?: unknown; timeoutMs?: unknown },
  policy: Policy,
  guard: GuardOptions,
  track?: Set<ChildProcess>,
): Promise<ExecResult> {
  const command = checkCommand(params?.command, policy);
  const cwd = params?.cwd === undefined || params?.cwd === null || params?.cwd === "" ? resolveAllowedPath(".", policy.allowedDirs, guard) : resolveAllowedPath(params.cwd, policy.allowedDirs, guard);
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ExecDenied(`The working folder does not exist or is not a folder: ${String(params?.cwd ?? cwd)}`);
  const max = policy.exec.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const requested = Number(params?.timeoutMs);
  const timeoutMs = Math.min(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS, max);
  return runShell({ command, cwd, timeoutMs, shell: policy.exec.shell, track });
}
