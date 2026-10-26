// OpenAI Codex CLI as a brain: `codex exec --json` per turn, `codex exec resume <thread>` between turns.
// Uses the user's ChatGPT subscription (`codex login` stored in HOME/.codex) or OPENAI_API_KEY.

import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions, BrainTurn, ProbeResult } from "@owlbot/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@owlbot/plugin-sdk";
import type { Locale } from "@owlbot/shared/i18n";
import { capture, childEnv, runLines } from "./proc.ts";
import { brainsT } from "./messages.ts";
import { parseCodexDeviceLogin, runCliLogin } from "./login.ts";

export interface CodexOptions {
  command?: () => string;
  authEnv?: () => Promise<Record<string, string>>;
  /** "danger-full-access" inside the container (isolation comes from unix users + egress proxy). */
  sandbox?: () => "read-only" | "workspace-write" | "danger-full-access";
  stateDir: string;
  log?: (msg: string) => void;
  /** Language for messages people read (probe details, failures); English by default. */
  locale?: () => Locale;
  /** How long a sign-in from the chat may wait for the user (Codex device codes last 15 minutes). */
  loginTimeoutMs?: number;
}

/** Turns `codex exec --json` events into BrainEvents. */
export class CodexStreamParser {
  threadId?: string;
  limit?: { resetAt?: string; detail: string };
  failed?: string;
  completed = false;

  push(ev: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!ev || typeof ev !== "object") return out;
    switch (ev.type) {
      case "thread.started":
        this.threadId = ev.thread_id ?? this.threadId;
        break;
      case "item.started": {
        const it = ev.item ?? {};
        if (it.type === "mcp_tool_call") out.push({ type: "tool_call", id: it.id, name: it.tool ?? "tool", input: it.arguments ?? {} });
        if (it.type === "command_execution") out.push({ type: "tool_call", id: it.id, name: "shell", input: { command: it.command } });
        if (it.type === "web_search") out.push({ type: "tool_call", id: it.id, name: "WebSearch", input: { query: it.query } });
        break;
      }
      case "item.completed": {
        const it = ev.item ?? {};
        if (it.type === "agent_message" && it.text) out.push({ type: "text", delta: String(it.text) + "\n" });
        if (it.type === "mcp_tool_call") {
          const r = it.result?.content ? it.result.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n") : it.error?.message ?? JSON.stringify(it.result ?? "");
          out.push({ type: "tool_result", id: it.id, output: String(r), isError: it.status === "failed" || !!it.error });
        }
        if (it.type === "command_execution") out.push({ type: "tool_result", id: it.id, output: String(it.aggregated_output ?? ""), isError: it.exit_code !== 0 && it.exit_code !== undefined });
        if (it.type === "file_change") out.push({ type: "tool_result", id: it.id, output: (it.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join("\n") });
        if (it.type === "error") out.push({ type: "error", message: String(it.message ?? "codex error") });
        break;
      }
      case "turn.completed": {
        this.completed = true;
        const u = ev.usage ?? {};
        out.push({ type: "usage", inputTokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 });
        break;
      }
      case "turn.failed":
      case "error": {
        const message = String(ev.error?.message ?? ev.message ?? "codex error");
        if (/usage limit|rate limit|quota|limit reached|try again/i.test(message)) this.limit = { detail: message, resetAt: parseCodexReset(message) };
        else this.failed = message;
        break;
      }
    }
    return out;
  }
}

/** "... try again in 2 hours 5 minutes" / "in 37 minutes" → ISO time. */
export function parseCodexReset(text: string, now = Date.now()): string | undefined {
  const re = /\bin\s+(?:(\d+)\s*(?:days?|d)\b)?\s*(?:(\d+)\s*(?:hours?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && !m[1] && !m[2] && !m[3]) if (m[0].length === 0) re.lastIndex++;
  if (!m) return undefined;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
  return new Date(now + ms).toISOString();
}

function tomlString(s: string): string {
  return JSON.stringify(s); // JSON strings are valid TOML basic strings
}

class CodexSession implements BrainSessionImpl {
  private threadId?: string;
  private proc?: ReturnType<typeof runLines>;
  private interrupted = false;
  private o: BrainSessionOptions;
  private p: CodexOptions;
  private dir: string;

  constructor(opts: BrainSessionOptions, p: CodexOptions) {
    this.o = opts;
    this.p = p;
    this.threadId = opts.resume;
    this.dir = join(p.stateDir, "sessions", opts.sessionId.replace(/[^\w-]/g, "_"));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tokenFile = join(this.dir, "token");
    writeFileSync(tokenFile, opts.mcp.token, { mode: 0o600 });
    try {
      chmodSync(tokenFile, 0o600);
    } catch {
      /* windows */
    }
    // Codex reads AGENTS.md from the working directory: that is where our system prompt goes.
    const agentsFile = join(opts.workspace, "AGENTS.md");
    const marker = "<!-- owlbot:system -->";
    const existing = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    const userPart = existing.includes(marker) ? existing.slice(existing.indexOf("<!-- /owlbot:system -->") + 24) : existing;
    writeFileSync(agentsFile, `${marker}\n${opts.systemPrompt}\n<!-- /owlbot:system -->\n${userPart}`);
  }

  private args(): string[] {
    const [command, ...args] = this.o.mcp.bridgeCommand.length ? this.o.mcp.bridgeCommand : ["owlbot-mcp-bridge"];
    const sandbox = this.p.sandbox?.() ?? "danger-full-access";
    const cfg = [
      `mcp_servers.owlbot.command=${tomlString(command)}`,
      `mcp_servers.owlbot.args=[${args.map(tomlString).join(",")}]`,
      `mcp_servers.owlbot.env={OWLBOT_URL=${tomlString(this.o.mcp.url)},OWLBOT_TOKEN_FILE=${tomlString(join(this.dir, "token"))}}`,
      `mcp_servers.owlbot.tool_timeout_sec=3600`,
      `approval_policy="never"`,
      `sandbox_mode=${tomlString(sandbox)}`,
    ];
    const a = ["exec", "--json", "--skip-git-repo-check", "-C", this.o.workspace];
    for (const c of cfg) a.push("-c", c);
    if (this.o.model) a.push("-m", this.o.model);
    if (this.threadId) a.push("resume", this.threadId, "-");
    else a.push("-");
    return a;
  }

  async *send(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    this.interrupted = false;
    const env = childEnv(process.env, { ...this.o.env, ...(await this.p.authEnv?.()) });
    const parser = new CodexStreamParser();
    const proc = runLines(this.p.command?.() ?? "codex", this.args(), { cwd: this.o.workspace, env, input: turn.text });
    this.proc = proc;
    for await (const line of proc.lines) {
      if (!line.trim().startsWith("{")) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      for (const e of parser.push(ev)) yield e;
    }
    const exit = await proc.exited;
    this.proc = undefined;
    if (parser.threadId) this.threadId = parser.threadId;
    if (!this.interrupted) {
      if (parser.limit) yield { type: "limit_hit", resetAt: parser.limit.resetAt, detail: `Codex: ${parser.limit.detail}` };
      else if (parser.failed || exit.code !== 0) {
        const stderr = proc.stderr();
        const notInstalled = /ENOENT|not recognized|command not found/i.test(stderr);
        const auth = /not logged in|login|401|unauthorized|api key/i.test(`${parser.failed ?? ""}\n${stderr}`);
        const t = brainsT(this.p.locale?.());
        yield {
          type: "error",
          fatal: !parser.completed,
          message: notInstalled
            ? t("codex.notInstalled")
            : auth
              ? t("codex.notSignedIn")
              : (parser.failed ?? stderr.trim().split("\n").slice(-6).join("\n")) || t("codex.failed"),
        };
      }
    }
    yield { type: "done", resumeToken: this.threadId };
  }

  interrupt(): void {
    if (!this.proc) return;
    this.interrupted = true;
    const c = this.proc.child;
    c.kill("SIGINT");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 5000).unref();
  }

  close(): void {
    this.interrupt();
  }
}

export function createCodexProvider(p: CodexOptions): BrainProviderImpl {
  return {
    id: "codex",
    label: brainsT()("codex.label"),
    async probe(): Promise<ProbeResult> {
      const t = brainsT(p.locale?.());
      const command = p.command?.() ?? "codex";
      const env = childEnv(process.env, { ...(await p.authEnv?.().catch(() => ({}))) });
      const v = await capture(command, ["--version"], env);
      if (v.code !== 0) return { available: false, authenticated: false, detail: t("codex.notInstalled") };
      const version = v.stdout.trim().split(/\s+/).pop();
      if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return { available: true, authenticated: true, version, detail: t("codex.apiKey") };
      const s = await capture(command, ["login", "status"], env);
      const ok = s.code === 0 && /logged in/i.test(s.stdout + s.stderr);
      return { available: true, authenticated: ok, version, detail: ok ? (s.stdout + s.stderr).trim().split("\n")[0] : t("codex.noLogin") };
    },
    async createSession(opts: BrainSessionOptions): Promise<BrainSessionImpl> {
      mkdirSync(opts.workspace, { recursive: true });
      return new CodexSession(opts, p);
    },
    // Device code sign-in as the same user and HOME the sessions use: the user opens the page and types the code.
    login({ env, onUpdate }) {
      const t = brainsT(p.locale?.());
      return runCliLogin({
        command: p.command?.() ?? "codex",
        args: ["login", "--device-auth"],
        env: childEnv(process.env, { ...env, NO_COLOR: "1" }),
        onUpdate,
        parse: parseCodexDeviceLogin,
        timeoutMs: p.loginTimeoutMs ?? 15 * 60_000,
        t,
        notInstalled: t("codex.notInstalled"),
      });
    },
  };
}
