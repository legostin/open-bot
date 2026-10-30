// Brains on this machine: Claude Code / Codex CLIs logged in with the owner's subscriptions.
// Same brain.* contract as plugin processes (packages/plugin-sdk/src/runner.ts), driven over the hub WebSocket.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainEvent, BrainSessionOptions, BrainTurn, MachineInfo, ProbeResult } from "@owlbot/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@owlbot/plugin-sdk";
import { createClaudeCodeProvider, createCodexProvider } from "@owlbot/brains-cli";
import type { PolicyStore } from "./policy.ts";
import { resolveWorkspace } from "./guard.ts";
import { hubLocale, tHub } from "./messages.ts";

export const BRAIN_IDS = ["claude-code", "codex"] as const;
export type NodeBrainId = (typeof BRAIN_IDS)[number];

const DEFAULT_COMMANDS: Record<NodeBrainId, string> = { "claude-code": "claude", codex: "codex" };

/**
 * Windows: spawn() without a shell only runs .exe/.com. npm installs CLIs as .cmd shims, so find the
 * command on PATH and, for an npm shim, return the JS entry it wraps (brains-cli runs .js/.mjs via node).
 */
export function resolveCli(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform !== "win32" || /\.(m?js|ts)$/i.test(command)) return command;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const hasDir = isAbsolute(command) || /[\\/]/.test(command);
  const dirs = hasDir ? [""] : (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(command);
  for (const dir of dirs) {
    for (const ext of hasExt ? [""] : exts) {
      const p = dir ? join(dir, command + ext) : command + ext;
      let isFile = false;
      try {
        isFile = statSync(p).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;
      if (/\.(cmd|bat)$/i.test(p)) return shimTarget(p) ?? p;
      return p;
    }
  }
  return command;
}

/** Where the ChatGPT and Codex apps keep the Codex they run (macOS): their `codex-cli` folder. */
export const APP_CODEX_ROOTS = ["ChatGPT.app", "Codex.app"].flatMap((app) =>
  ["/Applications", join(homedir(), "Applications")].map((dir) => join(dir, app, "Contents", "Resources", "codex-cli")),
);

function versionOf(text: string): { parts: number[]; pre: boolean } | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?/.exec(text);
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : undefined;
}

/** Positive when version text `a` is newer than `b` ("codex-cli 0.165.0-alpha.1.2" vs "0.153.4"); unknown is oldest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const pa = versionOf(a ?? "");
  const pb = versionOf(b ?? "");
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  return (pb.pre ? 1 : 0) - (pa.pre ? 1 : 0);
}

/** The Codex copies the apps carry, with their versions (`codex-package.json` names the entry point). */
export function appCodexes(roots: string[] = APP_CODEX_ROOTS): Array<{ command: string; version: string }> {
  const out: Array<{ command: string; version: string }> = [];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "codex-package.json"), "utf8"));
      const entry = typeof pkg.entrypoint === "string" && /^[\w-]+(\/[\w.-]+)*$/.test(pkg.entrypoint) && !pkg.entrypoint.includes("..") ? pkg.entrypoint : "bin/codex";
      const command = join(root, entry);
      if (typeof pkg.version === "string" && existsSync(command)) out.push({ command, version: pkg.version });
    } catch {
      // Not installed here.
    }
  }
  return out;
}

/**
 * The newest Codex on this machine: the one on PATH or a copy the ChatGPT / Codex app carries. Codex's servers offer
 * newer models only to newer clients, so an npm install left behind sees an older line-up (GPT-6 Astra and GPT-5.6
 * where the app's copy also has GPT-6.1 Sol, Terra and GPT-6 Luna).
 */
export function newestCodex(onPath: string, apps = appCodexes()): string {
  if (!apps.length) return onPath;
  let version: string | undefined;
  try {
    version = execFileSync(onPath, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    version = undefined;
  }
  let best: { command: string; version: string | undefined } = { command: onPath, version };
  for (const a of apps) if (compareVersions(a.version, best.version) > 0) best = a;
  return best.command;
}

/** Target script of an npm cmd-shim: `"%dp0%\node_modules\pkg\bin\cli.js" %*`. */
export function shimTarget(cmdFile: string): string | undefined {
  try {
    const text = readFileSync(cmdFile, "utf8");
    const m = /"%~?dp0%?\\([^"]+?\.m?js)"/i.exec(text);
    if (!m) return undefined;
    // The shim spells the path with backslashes; split it so the join is right whatever platform reads the shim.
    const target = join(dirname(cmdFile), ...m[1].split(/[\\/]/));
    return existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** Command that runs the stdio MCP bridge with the current Node binary: the checkout's bridge, or this file's `mcp-bridge` command when running as the single-file download. */
export function defaultBridgeCommand(): string[] {
  let entry: string | undefined;
  try {
    entry = fileURLToPath(import.meta.resolve("@owlbot/mcp-bridge"));
  } catch {
    entry = fileURLToPath(new URL("../../mcp-bridge/src/index.ts", import.meta.url));
  }
  if (!existsSync(entry)) return [process.execPath, fileURLToPath(import.meta.url), "mcp-bridge"];
  return [process.execPath, "--disable-warning=ExperimentalWarning", entry];
}

/** Hub-provided env is applied only for harmless keys: anything else could redirect credentials or inject code. */
const SAFE_ENV = /^(TZ|LANG|LANGUAGE|LC_[A-Z]+)$/;

/**
 * Model names and resume ids become CLI arguments (`--model x`, `codex exec resume <id>`): a value starting
 * with "-" could be parsed as a flag (e.g. a sandbox bypass), so only plain tokens are accepted.
 */
const SAFE_ARG = /^[A-Za-z0-9][\w.:/@[\]-]{0,199}$/;

function safeArg(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !SAFE_ARG.test(v)) throw new Error(`Invalid ${field}: ${String(v).slice(0, 80)}`);
  return v;
}

export interface BrainHostOptions {
  home: string;
  policy: PolicyStore;
  /** The hub URL this node paired with; the MCP bridge talks to `${hubUrl}/mcp`. */
  hubUrl?: string;
  bridgeCommand?: string[];
  log?: (msg: string) => void;
}

export class BrainHost {
  private o: BrainHostOptions;
  private providers = new Map<NodeBrainId, BrainProviderImpl>();
  private sessions = new Map<string, { brainId: NodeBrainId; session: BrainSessionImpl; workspace: string }>();
  private lastProbe = new Map<NodeBrainId, ProbeResult>();

  constructor(o: BrainHostOptions) {
    this.o = o;
    const policy = () => o.policy.get();
    const stateDir = (id: string) => join(o.home, "brains", id);
    const log = (m: string) => o.log?.(m);
    this.providers.set(
      "claude-code",
      createClaudeCodeProvider({
        command: () => resolveCli(policy().brains["claude-code"].command ?? DEFAULT_COMMANDS["claude-code"]),
        allowedTools: () => policy().brains["claude-code"].allowedTools,
        stateDir: stateDir("claude-code"),
        log,
        locale: hubLocale,
      }),
    );
    this.providers.set(
      "codex",
      createCodexProvider({
        command: () => this.codexCommand(),
        sandbox: () => policy().brains.codex.sandbox,
        stateDir: stateDir("codex"),
        log,
        locale: hubLocale,
      }),
    );
  }

  private codex?: { at: number; command: string };

  /** The Codex policy names, else the newest on this machine (asked again every ten minutes). */
  private codexCommand(): string {
    const named = this.o.policy.get().brains.codex.command;
    if (named || process.platform !== "darwin") return resolveCli(named ?? DEFAULT_COMMANDS.codex);
    if (!this.codex || Date.now() - this.codex.at > 10 * 60_000) this.codex = { at: Date.now(), command: newestCodex(DEFAULT_COMMANDS.codex) };
    return this.codex.command;
  }

  private enabled(id: string): id is NodeBrainId {
    return (BRAIN_IDS as readonly string[]).includes(id) && this.o.policy.get().brains[id as NodeBrainId].enabled;
  }

  private provider(id: string): BrainProviderImpl {
    if (!(BRAIN_IDS as readonly string[]).includes(id)) throw new Error(`Unknown brain: ${id}`);
    if (!this.enabled(id)) throw new Error(`Brain ${id} is disabled on this machine (policy.json)`);
    return this.providers.get(id as NodeBrainId)!;
  }

  /** Probe every known brain; disabled ones are reported as unavailable. */
  async probeAll(): Promise<MachineInfo["clis"]> {
    return Promise.all(
      BRAIN_IDS.map(async (id) => {
        if (!this.enabled(id)) {
          const r = { available: false, authenticated: false, detail: tHub("brains.disabled") };
          this.lastProbe.set(id, r);
          return { brainId: id, ...r };
        }
        let r: ProbeResult;
        try {
          r = await this.providers.get(id)!.probe();
        } catch (e: any) {
          r = { available: false, authenticated: false, detail: e?.message ?? String(e) };
        }
        this.lastProbe.set(id, r);
        return { brainId: id, ...r };
      }),
    );
  }

  /** Brains to announce in node.hello: enabled and installed (as of the last probe). */
  available(): Array<{ id: string; label: string }> {
    return BRAIN_IDS.filter((id) => this.enabled(id) && this.lastProbe.get(id)?.available).map((id) => ({ id, label: this.providers.get(id)!.label }));
  }

  async probe(p: { brainId: string; variant?: string }): Promise<ProbeResult> {
    const r = await this.provider(p.brainId).probe(p.variant);
    this.lastProbe.set(p.brainId as NodeBrainId, r);
    return r;
  }

  async create(p: { brainId: string; opts: BrainSessionOptions }): Promise<{ workspace: string }> {
    const provider = this.provider(p.brainId);
    const opts = p.opts;
    if (!opts?.sessionId || typeof opts.sessionId !== "string") throw new Error("sessionId is required");
    const policy = this.o.policy.get();
    const workspace = resolveWorkspace(opts.workspace, policy.workspacesRoot);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env ?? {})) if (SAFE_ENV.test(k) && typeof v === "string") env[k] = v;
    const local: BrainSessionOptions = {
      ...opts,
      model: safeArg(opts.model, "model"),
      effort: safeArg(opts.effort, "effort"),
      variant: safeArg(opts.variant, "variant"),
      resume: safeArg(opts.resume, "resume"),
      workspace,
      mcp: {
        url: this.o.hubUrl ? `${this.o.hubUrl}/mcp` : String(opts.mcp?.url ?? ""),
        token: String(opts.mcp?.token ?? ""),
        bridgeCommand: this.o.bridgeCommand ?? defaultBridgeCommand(),
      },
      // Hub-side paths mean nothing here.
      skillsDir: undefined,
      claudePluginDirs: [],
      env,
    };
    const old = this.sessions.get(opts.sessionId);
    if (old) await Promise.resolve(old.session.close()).catch(() => {});
    const session = await provider.createSession(local);
    this.sessions.set(opts.sessionId, { brainId: p.brainId as NodeBrainId, session, workspace });
    return { workspace };
  }

  async send(p: { sessionId: string; turn: BrainTurn }, emit: (event: BrainEvent) => void): Promise<void> {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw new Error(`Unknown brain session: ${p.sessionId}`);
    try {
      for await (const event of s.session.send(p.turn)) emit(event);
    } catch (e: any) {
      emit({ type: "error", message: e?.message ?? String(e), fatal: true });
    }
  }

  /** More input for the turn in progress; false sends it as the next turn. */
  async steer(p: { sessionId: string; turn: BrainTurn }): Promise<boolean> {
    const s = this.sessions.get(p.sessionId)?.session;
    return !!(s?.steer && (await s.steer(p.turn)));
  }

  /** Get ready for a turn soon (a dialog the person opened). */
  async warm(p: { sessionId: string }): Promise<void> {
    await this.sessions.get(p.sessionId)?.session.warm?.();
  }

  async interrupt(p: { sessionId: string }): Promise<void> {
    await this.sessions.get(p.sessionId)?.session.interrupt();
  }

  async close(p: { sessionId: string }): Promise<void> {
    const s = this.sessions.get(p.sessionId);
    this.sessions.delete(p.sessionId);
    if (!s) return;
    await s.session.close();
    // Per-session private files (MCP token, prompt) live under the brain's state dir.
    try {
      rmSync(join(this.o.home, "brains", s.brainId, "sessions", p.sessionId.replace(/[^\w-]/g, "_")), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close({ sessionId }).catch(() => {})));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
