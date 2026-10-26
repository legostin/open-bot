// Claude Code as a brain: one headless `claude -p` process per turn, `--resume` between turns.
// Uses the user's subscription (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or an existing login in HOME).

import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions, BrainTurn, ProbeResult } from "@openbot/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@openbot/plugin-sdk";
import { capture, childEnv, runLines, textOfToolContent } from "./proc.ts";

const MCP_PREFIX = "mcp__openbot__";

export const DEFAULT_CLAUDE_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Skill",
  "NotebookEdit",
  "mcp__openbot",
];

export interface ClaudeCodeOptions {
  /** CLI command (default "claude"). */
  command?: () => string;
  /** Extra env for the CLI (e.g. CLAUDE_CODE_OAUTH_TOKEN), resolved per session. */
  authEnv?: () => Promise<Record<string, string>>;
  /** Built-in tools Claude Code may use without asking (dontAsk mode denies everything else). */
  allowedTools?: () => string[];
  /** Where per-session private files (MCP config with the token, prompt) are written. */
  stateDir: string;
  log?: (msg: string) => void;
}

/** Turns Claude Code stream-json messages into BrainEvents. Pure: easy to test with recorded fixtures. */
export class ClaudeStreamParser {
  sessionId?: string;
  limit?: { resetAt?: string; detail: string };
  private streamed = new Set<string>();
  sawResult = false;
  resultError?: string;
  mcpFailed = false;

  push(msg: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!msg || typeof msg !== "object") return out;
    if (msg.session_id) this.sessionId = msg.session_id;
    const top = msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined;
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init" && Array.isArray(msg.mcp_servers)) {
          const ob = msg.mcp_servers.find((s: any) => s.name === "openbot");
          if (ob && ob.status !== "connected") {
            this.mcpFailed = true;
            out.push({ type: "error", message: `Инструменты open-bot недоступны в Claude Code (MCP: ${ob.status})` });
          }
        }
        break;
      }
      case "stream_event": {
        const ev = msg.event;
        if (!top || !ev) break;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (msg.api_message_id) this.streamed.add(msg.api_message_id);
          out.push({ type: "text", delta: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        if (!top) break;
        const m = msg.message ?? {};
        for (const block of m.content ?? []) {
          if (block.type === "text" && block.text && !this.streamed.has(m.id)) out.push({ type: "text", delta: block.text });
          if (block.type === "tool_use") out.push({ type: "tool_call", id: block.id, name: stripPrefix(block.name), input: block.input ?? {} });
        }
        if (typeof m.content?.[0]?.text === "string" && /usage limit|limit reached/i.test(m.content[0].text) && m.model === "<synthetic>") {
          this.limit = { detail: m.content[0].text, resetAt: parseResetFromText(m.content[0].text) };
        }
        break;
      }
      case "user": {
        if (!top) break;
        for (const block of msg.message?.content ?? []) {
          if (block?.type === "tool_result") out.push({ type: "tool_result", id: block.tool_use_id, output: textOfToolContent(block.content), isError: !!block.is_error });
        }
        break;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info ?? {};
        if (info.status === "rejected") {
          this.limit = {
            resetAt: info.resetsAt ? new Date(Number(info.resetsAt) * 1000).toISOString() : undefined,
            detail: `Claude: лимит подписки (${info.rateLimitType ?? "limit"})`,
          };
        }
        break;
      }
      case "result": {
        this.sawResult = true;
        const u = msg.usage ?? {};
        out.push({
          type: "usage",
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        });
        if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
          const text = String(msg.result ?? msg.subtype ?? "error");
          if (this.limit || /usage limit|rate limit|limit reached|out of extra usage/i.test(text)) {
            this.limit ??= { detail: text, resetAt: parseResetFromText(text) };
          } else this.resultError = text;
        }
        break;
      }
    }
    return out;
  }
}

function stripPrefix(name: string): string {
  return typeof name === "string" && name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** "Claude AI usage limit reached|1793013600" or "... resets 5pm" → ISO date when we can tell. */
export function parseResetFromText(text: string): string | undefined {
  const m = /\|(\d{10})\b/.exec(text);
  if (m) return new Date(Number(m[1]) * 1000).toISOString();
  return undefined;
}

export function classifyClaudeFailure(stderr: string, resultError?: string): { message: string; fatal: boolean; auth: boolean; noSession: boolean } {
  const text = `${resultError ?? ""}\n${stderr}`;
  const noSession = /No conversation found|session .* not found/i.test(text);
  const auth = /not logged in|please run .*login|invalid api key|authentication|OAuth token|401|\/login/i.test(text) && !noSession;
  const enoent = /ENOENT|not recognized|command not found/i.test(text);
  if (enoent) return { message: "Claude Code не установлен (команда claude не найдена)", fatal: true, auth: false, noSession: false };
  if (auth) return { message: "Claude Code не авторизован: выполните `claude setup-token` и сохраните токен в vault как claude_code_token", fatal: true, auth: true, noSession: false };
  const tail = text.trim().split("\n").slice(-6).join("\n").slice(0, 1500);
  return { message: tail || "Claude Code завершился с ошибкой", fatal: true, auth: false, noSession };
}

class ClaudeCodeSession implements BrainSessionImpl {
  private resumeId?: string;
  private child?: ReturnType<typeof runLines>;
  private interrupted = false;
  private o: BrainSessionOptions;
  private p: ClaudeCodeOptions;
  private dir: string;

  constructor(opts: BrainSessionOptions, p: ClaudeCodeOptions) {
    this.o = opts;
    this.p = p;
    this.resumeId = opts.resume;
    this.dir = join(p.stateDir, "sessions", opts.sessionId.replace(/[^\w-]/g, "_"));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const [command, ...args] = opts.mcp.bridgeCommand.length ? opts.mcp.bridgeCommand : ["openbot-mcp-bridge"];
    const tokenFile = join(this.dir, "token");
    writePrivate(tokenFile, opts.mcp.token);
    writePrivate(
      join(this.dir, "mcp.json"),
      JSON.stringify({ mcpServers: { openbot: { type: "stdio", command, args, env: { OPENBOT_URL: opts.mcp.url, OPENBOT_TOKEN_FILE: tokenFile } } } }),
    );
    writePrivate(join(this.dir, "prompt.md"), opts.systemPrompt);
  }

  private args(): string[] {
    const tools = this.p.allowedTools?.() ?? DEFAULT_CLAUDE_TOOLS;
    const a = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      tools.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      join(this.dir, "mcp.json"),
      "--append-system-prompt-file",
      join(this.dir, "prompt.md"),
    ];
    if (this.o.model) a.push("--model", this.o.model);
    if (this.resumeId) a.push("--resume", this.resumeId);
    for (const d of this.o.claudePluginDirs ?? []) a.push("--plugin-dir", d);
    return a;
  }

  async *send(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    this.interrupted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const env = childEnv(process.env, {
        ...this.o.env,
        ...(await this.p.authEnv?.()),
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      });
      const parser = new ClaudeStreamParser();
      const proc = runLines(this.p.command?.() ?? "claude", this.args(), { cwd: this.o.workspace, env, input: turn.text });
      this.child = proc;
      for await (const line of proc.lines) {
        if (!line.trim().startsWith("{")) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of parser.push(msg)) yield ev;
      }
      const exit = await proc.exited;
      this.child = undefined;
      if (parser.sessionId) this.resumeId = parser.sessionId;
      if (this.interrupted) {
        yield { type: "done", resumeToken: this.resumeId };
        return;
      }
      if (parser.limit) {
        yield { type: "limit_hit", resetAt: parser.limit.resetAt, detail: parser.limit.detail };
        yield { type: "done", resumeToken: this.resumeId };
        return;
      }
      if (exit.code !== 0 || parser.resultError || !parser.sawResult) {
        const f = classifyClaudeFailure(proc.stderr(), parser.resultError);
        if (f.noSession && attempt === 0 && this.resumeId) {
          this.p.log?.(`resume ${this.resumeId} not found, starting a fresh Claude Code session`);
          this.resumeId = undefined;
          continue;
        }
        if (parser.resultError && exit.code === 0) yield { type: "error", message: parser.resultError };
        else yield { type: "error", message: f.message, fatal: f.fatal };
      }
      yield { type: "done", resumeToken: this.resumeId };
      return;
    }
  }

  interrupt(): void {
    if (!this.child) return;
    this.interrupted = true;
    this.child.child.kill("SIGINT");
    const c = this.child.child;
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 5000).unref();
  }

  close(): void {
    this.interrupt();
    try {
      rmSync(join(this.dir, "token"), { force: true });
    } catch {
      /* ignore */
    }
  }
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

export function createClaudeCodeProvider(p: ClaudeCodeOptions): BrainProviderImpl {
  return {
    id: "claude-code",
    label: "Claude Code (подписка)",
    async probe(): Promise<ProbeResult> {
      const command = p.command?.() ?? "claude";
      const env = childEnv(process.env, { ...(await p.authEnv?.().catch(() => ({}))), DISABLE_AUTOUPDATER: "1" });
      const v = await capture(command, ["--version"], env);
      if (v.code !== 0) return { available: false, authenticated: false, detail: "Claude Code не установлен" };
      const version = v.stdout.trim().split(/\s+/)[0];
      if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return { available: true, authenticated: true, version, detail: "токен из vault" };
      const s = await capture(command, ["auth", "status", "--json"], env);
      try {
        const j = JSON.parse(s.stdout);
        return { available: true, authenticated: !!j.loggedIn, version, detail: j.loggedIn ? `вход: ${j.authMethod ?? "ok"}${j.subscriptionType ? ` (${j.subscriptionType})` : ""}` : "нет входа: добавьте claude_code_token в vault" };
      } catch {
        return { available: true, authenticated: false, version, detail: "не удалось проверить вход: добавьте claude_code_token в vault" };
      }
    },
    async createSession(opts: BrainSessionOptions): Promise<BrainSessionImpl> {
      return new ClaudeCodeSession(opts, p);
    },
  };
}
