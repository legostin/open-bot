// OpenAI Chat Completions adapter (OpenRouter, the OpenAI-compatible providers and servers: Ollama, LM Studio, vLLM).
// OpenAI itself goes through the Responses API (responses.ts).

import { randomBytes } from "node:crypto";
import type { HistoryMessage, ImagePart, Part, ToolResultPart } from "./history.ts";
import { LlmError, classifyHttpError, networkError, request, trimSlash } from "./http.ts";
import { parseSse } from "./sse.ts";
import { parseToolInput, sortedTools, toolSchema, zeroUsage, type ModelCall, type ModelStream, type StopKind, type Usage } from "./provider.ts";

const IDLE_TIMEOUT_MS = 10 * 60_000;

export interface OpenAiConfig {
  baseUrl: string;
  apiKey?: string;
  /** Provider name for error messages. */
  label: string;
  /** Send images to the model (otherwise placeholders). */
  vision: boolean;
  /** "max_completion_tokens" (OpenAI) or "max_tokens" (most compatible servers). */
  maxTokensField: "max_completion_tokens" | "max_tokens";
  extraHeaders?: Record<string, string>;
  proxyEnv?: Record<string, string>;
  /** How the provider takes a reasoning effort: OpenAI's `reasoning_effort`, OpenRouter's `reasoning: {effort}`. */
  effortField?: "reasoning_effort" | "reasoning";
}

type Msg = Record<string, unknown>;

const dataUrl = (p: ImagePart) => ({ type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } });

/** Model-facing line before the images that tool results returned (sent as a user message after the results). */
export const TOOL_IMAGES_NOTE = "Images returned by the tool calls above:";

/** A tool result as text for the model; its images follow in a user message (or are left out without vision). */
export function toolResultText(p: ToolResultPart, vision: boolean): string {
  const text =
    p.content.map((c) => (c.type === "text" ? c.text : vision ? "[image: see the next message]" : "[image omitted: the model has no vision support]")).join("\n") ||
    "(empty result)";
  return p.isError ? `Error: ${text}` : text;
}

function userContent(items: Array<Record<string, unknown>>): unknown {
  return items.every((i) => i.type === "text") ? items.map((i) => i.text).join("\n\n") : items;
}

export function toOpenAiMessages(system: string, history: HistoryMessage[], vision: boolean): Msg[] {
  const out: Msg[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of history) {
    if (m.role === "assistant") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      const calls = m.parts.filter((p) => p.type === "tool_call");
      if (!text && !calls.length) continue;
      const msg: Msg = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
      }
      out.push(msg);
      continue;
    }
    const images: ImagePart[] = [];
    for (const p of m.parts) {
      if (p.type !== "tool_result") continue;
      out.push({ role: "tool", tool_call_id: p.id, content: toolResultText(p, vision) });
      if (vision) images.push(...p.content.filter((c): c is ImagePart => c.type === "image"));
    }
    const items: Array<Record<string, unknown>> = [];
    if (images.length) {
      items.push({ type: "text", text: TOOL_IMAGES_NOTE });
      for (const img of images) items.push(dataUrl(img));
    }
    for (const p of m.parts) {
      if (p.type === "text" && p.text) items.push({ type: "text", text: p.text });
      else if (p.type === "image") items.push(vision ? dataUrl(p) : { type: "text", text: "[image omitted: the model has no vision support]" });
    }
    if (items.length) out.push({ role: "user", content: userContent(items) });
  }
  return out;
}

export function buildOpenAiRequest(call: ModelCall, cfg: OpenAiConfig): { body: Record<string, unknown>; headers: Record<string, string> } {
  const body: Record<string, unknown> = {
    model: call.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(call.system, call.messages, cfg.vision),
    [cfg.maxTokensField]: call.maxTokens,
  };
  if (call.effort && cfg.effortField === "reasoning_effort") body.reasoning_effort = call.effort;
  if (call.effort && cfg.effortField === "reasoning") body.reasoning = { effort: call.effort };
  const tools = sortedTools(call.tools);
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: toolSchema(t) } }));
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...(cfg.extraHeaders ?? {}) };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { body, headers };
}

interface CallSlot {
  id: string;
  name: string;
  args: string;
}

function stopKind(finish: string | undefined, hasCalls: boolean): StopKind {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (hasCalls) return "tool_use";
  return "end";
}

export async function* openAiStream(cfg: OpenAiConfig, call: ModelCall): ModelStream {
  const { body, headers } = buildOpenAiRequest(call, cfg);
  const url = `${trimSlash(cfg.baseUrl)}/chat/completions`;
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

  let text = "";
  const slots: CallSlot[] = [];
  let finish: string | undefined;
  let model: string | undefined;
  let done = false;
  const partial = (): Part[] => (text ? [{ type: "text", text }] : []);

  try {
    for await (const ev of parseSse(res.body)) {
      if (ev.data.trim() === "[DONE]") {
        done = true;
        break;
      }
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (d?.error) {
        const code = Number(d.error.code);
        throw classifyHttpError(Number.isFinite(code) && code >= 400 ? code : 500, {}, JSON.stringify(d), cfg.label);
      }
      if (d?.model) model = d.model;
      if (d?.usage) {
        usage.input = Number(d.usage.prompt_tokens ?? 0);
        usage.output = Number(d.usage.completion_tokens ?? 0);
        const cached = d.usage.prompt_tokens_details?.cached_tokens;
        if (cached !== undefined) usage.cacheRead = Number(cached);
      }
      const ch = d?.choices?.[0];
      if (!ch) continue;
      const delta = ch.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text", delta: delta.content };
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = typeof tc.index === "number" ? tc.index : slots.length;
        const slot = (slots[idx] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        const name = tc.function?.name;
        if (name && !slot.name) slot.name = name;
        else if (name && slot.name !== name) slot.name += name;
        const args = tc.function?.arguments;
        if (typeof args === "string") slot.args += args;
        else if (args && typeof args === "object") slot.args += JSON.stringify(args);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
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
  if (!done && !finish) {
    const err = new LlmError("network", `The ${cfg.label} response stream ended before the message was complete`, {
      key: "error.streamEnded",
      params: { provider: cfg.label },
    });
    err.partial = partial();
    throw err;
  }

  const parts: Part[] = partial();
  for (const s of slots) {
    if (!s || !s.name) continue;
    const { input, invalid } = parseToolInput(s.args);
    parts.push({ type: "tool_call", id: s.id || `call_${randomBytes(6).toString("hex")}`, name: s.name, input, ...(invalid !== undefined ? { invalidJson: invalid } : {}) });
  }
  const hasCalls = parts.some((p) => p.type === "tool_call");
  return { parts, stop: stopKind(finish, hasCalls), stopDetail: finish === "content_filter" ? "content_filter" : undefined, usage, model };
}
