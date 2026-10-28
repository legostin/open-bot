// Codex through `codex app-server` (JSON-RPC over stdio, one process per turn): thread/start or thread/resume, then
// turn/start; turn/steer adds the user's input to the turn in progress, which takes it at its next step.

import type { BrainEvent, BrainTurn } from "@owlbot/shared";
import { EventQueue, runLines, type RunningProcess } from "./proc.ts";

/** Codex's v2 notifications as BrainEvents. Pure: easy to test with recorded frames. */
export class CodexAppParser {
  limit?: { resetAt?: string; detail: string };
  failed?: string;
  auth = false;
  completed = false;
  private streamed = new Set<string>();
  private input = 0;
  private output = 0;
  turnId?: string;

  push(method: string, p: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!p || typeof p !== "object") return out;
    switch (method) {
      case "item/agentMessage/delta":
        if (p.delta) {
          this.streamed.add(p.itemId);
          out.push({ type: "text", delta: String(p.delta) });
        }
        break;
      case "item/started": {
        const it = p.item ?? {};
        if (it.type === "mcpToolCall" || it.type === "dynamicToolCall") out.push({ type: "tool_call", id: it.id, name: it.tool ?? "tool", input: it.arguments ?? {} });
        if (it.type === "commandExecution") out.push({ type: "tool_call", id: it.id, name: "shell", input: { command: it.command } });
        if (it.type === "webSearch") out.push({ type: "tool_call", id: it.id, name: "WebSearch", input: { query: it.query ?? it.action?.query ?? "" } });
        if (it.type === "fileChange") out.push({ type: "tool_call", id: it.id, name: "apply_patch", input: { files: (it.changes ?? []).map((c: any) => c.path) } });
        break;
      }
      case "item/completed": {
        const it = p.item ?? {};
        if (it.type === "agentMessage") {
          if (!this.streamed.has(it.id) && it.text) out.push({ type: "text", delta: String(it.text) });
          out.push({ type: "text", delta: "\n" });
        }
        if (it.type === "mcpToolCall") {
          const text = it.result?.content ? it.result.content.map((c: any) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n") : (it.error?.message ?? "");
          out.push({ type: "tool_result", id: it.id, output: String(text), isError: it.status === "failed" || !!it.error });
        }
        if (it.type === "dynamicToolCall") {
          const text = (it.contentItems ?? []).map((c: any) => (c?.type === "inputText" || c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n");
          out.push({ type: "tool_result", id: it.id, output: text, isError: it.success === false });
        }
        if (it.type === "commandExecution") out.push({ type: "tool_result", id: it.id, output: String(it.aggregatedOutput ?? ""), isError: typeof it.exitCode === "number" && it.exitCode !== 0 });
        if (it.type === "fileChange") out.push({ type: "tool_result", id: it.id, output: (it.changes ?? []).map((c: any) => `${c.kind?.type ?? c.kind} ${c.path}`).join("\n") });
        break;
      }
      case "thread/tokenUsage/updated": {
        const last = p.tokenUsage?.last;
        if (last) {
          this.input += last.inputTokens ?? 0;
          this.output += last.outputTokens ?? 0;
        }
        break;
      }
      case "error":
        if (!p.willRetry) this.fail(p.error);
        break;
      case "turn/completed": {
        if (this.turnId && p.turn?.id && p.turn.id !== this.turnId) break;
        this.completed = true;
        if (p.turn?.status === "failed") this.fail(p.turn.error);
        out.push({ type: "usage", inputTokens: this.input, outputTokens: this.output });
        break;
      }
    }
    return out;
  }

  private fail(err: any): void {
    const message = String(err?.message ?? "codex error");
    const info = err?.codexErrorInfo;
    const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : "";
    if (kind === "usageLimitExceeded" || kind === "rateLimitExceeded" || /usage limit|rate limit|quota|limit reached/i.test(message)) {
      this.limit = { detail: message, resetAt: parseCodexReset(message) };
    } else {
      if (kind === "unauthorized") this.auth = true;
      this.failed ??= message;
    }
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

export interface AppServerSetup {
  command: string;
  /** `-c key=value` overrides, as for `codex exec`. */
  config: string[];
  cwd: string;
  env: Record<string, string>;
  model?: string;
  sandbox: string;
  threadId?: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

/** The app-server could not start a turn at all (an old Codex without it): the caller uses `codex exec`. */
export class AppServerUnsupported extends Error {}

/**
 * One turn over a fresh `codex app-server`: yields BrainEvents until the turn completes. `steer()` adds input while it
 * runs. `threadId` is the thread to resume (or the one it started), for the next turn.
 */
export class CodexAppTurn {
  threadId?: string;
  readonly parser = new CodexAppParser();
  private proc?: RunningProcess;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private events = new EventQueue<BrainEvent>();
  private started = false;
  private finished = false;
  private s: AppServerSetup;

  constructor(s: AppServerSetup) {
    this.s = s;
    this.threadId = s.threadId;
  }

  private request<T = any>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.proc?.write(`${JSON.stringify({ id, method, params })}\n`)) {
        this.pending.delete(id);
        reject(new Error("codex app-server is not running"));
      }
    });
  }

  private notify(method: string): void {
    this.proc?.write(`${JSON.stringify({ method })}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim().startsWith("{")) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(Object.assign(new Error(String(m.error.message ?? "error")), { rpc: m.error }));
      else p?.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      // approval_policy is "never": an approval still asked is declined, anything else is not supported here.
      const approval = /requestApproval|Approval$/.test(m.method);
      this.proc?.write(`${JSON.stringify(approval ? { id: m.id, result: { decision: "decline" } } : { id: m.id, error: { code: -32601, message: "not supported by Owlbot" } })}\n`);
      return;
    }
    if (m.method === "thread/started" && m.params?.thread?.id) this.threadId = m.params.thread.id;
    for (const e of this.parser.push(m.method, m.params)) this.events.push(e);
    if (m.method === "turn/completed" && this.parser.completed) this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.events.end();
  }

  private input(turn: BrainTurn): unknown[] {
    const items: unknown[] = [{ type: "text", text: turn.text, text_elements: [] }];
    for (const a of turn.attachments ?? []) if (/\.(png|jpe?g|gif|webp)$/i.test(a)) items.push({ type: "localImage", path: a });
    return items;
  }

  /** Throws AppServerUnsupported when this Codex has no app-server (nothing has been sent to the model then). */
  async *run(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    const args = ["app-server"];
    for (const c of this.s.config) args.push("-c", c);
    const proc = runLines(this.s.command, args, { cwd: this.s.cwd, env: this.s.env, keepInput: true });
    this.proc = proc;
    const reading = (async () => {
      for await (const line of proc.lines) this.onLine(line);
      for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
      this.pending.clear();
      this.finish();
    })();
    try {
      try {
        await this.request("initialize", { clientInfo: { name: "owlbot", title: "Owlbot", version: "1" }, capabilities: null });
      } catch {
        const exit = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
        throw new AppServerUnsupported(exit ? proc.stderr().trim().split("\n").slice(-3).join("\n") : "codex app-server did not answer");
      }
      this.notify("initialized");
      const thread = { cwd: this.s.cwd, approvalPolicy: "never", sandbox: this.s.sandbox, ...(this.s.model ? { model: this.s.model } : {}) };
      let r: any;
      if (this.threadId) r = await this.request("thread/resume", { threadId: this.threadId, ...thread }).catch(() => undefined);
      if (!r) r = await this.request("thread/start", thread);
      this.threadId = r?.thread?.id ?? this.threadId;
      const t = await this.request("turn/start", { threadId: this.threadId, input: this.input(turn) });
      this.parser.turnId = t?.turn?.id;
      this.started = true;
    } catch (e) {
      if (e instanceof AppServerUnsupported) {
        proc.child.kill("SIGKILL");
        throw e;
      }
      this.events.push({ type: "error", message: String((e as Error)?.message ?? e), fatal: true });
      this.finish();
    }
    for await (const e of this.events) yield e;
    this.started = false;
    proc.endInput();
    const exited = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 3000).unref())]);
    if (!exited) proc.child.kill("SIGKILL");
    await reading.catch(() => {});
  }

  /** stderr so far, for failures people read. */
  stderr(): string {
    return this.proc?.stderr() ?? "";
  }

  /** Add input to the turn in progress; false when there is none (or Codex refused it). */
  async steer(turn: BrainTurn): Promise<boolean> {
    const turnId = this.parser.turnId;
    if (!this.started || this.finished || !turnId || !this.threadId) return false;
    try {
      await this.request("turn/steer", { threadId: this.threadId, expectedTurnId: turnId, input: this.input(turn) });
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.parser.turnId;
    if (this.started && turnId && this.threadId) {
      await Promise.race([this.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    const c = this.proc?.child;
    if (!c || c.exitCode !== null) return;
    c.kill("SIGINT");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 5000).unref();
  }
}
