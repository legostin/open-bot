// OpenAI Responses API adapter (POST /responses) for OpenAI's own models: there function tools and a reasoning effort
// go together (Chat Completions refuses tools with an effort on the newest models). Stateless (`store: false`): the
// whole history goes with every request, and the encrypted reasoning of the turn in progress is passed back with the
// tool results so the model goes on from it.

import { randomBytes } from "node:crypto";
import type { HistoryMessage, ImagePart, Part } from "./history.ts";
import { LlmError, classifyHttpError, networkError, request, trimSlash } from "./http.ts";
import { TOOL_IMAGES_NOTE, toolResultText, type OpenAiConfig } from "./openai.ts";
import { parseSse } from "./sse.ts";
import { parseToolInput, sortedTools, toolSchema, zeroUsage, type ModelCall, type ModelStream, type StopKind, type Usage } from "./provider.ts";

const IDLE_TIMEOUT_MS = 10 * 60_000;

export type ResponsesConfig = Pick<OpenAiConfig, "baseUrl" | "apiKey" | "label" | "vision" | "extraHeaders" | "proxyEnv">;

type Item = Record<string, unknown>;

const inputImage = (p: ImagePart) => ({ type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}`, detail: "auto" });

/** The last user message that is more than tool results: reasoning before it belongs to finished turns (OpenAI drops it). */
function turnStart(history: HistoryMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.parts.some((p) => p.type !== "tool_result")) return i;
  }
  return 0;
}

export function toResponsesInput(history: HistoryMessage[], vision: boolean): Item[] {
  const out: Item[] = [];
  const start = turnStart(history);
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === "assistant") {
      let text = "";
      const flush = () => {
        if (text) out.push({ role: "assistant", content: text });
        text = "";
      };
      for (const p of m.parts) {
        if (p.type === "text") text += p.text;
        else if (p.type === "tool_call") {
          flush();
          out.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) });
        } else if (p.type === "raw" && p.provider === "openai" && i > start) {
          flush();
          out.push({ ...p.block });
        }
      }
      flush();
      continue;
    }
    const images: ImagePart[] = [];
    for (const p of m.parts) {
      if (p.type !== "tool_result") continue;
      out.push({ type: "function_call_output", call_id: p.id, output: toolResultText(p, vision) });
      if (vision) images.push(...p.content.filter((c): c is ImagePart => c.type === "image"));
    }
    const content: Item[] = [];
    if (images.length) {
      content.push({ type: "input_text", text: TOOL_IMAGES_NOTE });
      for (const img of images) content.push(inputImage(img));
    }
    for (const p of m.parts) {
      if (p.type === "text" && p.text) content.push({ type: "input_text", text: p.text });
      else if (p.type === "image") content.push(vision ? inputImage(p) : { type: "input_text", text: "[image omitted: the model has no vision support]" });
    }
    if (!content.length) continue;
    out.push({ role: "user", content: content.every((c) => c.type === "input_text") ? content.map((c) => c.text).join("\n\n") : content });
  }
  return out;
}

export function buildResponsesRequest(call: ModelCall, cfg: ResponsesConfig): { body: Record<string, unknown>; headers: Record<string, string> } {
  const body: Record<string, unknown> = {
    model: call.model,
    ...(call.system ? { instructions: call.system } : {}),
    input: toResponsesInput(call.messages, cfg.vision),
    max_output_tokens: call.maxTokens,
    store: false,
    stream: true,
  };
  if (call.effort) {
    body.reasoning = { effort: call.effort };
    // Nothing is kept on OpenAI's side: the reasoning comes back encrypted, to be passed on with the tool results.
    body.include = ["reasoning.encrypted_content"];
  }
  const tools = sortedTools(call.tools);
  if (tools.length) {
    // Strict schemas would need every property required and no others allowed: MCP tools are not written so.
    body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: toolSchema(t), strict: false }));
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...(cfg.extraHeaders ?? {}) };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { body, headers };
}

/** One output item as it streams in (by output_index). */
interface ItemState {
  type: string;
  text: string;
  callId: string;
  name: string;
  args: string;
  /** A reasoning item to pass back (only when it came with its encrypted content). */
  reasoning?: Record<string, unknown>;
}

function messageText(item: any): string {
  const content: any[] = Array.isArray(item?.content) ? item.content : [];
  return content.map((c) => (typeof c?.text === "string" ? c.text : typeof c?.refusal === "string" ? c.refusal : "")).join("");
}

/** A failed response or an `error` event as an LlmError (limits, context overflow and the rest, as for HTTP errors). */
function streamError(e: any, label: string): LlmError {
  const code = String(e?.code ?? e?.type ?? "");
  const status = /context|invalid/i.test(code) ? 400 : 500;
  return classifyHttpError(status, {}, JSON.stringify({ error: { type: code, message: String(e?.message ?? "the response failed") } }), label);
}

export async function* responsesStream(cfg: ResponsesConfig, call: ModelCall): ModelStream {
  const { body, headers } = buildResponsesRequest(call, cfg);
  const url = `${trimSlash(cfg.baseUrl)}/responses`;
  const usage: Usage = zeroUsage();
  let res;
  try {
    res = await request(url, { method: "POST", headers, body: JSON.stringify(body), signal: call.signal, proxyEnv: cfg.proxyEnv, idleTimeoutMs: IDLE_TIMEOUT_MS });
  } catch (e) {
    if (call.signal.aborted) return { parts: [], stop: "aborted", usage };
    throw networkError(e, url);
  }
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => "");
    throw classifyHttpError(res.status, res.headers, text, cfg.label);
  }

  const items: ItemState[] = [];
  let text = "";
  let status: string | undefined;
  let incomplete: string | undefined;
  let model: string | undefined;
  const partial = (): Part[] => (text ? [{ type: "text", text }] : []);
  const slot = (i: unknown) => (items[typeof i === "number" ? i : items.length] ??= { type: "", text: "", callId: "", name: "", args: "" });

  try {
    for await (const ev of parseSse(res.body)) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = String(d?.type ?? ev.event);
      if (type === "error") throw streamError(d?.error ?? d, cfg.label);
      if (type === "response.failed") throw streamError(d?.response?.error, cfg.label);
      if (d?.response?.model) model = d.response.model;

      if (type === "response.output_text.delta" || type === "response.refusal.delta") {
        if (typeof d.delta !== "string" || !d.delta) continue;
        const s = slot(d.output_index);
        s.type ||= "message";
        s.text += d.delta;
        text += d.delta;
        yield { type: "text", delta: d.delta };
      } else if (type === "response.function_call_arguments.delta") {
        if (typeof d.delta === "string") slot(d.output_index).args += d.delta;
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        const it = d.item ?? {};
        const s = slot(d.output_index);
        s.type = String(it.type ?? s.type);
        const done = type === "response.output_item.done";
        if (it.type === "function_call") {
          if (it.call_id) s.callId = it.call_id;
          if (it.name) s.name = it.name;
          if (done && typeof it.arguments === "string") s.args = it.arguments;
        } else if (it.type === "message" && done) {
          // The finished message is the authority: text that never came as deltas is streamed now.
          const full = messageText(it);
          if (full.length > s.text.length && full.startsWith(s.text)) {
            const rest = full.slice(s.text.length);
            s.text = full;
            text += rest;
            yield { type: "text", delta: rest };
          }
        } else if (it.type === "reasoning" && done && typeof it.encrypted_content === "string") {
          s.reasoning = { type: "reasoning", summary: Array.isArray(it.summary) ? it.summary : [], encrypted_content: it.encrypted_content };
        }
      } else if (type === "response.completed" || type === "response.incomplete") {
        const r = d.response ?? {};
        status = type === "response.completed" ? "completed" : "incomplete";
        incomplete = r.incomplete_details?.reason;
        if (r.usage) {
          usage.input = Number(r.usage.input_tokens ?? 0);
          usage.output = Number(r.usage.output_tokens ?? 0);
          const cached = r.usage.input_tokens_details?.cached_tokens;
          if (cached !== undefined) usage.cacheRead = Number(cached);
        }
      }
    }
  } catch (e) {
    if (call.signal.aborted) return { parts: partial(), stop: "aborted", usage, model };
    const detail = String((e as Error)?.message ?? e);
    const err =
      e instanceof LlmError
        ? e
        : new LlmError("network", `The ${cfg.label} response stream broke off: ${detail}`, { key: "error.streamBroken", params: { provider: cfg.label, detail } });
    err.partial = partial();
    throw err;
  }
  if (call.signal.aborted) return { parts: partial(), stop: "aborted", usage, model };
  if (!status) {
    const err = new LlmError("network", `The ${cfg.label} response stream ended before the message was complete`, {
      key: "error.streamEnded",
      params: { provider: cfg.label },
    });
    err.partial = partial();
    throw err;
  }

  const parts: Part[] = [];
  for (const s of items) {
    if (!s) continue;
    if (s.type === "reasoning" && s.reasoning) parts.push({ type: "raw", provider: "openai", block: s.reasoning });
    else if (s.type === "message" && s.text) parts.push({ type: "text", text: s.text });
    else if (s.type === "function_call" && s.name) {
      const { input, invalid } = parseToolInput(s.args);
      parts.push({ type: "tool_call", id: s.callId || `call_${randomBytes(6).toString("hex")}`, name: s.name, input, ...(invalid !== undefined ? { invalidJson: invalid } : {}) });
    }
  }
  const hasCalls = parts.some((p) => p.type === "tool_call");
  let stop: StopKind = hasCalls ? "tool_use" : "end";
  if (status === "incomplete") stop = incomplete === "content_filter" ? "refusal" : "max_tokens";
  return { parts, stop, stopDetail: stop === "refusal" ? "content_filter" : undefined, usage, model };
}
