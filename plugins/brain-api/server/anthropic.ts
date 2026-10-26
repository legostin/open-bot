// Anthropic Messages API adapter: raw HTTP + SSE streaming, tool_use / tool_result blocks, prompt caching,
// thinking blocks kept verbatim for replay, server-side refusal fallback.

import type { HistoryMessage, Part, RawPart } from "./history.ts";
import { LlmError, classifyHttpError, isAbortError, networkError, request, trimSlash } from "./http.ts";
import { parseSse } from "./sse.ts";
import { parseToolInput, sortedTools, toolSchema, zeroUsage, type CallResult, type ModelCall, type ModelStream, type StopKind, type Usage } from "./provider.ts";

export const ANTHROPIC_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models that accept `fallbacks: "default"` (Claude Haiku 5.5 has no server-side fallback). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const IDLE_TIMEOUT_MS = 10 * 60_000;

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  /** "" = model default. */
  effort: string;
  refusalFallback: boolean;
  eagerTools: boolean;
  proxyEnv?: Record<string, string>;
}

type Block = Record<string, unknown>;
const CACHEABLE = new Set(["text", "image", "tool_use", "tool_result", "document"]);

function userBlocks(m: HistoryMessage): Block[] {
  const out: Block[] = [];
  // tool_result blocks must come first in a user message.
  const ordered = [...m.parts.filter((p) => p.type === "tool_result"), ...m.parts.filter((p) => p.type !== "tool_result")];
  for (const p of ordered) {
    if (p.type === "text") {
      if (p.text) out.push({ type: "text", text: p.text });
    } else if (p.type === "image") {
      out.push({ type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } });
    } else if (p.type === "tool_result") {
      const content: Block[] = [];
      for (const c of p.content) {
        if (c.type === "text") {
          if (c.text) content.push({ type: "text", text: c.text });
        } else content.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } });
      }
      out.push({
        type: "tool_result",
        tool_use_id: p.id,
        content: content.length ? content : [{ type: "text", text: "(empty result)" }],
        ...(p.isError ? { is_error: true } : {}),
      });
    }
  }
  return out;
}

function assistantBlocks(m: HistoryMessage): Block[] {
  const out: Block[] = [];
  for (const p of m.parts) {
    if (p.type === "text") {
      if (p.text) out.push({ type: "text", text: p.text });
    } else if (p.type === "tool_call") {
      out.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
    } else if (p.type === "raw") {
      out.push({ ...p.block });
    }
  }
  return out;
}

function markCache(content: Block[]): boolean {
  for (let i = content.length - 1; i >= 0; i--) {
    if (CACHEABLE.has(String(content[i].type))) {
      content[i] = { ...content[i], cache_control: { type: "ephemeral" } };
      return true;
    }
  }
  return false;
}

export function buildAnthropicRequest(call: ModelCall, cfg: AnthropicConfig): { body: Record<string, unknown>; headers: Record<string, string> } {
  const tools = sortedTools(call.tools).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: toolSchema(t),
    ...(cfg.eagerTools ? { eager_input_streaming: true } : {}),
  })) as Block[];

  const aligned = call.messages.map((m) => ({ role: m.role, content: m.role === "user" ? userBlocks(m) : assistantBlocks(m) }));
  // Cache breakpoints: end of the conversation, plus where the previous request ended (cache read point).
  const last = aligned.length - 1;
  if (last >= 0) markCache(aligned[last].content);
  const prev = (call.prevMessageCount ?? 0) - 1;
  if (prev >= 0 && prev < last) markCache(aligned[prev].content);
  // Merge consecutive same-role messages (e.g. a new user turn after a refused or limited one).
  const messages: Array<{ role: string; content: Block[] }> = [];
  for (const m of aligned) {
    if (!m.content.length) continue;
    const tail = messages[messages.length - 1];
    if (tail && tail.role === m.role) tail.content = [...tail.content, ...m.content];
    else messages.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = { model: call.model, max_tokens: call.maxTokens, stream: true };
  if (call.system) body.system = [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }];
  else if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  if (tools.length) body.tools = tools;
  body.messages = messages;
  if (cfg.effort) body.output_config = { effort: cfg.effort };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-api-key": cfg.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (cfg.refusalFallback && FALLBACK_MODELS.has(call.model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = FALLBACK_BETA;
  }
  return { body, headers };
}

interface BlockState {
  base: Block;
  text: string;
  json: string;
  thinking: string;
  signature: string;
}

function finalizeBlock(b: BlockState): Part | undefined {
  const type = String(b.base.type);
  if (type === "text") {
    const text = String(b.base.text ?? "") + b.text;
    return text ? { type: "text", text } : undefined;
  }
  if (type === "tool_use") {
    const { input, invalid } = parseToolInput(b.json, b.base.input);
    return { type: "tool_call", id: String(b.base.id), name: String(b.base.name), input, ...(invalid !== undefined ? { invalidJson: invalid } : {}) };
  }
  if (type === "thinking") {
    return raw({ type: "thinking", thinking: String(b.base.thinking ?? "") + b.thinking, signature: b.signature || String(b.base.signature ?? "") });
  }
  const block: Block = { ...b.base };
  if (b.json) {
    try {
      block.input = JSON.parse(b.json);
    } catch {
      /* keep start input */
    }
  }
  return raw(block);
}

function raw(block: Block): RawPart {
  return { type: "raw", provider: "anthropic", block };
}

/**
 * After a mid-output server-side fallback, the declined partial before the last `fallback` block is echoed
 * with its text only (thinking, tool_use and other model-internal blocks are dropped); the marker is dropped too.
 */
export function applyFallbackBoundary(parts: Part[]): Part[] {
  let boundary = -1;
  parts.forEach((p, i) => {
    if (p.type === "raw" && p.block.type === "fallback") boundary = i;
  });
  if (boundary === -1) return parts;
  return [...parts.slice(0, boundary).filter((p) => p.type === "text"), ...parts.slice(boundary + 1)];
}

function textSoFar(blocks: Array<BlockState | undefined>): Part[] {
  const out: Part[] = [];
  for (const b of blocks) {
    if (b && b.base.type === "text") {
      const text = String(b.base.text ?? "") + b.text;
      if (text) out.push({ type: "text", text });
    }
  }
  return out;
}

function stopKind(reason: string | undefined): StopKind {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return "end";
  }
}

const STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
  request_too_large: 413,
  not_found_error: 404,
};

export async function* anthropicStream(cfg: AnthropicConfig, call: ModelCall): ModelStream {
  const { body, headers } = buildAnthropicRequest(call, cfg);
  const url = `${trimSlash(cfg.baseUrl)}/v1/messages`;
  const usage: Usage = zeroUsage();
  let res;
  try {
    res = await request(url, { method: "POST", headers, body: JSON.stringify(body), signal: call.signal, proxyEnv: cfg.proxyEnv, idleTimeoutMs: IDLE_TIMEOUT_MS });
  } catch (e) {
    if (call.signal.aborted || isAbortError(e)) return { parts: [], stop: "aborted", usage };
    throw networkError(e, url);
  }
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => "");
    throw classifyHttpError(res.status, res.headers, text, "Anthropic");
  }

  const blocks: Array<BlockState | undefined> = [];
  let stopReason: string | undefined;
  let stopDetail: string | undefined;
  let model: string | undefined;
  let finished = false;
  const setUsage = (u: any) => {
    if (!u || typeof u !== "object") return;
    const cacheRead = Number(u.cache_read_input_tokens ?? usage.cacheRead ?? 0);
    const cacheWrite = Number(u.cache_creation_input_tokens ?? usage.cacheWrite ?? 0);
    if (u.input_tokens !== undefined && u.input_tokens !== null) usage.input = Number(u.input_tokens) + cacheRead + cacheWrite;
    usage.cacheRead = cacheRead;
    usage.cacheWrite = cacheWrite;
    if (u.output_tokens !== undefined && u.output_tokens !== null) usage.output = Number(u.output_tokens);
  };

  try {
    for await (const ev of parseSse(res.body)) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (d?.type ?? ev.event) {
        case "message_start":
          model = d.message?.model;
          setUsage(d.message?.usage);
          break;
        case "content_block_start":
          blocks[d.index] = { base: { ...(d.content_block ?? {}) }, text: "", json: "", thinking: "", signature: "" };
          break;
        case "content_block_delta": {
          const b = blocks[d.index];
          const delta = d.delta ?? {};
          if (!b) break;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            b.text += delta.text;
            if (delta.text) yield { type: "text", delta: delta.text };
          } else if (delta.type === "input_json_delta") b.json += delta.partial_json ?? "";
          else if (delta.type === "thinking_delta") b.thinking += delta.thinking ?? "";
          else if (delta.type === "signature_delta") b.signature = delta.signature ?? b.signature;
          break;
        }
        case "message_delta":
          stopReason = d.delta?.stop_reason ?? stopReason;
          if (d.delta?.stop_details) stopDetail = String(d.delta.stop_details.category ?? d.delta.stop_details.explanation ?? "");
          setUsage(d.usage);
          break;
        case "message_stop":
          finished = true;
          break;
        case "error": {
          const type = String(d.error?.type ?? "api_error");
          throw classifyHttpError(STREAM_ERROR_STATUS[type] ?? 500, {}, JSON.stringify(d), "Anthropic");
        }
        default:
          break; // ping and future event types
      }
      if (finished) break;
    }
  } catch (e) {
    if (call.signal.aborted) return { parts: textSoFar(blocks), stop: "aborted", usage, model };
    const err = e instanceof LlmError ? e : new LlmError("network", `Поток ответа Anthropic прервался: ${(e as Error)?.message ?? e}`);
    err.partial = textSoFar(blocks);
    throw err;
  }
  if (call.signal.aborted) return { parts: textSoFar(blocks), stop: "aborted", usage, model };
  if (!stopReason) {
    const err = new LlmError("network", "Поток ответа Anthropic оборвался до конца сообщения");
    err.partial = textSoFar(blocks);
    throw err;
  }
  const parts = applyFallbackBoundary(blocks.map((b) => (b ? finalizeBlock(b) : undefined)).filter((p): p is Part => !!p));
  const result: CallResult = { parts, stop: stopKind(stopReason), stopDetail, usage, model };
  return result;
}
