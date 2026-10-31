// One brain session: the agent loop over the hub's MCP tools, history persistence and resume. Input that arrives
// while a turn runs (steer) goes to the model with its next request: after the tool results, or as a new message.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import type { BrainEvent, BrainSessionOptions, BrainTurn, Params } from "@piomio/shared";
import type { BrainSessionImpl, PluginContext } from "@piomio/plugin-sdk";
import { anthropicStream } from "./anthropic.ts";
import {
  compacted,
  compactionCut,
  contentText,
  digest,
  estimateTokens,
  hasThinking,
  saveSession,
  stripThinking,
  SUMMARY_SYSTEM,
  transcriptOf,
  trimHistory,
  truncate,
  type HistoryMessage,
  type ImagePart,
  type Part,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
} from "./history.ts";
import { LlmError, proxyEnvFrom } from "./http.ts";
import { McpClient, type McpContent, type McpTool } from "./mcp.ts";
import { openAiStream } from "./openai.ts";
import { responsesStream } from "./responses.ts";
import { sortedTools, type CallResult, type ModelCall, type ModelStream } from "./provider.ts";
import { resolveModel, vaultId, type ApiSettings, type VariantInfo } from "./settings.ts";

/** Tool output shown in the UI (the model gets the full content). */
const EVENT_OUTPUT_MAX = 8000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** A history past this share of its budget after a turn is compacted before the next one. */
const COMPACT_AHEAD = 0.85;
const SUMMARY_MAX_TOKENS = 8000;

/** The hub's "No vault item" error (hubs before i18n said "Net zapisi" in Russian, matched as escapes). */
const VAULT_MISSING_RE = /No vault item|not.?found|\u041d\u0435\u0442 \u0437\u0430\u043f\u0438\u0441\u0438/i;

/** The variant's API key from the vault; `error` is a message for people (probe detail, chat), in the hub language. */
export async function readKey(ctx: PluginContext, v: VariantInfo, s: ApiSettings): Promise<{ key?: string; error?: string }> {
  const ref = v.keyRef(s);
  if (!ref) return {};
  const id = vaultId(ref);
  try {
    const fields = await ctx.vault.get(`vault://${id}`, { reason: `API brain (${v.label})` });
    const value = fields?.value ?? Object.values(fields ?? {}).find((x) => typeof x === "string" && x.trim());
    if (typeof value === "string" && value.trim()) return { key: value.trim() };
    return { error: ctx.i18n.t("key.missing", { id }) };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (VAULT_MISSING_RE.test(msg)) return { error: ctx.i18n.t("key.missing", { id }) };
    return { error: ctx.i18n.t("key.noAccess", { id, detail: msg }) };
  }
}

function prefixHash(system: string, tools: McpTool[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ system, tools: sortedTools(tools) }))
    .digest("hex")
    .slice(0, 32);
}

function convertContent(content: McpContent[], maxChars: number): Array<TextPart | ImagePart> {
  const out: Array<TextPart | ImagePart> = [];
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string") out.push({ type: "text", text: truncate(c.text, maxChars) });
    else if (c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") out.push({ type: "image", mimeType: c.mimeType, data: c.data });
    else if (c.type === "resource") {
      const r = (c.resource ?? {}) as { text?: string; uri?: string };
      out.push({ type: "text", text: typeof r.text === "string" ? truncate(r.text, maxChars) : `[resource ${r.uri ?? ""}]` });
    } else out.push({ type: "text", text: truncate(`[${c.type}] ${JSON.stringify(c).slice(0, 2000)}`, maxChars) });
  }
  return out;
}

const textResult = (id: string, text: string, isError = true): ToolResultPart => ({ type: "tool_result", id, content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export interface SessionDeps {
  ctx: PluginContext;
  opts: BrainSessionOptions;
  variant: VariantInfo;
  settings: () => ApiSettings;
  history: HistoryMessage[];
  prefixHash?: string;
}

export class ApiBrainSession implements BrainSessionImpl {
  private ctx: PluginContext;
  private opts: BrainSessionOptions;
  private variant: VariantInfo;
  private settings: () => ApiSettings;
  private mcp: McpClient;
  history: HistoryMessage[];
  private prefix?: string;
  private abort?: AbortController;
  private running = false;
  private closed = false;
  /** Input for the turn in progress, not yet shown to the model. */
  private inbox: BrainTurn[] = [];
  /** Messages in the previous model request (cache read point). */
  private lastSent = 0;
  /** A compaction started after the last turn (while the user reads the reply): the next turn waits for it. */
  private compacting?: Promise<void>;
  private compactAbort?: AbortController;
  /** The provider refused the reasoning effort parameter (an OpenAI-compatible model without reasoning). */
  private noEffort = false;

  constructor(d: SessionDeps) {
    this.ctx = d.ctx;
    this.opts = d.opts;
    this.variant = d.variant;
    this.settings = d.settings;
    this.history = d.history;
    this.prefix = d.prefixHash;
    this.mcp = new McpClient(d.opts.mcp.url, d.opts.mcp.token);
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  async *send(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    // The hub chose how this turn thinks: from here on the session thinks so.
    if (turn.model) this.opts = { ...this.opts, model: turn.model };
    if (turn.effort) this.opts = { ...this.opts, effort: turn.effort };
    if (this.closed) {
      yield { type: "error", message: this.t("error.sessionClosed"), fatal: true };
      yield { type: "done", resumeToken: this.sessionId };
      return;
    }
    if (this.running) {
      yield { type: "error", message: this.t("error.busy") };
      yield { type: "done", resumeToken: this.sessionId };
      return;
    }
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    try {
      await this.compacting;
      // A session that was to resume but has no history left starts from the hub's recap.
      if (!this.history.length && turn.recap) turn = { ...turn, text: `${turn.recap}\n\n---\n${turn.text}` };
      yield* this.runTurn(turn, ac.signal);
      // Arrived as the model gave its last answer: the turn goes on with it.
      while (this.inbox.length && !ac.signal.aborted) yield* this.runTurn(this.takeInbox(), ac.signal);
    } catch (e: any) {
      yield { type: "error", message: this.t("error.internal", { detail: String(e?.message ?? e) }), fatal: true };
    } finally {
      this.running = false;
      this.abort = undefined;
      this.inbox = [];
      this.persist();
    }
    this.compactSoon();
    yield { type: "done", resumeToken: this.sessionId };
  }

  steer(turn: BrainTurn): boolean {
    if (!this.running || this.closed || this.abort?.signal.aborted) return false;
    this.inbox.push(turn);
    return true;
  }

  /** Everything steered in since the model's last request, as one turn. */
  private takeInbox(): BrainTurn {
    const turns = this.inbox.splice(0);
    return { text: turns.map((t) => t.text).join("\n\n"), attachments: turns.flatMap((t) => t.attachments ?? []) };
  }

  interrupt(): void {
    this.abort?.abort();
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.compactAbort?.abort();
    this.persist();
  }

  // ---------- internals ----------

  /** Text people read (chat errors and notes), in the hub language. */
  private t(key: string, params?: Params): string {
    return this.ctx.i18n.t(key, params);
  }

  private errorText(err: LlmError): string {
    return err.key ? this.t(err.key, err.params) : err.message;
  }

  /** Provider name in messages people read (the OpenAI-compatible server has a translated name). */
  private providerLabel(): string {
    return this.variant.id === "custom" ? this.t("variant.custom") : this.variant.label;
  }

  persist(): void {
    try {
      saveSession(this.ctx.dataDir, {
        version: 1,
        sessionId: this.sessionId,
        variant: this.variant.id,
        model: this.opts.model,
        prefixHash: this.prefix,
        updatedAt: new Date().toISOString(),
        messages: this.history,
      });
    } catch (e: any) {
      this.ctx.log.warn(`could not save the history of session ${this.sessionId}: ${e?.message ?? e}`);
    }
  }

  private streamFor(s: ApiSettings, key: string | undefined): (call: ModelCall) => ModelStream {
    const v = this.variant;
    const proxyEnv = proxyEnvFrom(this.opts.env);
    if (v.protocol === "anthropic") {
      const cfg = {
        baseUrl: v.baseUrl(s),
        apiKey: key ?? "",
        effort: EFFORTS.has(s.anthropicEffort) ? s.anthropicEffort : "",
        refusalFallback: s.anthropicRefusalFallback,
        eagerTools: s.anthropicEagerToolStreaming,
        proxyEnv,
      };
      return (call) => anthropicStream(cfg, call);
    }
    const cfg = {
      baseUrl: v.baseUrl(s),
      apiKey: key,
      label: this.providerLabel(),
      vision: v.vision(s),
      maxTokensField: v.id === "openai" ? ("max_completion_tokens" as const) : ("max_tokens" as const),
      extraHeaders: v.id === "openrouter" ? { "X-Title": "Piomio" } : undefined,
      proxyEnv,
      effortField: v.id === "openai" ? ("reasoning_effort" as const) : v.id === "openrouter" ? ("reasoning" as const) : undefined,
    };
    if (v.responses) return (call) => responsesStream(cfg, call);
    return (call) => openAiStream(cfg, call);
  }

  /** The session's reasoning effort when the provider takes it (the hub's choice for this kind of work). */
  private effort(): string | undefined {
    const e = this.opts.effort;
    return e && !this.noEffort && this.variant.efforts.includes(e) ? e : undefined;
  }

  // ---------- compaction: the older part becomes a summary, unnoticed ----------

  /** After a turn, a history near its budget is compacted while the user reads the reply: the next turn waits for it. */
  private compactSoon(): void {
    const s = this.settings();
    const budget = this.variant.historyBudget(s);
    if (this.closed || this.compacting || estimateTokens(this.history) <= budget * COMPACT_AHEAD) return;
    const ac = new AbortController();
    this.compactAbort = ac;
    this.compacting = this.compact(Math.floor(budget * COMPACT_AHEAD), ac.signal)
      .then(
        () => {},
        (e: any) => this.ctx.log.warn(`session ${this.sessionId}: compaction failed: ${e?.message ?? e}`),
      )
      .finally(() => {
        this.compacting = undefined;
        this.compactAbort = undefined;
      });
  }

  /**
   * Over `budget`: the older part of the history becomes a summary the model writes (a line per message when it
   * cannot), and the latest messages stay as they are. Nothing of it reaches the chat.
   */
  private async compact(budget: number, signal: AbortSignal): Promise<boolean> {
    if (estimateTokens(this.history) <= budget) return false;
    const cut = compactionCut(this.history, budget);
    if (cut <= 0) {
      this.trim(budget);
      return true;
    }
    const older = this.history.slice(0, cut);
    let summary: string | undefined;
    try {
      summary = await this.summarize(older, signal);
    } catch (e: any) {
      if (signal.aborted || this.closed) return false;
      this.ctx.log.warn(`session ${this.sessionId}: the model could not summarize (${e?.message ?? e}), keeping a digest`);
    }
    if (signal.aborted || this.closed) return false;
    const before = this.history.length;
    this.history = compacted(this.history, cut, summary || digest(older));
    this.lastSent = 0;
    this.persist();
    this.ctx.log.info(`session ${this.sessionId}: compacted ${before} → ${this.history.length} messages (${summary ? "summary" : "digest"})`);
    return true;
  }

  /** The summary of `older`, written by the session's model with little effort; its text never reaches the chat. */
  private async summarize(older: HistoryMessage[], signal: AbortSignal): Promise<string> {
    const s = this.settings();
    const key = await readKey(this.ctx, this.variant, s);
    if (key.error) throw new Error(key.error);
    const stream = this.streamFor(s, key.key)({
      model: resolveModel(this.variant, this.opts.model, s),
      system: SUMMARY_SYSTEM,
      tools: [],
      messages: [{ role: "user", parts: [{ type: "text", text: `Transcript of the older part:\n\n${transcriptOf(older)}\n\nWrite the summary now.` }] }],
      maxTokens: Math.min(s.maxTokens, SUMMARY_MAX_TOKENS),
      signal,
      ...(this.variant.efforts.includes("low") && !this.noEffort ? { effort: "low" } : {}),
    });
    let r = await stream.next();
    while (!r.done) r = await stream.next();
    const text = r.value.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
    if (!text || r.value.stop === "refusal" || r.value.stop === "aborted") throw new Error(`no summary (${r.value.stop})`);
    return text;
  }

  private userParts(turn: BrainTurn): Part[] {
    const parts: Part[] = [];
    if (turn.text) parts.push({ type: "text", text: turn.text });
    for (const a of turn.attachments ?? []) {
      const path = isAbsolute(a) ? a : resolve(this.opts.workspace, a);
      const mime = IMAGE_TYPES[extname(path).toLowerCase()];
      try {
        if (mime && statSync(path).size <= MAX_ATTACHMENT_BYTES) {
          parts.push({ type: "image", mimeType: mime, data: readFileSync(path).toString("base64") });
          continue;
        }
      } catch {
        parts.push({ type: "text", text: `[Attachment could not be read: ${a}]` });
        continue;
      }
      parts.push({ type: "text", text: `[Attached file: ${a}]` });
    }
    if (!parts.length) parts.push({ type: "text", text: "(empty message)" });
    return parts;
  }

  /** Every tool call must be answered before the next user turn (e.g. after a crash mid-tool). */
  private sealDanglingToolCalls(): void {
    const last = this.history[this.history.length - 1];
    if (last?.role !== "assistant") return;
    const calls = last.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
    if (calls.length) this.history.push({ role: "user", parts: calls.map((c) => textResult(c.id, "Not executed: the previous turn was interrupted.")) });
  }

  private trim(budget: number): void {
    const { messages, trimmed } = trimHistory(this.history, budget);
    if (!trimmed) return;
    this.ctx.log.info(`session ${this.sessionId}: history trimmed ${this.history.length} → ${messages.length} messages`);
    this.history = messages;
    this.lastSent = 0;
  }

  private async execTool(c: ToolCallPart, signal: AbortSignal, maxChars: number): Promise<ToolResultPart> {
    try {
      const r = await this.mcp.callTool(c.name, c.input, signal, c.id);
      const content = convertContent(r.content, maxChars);
      return { type: "tool_result", id: c.id, content, ...(r.isError ? { isError: true } : {}) };
    } catch (e: any) {
      if (signal.aborted) return textResult(c.id, "Interrupted by the user.");
      return textResult(c.id, `Tool call failed: ${e?.message ?? e}`);
    }
  }

  private async *runTurn(turn: BrainTurn, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    const s = this.settings();
    const model = resolveModel(this.variant, this.opts.model, s);
    const key = await readKey(this.ctx, this.variant, s);
    if (key.error) {
      yield { type: "error", message: key.error, fatal: true };
      return;
    }
    yield { type: "model", model };

    let tools: McpTool[];
    try {
      tools = await this.mcp.listTools(signal);
    } catch (e: any) {
      if (signal.aborted) return;
      yield { type: "error", message: this.t("error.mcpUnavailable", { detail: String(e?.message ?? e) }), fatal: true };
      return;
    }
    // Thinking blocks are bound to the system prompt and tool set they were produced under.
    const prefix = prefixHash(this.opts.systemPrompt, tools);
    if (this.prefix !== prefix) {
      if (this.prefix && hasThinking(this.history)) this.history = stripThinking(this.history);
      this.prefix = prefix;
    }

    this.sealDanglingToolCalls();
    this.history.push({ role: "user", parts: this.userParts(turn) });
    this.persist();

    const stream = this.streamFor(s, key.key);
    const budget = this.variant.historyBudget(s);
    let contextRetry = false;
    let thinkingRetry = false;
    let effortRetry = false;

    for (let step = 0; ; step++) {
      if (step >= s.maxSteps) {
        const note = `\n\n${this.t("note.maxSteps", { n: s.maxSteps })}`;
        yield { type: "text", delta: note };
        this.history.push({ role: "assistant", parts: [{ type: "text", text: note.trim() }] });
        return;
      }
      await this.compact(budget, signal);
      if (signal.aborted) return;
      const effort = this.effort();
      const call: ModelCall = { model, system: this.opts.systemPrompt, tools, messages: [...this.history], maxTokens: s.maxTokens, signal, prevMessageCount: this.lastSent, ...(effort ? { effort } : {}) };

      let result: CallResult;
      try {
        result = yield* stream(call);
      } catch (e: any) {
        const err = e instanceof LlmError ? e : new LlmError("http", String(e?.message ?? e));
        if (err.partial?.length) this.history.push({ role: "assistant", parts: err.partial });
        if (err.kind === "context" && !contextRetry && !err.partial?.length) {
          contextRetry = true;
          await this.compact(Math.floor(estimateTokens(this.history) / 2), signal);
          step--;
          continue;
        }
        // A model without reasoning refused the effort parameter: the session goes on without it.
        if (effort && this.variant.protocol === "openai" && err.status === 400 && /reason/i.test(err.message) && !effortRetry && !err.partial?.length) {
          effortRetry = true;
          this.noEffort = true;
          step--;
          continue;
        }
        if (err.kind === "thinking" && !thinkingRetry && !err.partial?.length && hasThinking(this.history)) {
          thinkingRetry = true;
          this.history = stripThinking(this.history);
          step--;
          continue;
        }
        if (err.kind === "limit") yield { type: "limit_hit", resetAt: err.resetAt, detail: err.message };
        else if (err.kind !== "aborted") yield { type: "error", message: this.errorText(err), fatal: true };
        return;
      }
      this.lastSent = call.messages.length;
      if (result.usage.input || result.usage.output) yield { type: "usage", inputTokens: result.usage.input, outputTokens: result.usage.output };

      if (result.stop === "aborted") {
        if (result.parts.length) this.history.push({ role: "assistant", parts: result.parts });
        return;
      }
      if (result.stop === "refusal") {
        // The declined partial is discarded (it may cut a tool call off mid-input).
        yield { type: "error", message: result.stopDetail ? this.t("error.refusalDetail", { detail: result.stopDetail }) : this.t("error.refusal") };
        return;
      }
      if (result.parts.length) this.history.push({ role: "assistant", parts: result.parts });
      const calls = result.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
      if (!calls.length) {
        if (result.stop === "pause") continue;
        if (this.inbox.length && result.stop !== "max_tokens") {
          this.history.push({ role: "user", parts: this.userParts(this.takeInbox()) });
          this.persist();
          continue;
        }
        if (result.stop === "max_tokens") {
          const note = `\n\n${this.t("note.maxTokens")}`;
          yield { type: "text", delta: note };
          this.history.push({ role: "assistant", parts: [{ type: "text", text: note.trim() }] });
        }
        return;
      }

      for (const c of calls) yield { type: "tool_call", id: c.id, name: c.name, input: c.input };
      const results: ToolResultPart[] = [];
      for (const c of calls) {
        let r: ToolResultPart;
        if (signal.aborted) r = textResult(c.id, "Interrupted by the user before execution.");
        else if (result.stop === "max_tokens") {
          r = textResult(c.id, "The tool input was cut off because the response hit max_tokens; the tool was not run. Retry with a shorter input or split the work.");
        } else if (c.invalidJson !== undefined) r = textResult(c.id, JSON.stringify({ INVALID_JSON: c.invalidJson }));
        else r = await this.execTool(c, signal, s.maxToolResultChars);
        results.push(r);
        yield { type: "tool_result", id: c.id, output: truncate(contentText(r.content), EVENT_OUTPUT_MAX), ...(r.isError ? { isError: true } : {}) };
      }
      this.history.push({ role: "user", parts: this.inbox.length ? [...results, ...this.userParts(this.takeInbox())] : results });
      this.persist();
      if (signal.aborted) return;
    }
  }
}
