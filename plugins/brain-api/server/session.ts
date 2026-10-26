// One brain session: the agent loop over the hub's MCP tools, history persistence and resume.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import type { BrainEvent, BrainSessionOptions, BrainTurn } from "@openbot/shared";
import type { BrainSessionImpl, PluginContext } from "@openbot/plugin-sdk";
import { anthropicStream } from "./anthropic.ts";
import {
  contentText,
  estimateTokens,
  hasThinking,
  saveSession,
  stripThinking,
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
import { sortedTools, type CallResult, type ModelCall, type ModelStream } from "./provider.ts";
import { resolveModel, vaultId, type ApiSettings, type VariantInfo } from "./settings.ts";

/** Tool output shown in the UI (the model gets the full content). */
const EVENT_OUTPUT_MAX = 8000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export async function readKey(ctx: PluginContext, v: VariantInfo, s: ApiSettings): Promise<{ key?: string; error?: string }> {
  const ref = v.keyRef(s);
  if (!ref) return {};
  const id = vaultId(ref);
  try {
    const fields = await ctx.vault.get(`vault://${id}`, { reason: `API-мозг (${v.label})` });
    const value = fields?.value ?? Object.values(fields ?? {}).find((x) => typeof x === "string" && x.trim());
    if (typeof value === "string" && value.trim()) return { key: value.trim() };
    return { error: `Добавьте ключ ${id} в vault` };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/Нет записи|not.?found/i.test(msg)) return { error: `Добавьте ключ ${id} в vault` };
    return { error: `Добавьте ключ ${id} в vault или откройте к нему доступ: ${msg}` };
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
  /** Messages in the previous model request (cache read point). */
  private lastSent = 0;

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
    if (this.closed) {
      yield { type: "error", message: "Сессия API-мозга закрыта", fatal: true };
      yield { type: "done", resumeToken: this.sessionId };
      return;
    }
    if (this.running) {
      yield { type: "error", message: "Сессия уже выполняет ход" };
      yield { type: "done", resumeToken: this.sessionId };
      return;
    }
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    try {
      yield* this.runTurn(turn, ac.signal);
    } catch (e: any) {
      yield { type: "error", message: `Внутренняя ошибка API-мозга: ${e?.message ?? e}`, fatal: true };
    } finally {
      this.running = false;
      this.abort = undefined;
      this.persist();
    }
    yield { type: "done", resumeToken: this.sessionId };
  }

  interrupt(): void {
    this.abort?.abort();
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.persist();
  }

  // ---------- internals ----------

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
      this.ctx.log.warn(`не удалось сохранить историю сессии ${this.sessionId}: ${e?.message ?? e}`);
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
      label: v.label,
      vision: v.vision(s),
      maxTokensField: v.id === "openai" ? ("max_completion_tokens" as const) : ("max_tokens" as const),
      extraHeaders: v.id === "openrouter" ? { "X-Title": "open-bot" } : undefined,
      proxyEnv,
    };
    return (call) => openAiStream(cfg, call);
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
    this.ctx.log.info(`сессия ${this.sessionId}: история сокращена ${this.history.length} → ${messages.length} сообщений`);
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

    let tools: McpTool[];
    try {
      tools = await this.mcp.listTools(signal);
    } catch (e: any) {
      if (signal.aborted) return;
      yield { type: "error", message: `MCP-шлюз хаба недоступен: ${e?.message ?? e}`, fatal: true };
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

    for (let step = 0; ; step++) {
      if (step >= s.maxSteps) {
        const note = `\n\n(Ход остановлен: достигнут предел в ${s.maxSteps} шагов.)`;
        yield { type: "text", delta: note };
        this.history.push({ role: "assistant", parts: [{ type: "text", text: note.trim() }] });
        return;
      }
      this.trim(budget);
      const call: ModelCall = { model, system: this.opts.systemPrompt, tools, messages: [...this.history], maxTokens: s.maxTokens, signal, prevMessageCount: this.lastSent };

      let result: CallResult;
      try {
        result = yield* stream(call);
      } catch (e: any) {
        const err = e instanceof LlmError ? e : new LlmError("http", String(e?.message ?? e));
        if (err.partial?.length) this.history.push({ role: "assistant", parts: err.partial });
        if (err.kind === "context" && !contextRetry && !err.partial?.length) {
          contextRetry = true;
          this.trim(Math.floor(estimateTokens(this.history) / 2));
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
        else if (err.kind !== "aborted") yield { type: "error", message: err.message, fatal: true };
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
        yield { type: "error", message: `Модель отказалась отвечать${result.stopDetail ? ` (${result.stopDetail})` : ""}.` };
        return;
      }
      if (result.parts.length) this.history.push({ role: "assistant", parts: result.parts });
      const calls = result.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
      if (!calls.length) {
        if (result.stop === "pause") continue;
        if (result.stop === "max_tokens") {
          const note = "\n\n(Ответ обрезан: достигнут лимит max_tokens.)";
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
      this.history.push({ role: "user", parts: results });
      this.persist();
      if (signal.aborted) return;
    }
  }
}
