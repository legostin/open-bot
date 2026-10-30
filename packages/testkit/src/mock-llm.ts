// Mock LLM server for tests: speaks the Anthropic Messages API (POST /v1/messages), the OpenAI
// Chat Completions API (POST /v1/chat/completions) and the OpenAI Responses API (POST /v1/responses),
// streaming (SSE) and non-streaming, with the real event shapes. Responses are scripted turn by turn;
// every request is recorded.
//
//   const llm = await startMockLlm();
//   llm.script([{ toolCalls: [{ name: "echo", input: { text: "hi" } }] }, { text: "Done" }]);
//   // point the client at llm.url (Anthropic base URL) or `${llm.url}/v1` (OpenAI base URL)

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface MockToolCall {
  name: string;
  input: unknown;
}

export interface MockTurn {
  /** Assistant text (streamed in word-sized chunks). */
  text?: string;
  /** Tool calls after the text. */
  toolCalls?: MockToolCall[];
  /** HTTP status; non-2xx returns a provider-shaped error body instead of a message. */
  status?: number;
  /** Extra response headers (e.g. retry-after, anthropic-ratelimit-*-reset). */
  headers?: Record<string, string>;
  /** Error message for non-2xx responses. */
  error?: string;
  /**
   * Reasoning before the text: an Anthropic thinking block (with a fake signature) or an OpenAI Responses reasoning
   * item (with fake encrypted content when the request includes "reasoning.encrypted_content").
   */
  thinking?: string;
  /** Override the stop reason (Anthropic `stop_reason`, OpenAI `finish_reason`, Responses `incomplete_details.reason`). */
  stopReason?: string;
  /** Delay between streamed chunks, ms (for interrupt tests). */
  chunkDelayMs?: number;
  /** Override reported usage. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface MockLlmRequest {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

export interface MockLlm {
  /** Base URL without a trailing slash, e.g. http://127.0.0.1:12345. */
  url: string;
  /** Append turns to the queue; each POST consumes one. */
  script(turns: MockTurn[]): void;
  /** Every request received, in order. */
  requests: MockLlmRequest[];
  /** Number of scripted turns not consumed yet. */
  pending(): number;
  /** Clear the queue and the recorded requests; ids restart from 1. */
  reset(): void;
  close(): Promise<void>;
}

export interface MockLlmOptions {
  /** Used when the queue is empty. Without it an empty queue answers 500. */
  defaultTurn?: MockTurn;
  port?: number;
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "gpt-mock"];

export async function startMockLlm(opts: MockLlmOptions = {}): Promise<MockLlm> {
  const queue: MockTurn[] = [];
  const requests: MockLlmRequest[] = [];
  const sockets = new Set<Socket>();
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const path = (req.url ?? "/").split("?")[0];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    requests.push({ method: req.method ?? "GET", path, body, headers });

    try {
      if (req.method === "GET" && path.endsWith("/models")) {
        const data = MODELS.map((id) => ({ id, object: "model", type: "model", display_name: id, created: 0, owned_by: "mock" }));
        return json(res, 200, { object: "list", data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
      }
      const anthropic = req.method === "POST" && /\/messages$/.test(path);
      const openai = req.method === "POST" && /\/chat\/completions$/.test(path);
      const responses = req.method === "POST" && /\/responses$/.test(path);
      if (!anthropic && !openai && !responses) return json(res, 404, { error: { message: `mock-llm: no route ${req.method} ${path}` } });

      const turn = queue.shift() ?? opts.defaultTurn;
      if (!turn) {
        return anthropic
          ? json(res, 500, { type: "error", error: { type: "api_error", message: "mock-llm: no scripted turn left" } })
          : json(res, 500, { error: { message: "mock-llm: no scripted turn left", type: "server_error", code: null } });
      }
      const status = turn.status ?? 200;
      if (status < 200 || status >= 300) {
        const message = turn.error ?? `mock error ${status}`;
        const body = anthropic
          ? { type: "error", error: { type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error", message } }
          : { error: { message, type: status === 429 ? "rate_limit_exceeded" : status === 401 ? "invalid_request_error" : "server_error", code: status === 401 ? "invalid_api_key" : null } };
        return json(res, status, body, turn.headers);
      }
      const n = ++seq;
      const inputTokens = turn.usage?.inputTokens ?? Math.max(1, Math.ceil(raw.length / 4));
      if (anthropic) await anthropicResponse(res, body ?? {}, turn, n, inputTokens);
      else if (responses) await responsesResponse(res, body ?? {}, turn, n, inputTokens);
      else await openaiResponse(res, body ?? {}, turn, n, inputTokens);
    } catch (e: any) {
      if (!res.headersSent) json(res, 500, { error: { message: `mock-llm: ${e?.message ?? e}` } });
      else res.destroy();
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    script(turns) {
      queue.push(...turns);
    },
    requests,
    pending: () => queue.length,
    reset() {
      queue.length = 0;
      requests.length = 0;
      seq = 0;
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}

// ---------- helpers ----------

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Word-sized chunks so streams carry several deltas. */
function textChunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/** A JSON document split into a few pieces, like input_json_delta / tool-call argument streaming. */
function jsonChunks(value: unknown): string[] {
  const s = JSON.stringify(value ?? {});
  if (s.length < 4) return [s];
  const a = Math.floor(s.length / 3);
  const b = Math.floor((2 * s.length) / 3);
  return [s.slice(0, a), s.slice(a, b), s.slice(b)];
}

function tokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SseWriter {
  res: http.ServerResponse;
  delay: number;
  constructor(res: http.ServerResponse, delay: number) {
    this.res = res;
    this.delay = delay;
  }
  get closed(): boolean {
    return this.res.destroyed || this.res.writableEnded;
  }
  async write(chunk: string): Promise<void> {
    if (this.closed) return;
    this.res.write(chunk);
    if (this.delay > 0) await sleep(this.delay);
  }
  event(name: string, data: unknown): Promise<void> {
    return this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  data(data: unknown): Promise<void> {
    return this.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  }
}

function sseHead(res: http.ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", ...headers });
  res.flushHeaders();
}

// ---------- Anthropic Messages API ----------

async function anthropicResponse(res: http.ServerResponse, body: any, turn: MockTurn, n: number, inputTokens: number): Promise<void> {
  const model = String(body.model ?? "claude-mock");
  const toolCalls = turn.toolCalls ?? [];
  const stopReason = turn.stopReason ?? (toolCalls.length ? "tool_use" : "end_turn");
  const outputTokens = turn.usage?.outputTokens ?? tokens((turn.thinking ?? "") + (turn.text ?? "") + JSON.stringify(toolCalls));
  const blocks: any[] = [];
  if (turn.thinking !== undefined) blocks.push({ type: "thinking", thinking: turn.thinking, signature: `sig_mock_${n}` });
  if (turn.text) blocks.push({ type: "text", text: turn.text });
  toolCalls.forEach((c, i) => blocks.push({ type: "tool_use", id: `toolu_mock_${n}_${i}`, name: c.name, input: c.input ?? {} }));
  const id = `msg_mock_${n}`;

  if (!body.stream) {
    json(
      res,
      200,
      {
        id,
        type: "message",
        role: "assistant",
        model,
        content: blocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      turn.headers,
    );
    return;
  }

  sseHead(res, turn.headers);
  const w = new SseWriter(res, turn.chunkDelayMs ?? 0);
  await w.event("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  await w.event("ping", { type: "ping" });
  for (let index = 0; index < blocks.length; index++) {
    const b = blocks[index];
    if (b.type === "thinking") {
      await w.event("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const t of textChunks(b.thinking)) await w.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: t } });
      await w.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "text") {
      await w.event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const t of textChunks(b.text)) await w.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
    } else {
      await w.event("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (const p of jsonChunks(b.input)) await w.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } });
    }
    await w.event("content_block_stop", { type: "content_block_stop", index });
  }
  await w.event("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
  await w.event("message_stop", { type: "message_stop" });
  if (!w.closed) res.end();
}

// ---------- OpenAI Chat Completions ----------

async function openaiResponse(res: http.ServerResponse, body: any, turn: MockTurn, n: number, inputTokens: number): Promise<void> {
  const model = String(body.model ?? "gpt-mock");
  const toolCalls = (turn.toolCalls ?? []).map((c, i) => ({ id: `call_mock_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
  const finish = turn.stopReason ?? (toolCalls.length ? "tool_calls" : "stop");
  const outputTokens = turn.usage?.outputTokens ?? tokens((turn.text ?? "") + JSON.stringify(toolCalls));
  const usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
  const id = `chatcmpl-mock-${n}`;
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    json(
      res,
      200,
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: turn.text ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
        usage,
      },
      turn.headers,
    );
    return;
  }

  sseHead(res, turn.headers);
  const w = new SseWriter(res, turn.chunkDelayMs ?? 0);
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] });
  await w.data(chunk({ role: "assistant", content: "" }));
  for (const t of textChunks(turn.text ?? "")) await w.data(chunk({ content: t }));
  for (let i = 0; i < toolCalls.length; i++) {
    const c = toolCalls[i];
    await w.data(chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] }));
    for (const p of jsonChunks(JSON.parse(c.function.arguments))) await w.data(chunk({ tool_calls: [{ index: i, function: { arguments: p } }] }));
  }
  await w.data(chunk({}, finish));
  if (body.stream_options?.include_usage) await w.data({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
  await w.data("[DONE]");
  if (!w.closed) res.end();
}

// ---------- OpenAI Responses ----------

async function responsesResponse(res: http.ServerResponse, body: any, turn: MockTurn, n: number, inputTokens: number): Promise<void> {
  const model = String(body.model ?? "gpt-mock");
  const encrypted = Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content");
  const output: any[] = [];
  if (turn.thinking !== undefined) output.push({ id: `rs_mock_${n}`, type: "reasoning", summary: [], ...(encrypted ? { encrypted_content: `enc_mock_${n}` } : {}) });
  if (turn.text) output.push({ id: `msg_mock_${n}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: turn.text, annotations: [] }] });
  (turn.toolCalls ?? []).forEach((c, i) =>
    output.push({ id: `fc_mock_${n}_${i}`, type: "function_call", status: "completed", call_id: `call_mock_${n}_${i}`, name: c.name, arguments: JSON.stringify(c.input ?? {}) }),
  );
  // "max_output_tokens" or "content_filter": the response ends incomplete.
  const incomplete = turn.stopReason;
  const reasoningTokens = turn.thinking !== undefined ? tokens(turn.thinking) : 0;
  const outputTokens = turn.usage?.outputTokens ?? tokens((turn.text ?? "") + JSON.stringify(turn.toolCalls ?? [])) + reasoningTokens;
  const usage = {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: inputTokens + outputTokens,
  };
  const createdAt = Math.floor(Date.now() / 1000);
  const response = (status: string, out: any[]) => ({
    id: `resp_mock_${n}`,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output: out,
    incomplete_details: status === "incomplete" ? { reason: incomplete } : null,
    usage: status === "in_progress" ? null : usage,
  });
  const final = incomplete ? "incomplete" : "completed";

  if (!body.stream) {
    json(res, 200, response(final, output), turn.headers);
    return;
  }

  sseHead(res, turn.headers);
  const w = new SseWriter(res, turn.chunkDelayMs ?? 0);
  let seqNo = 0;
  const ev = (type: string, data: Record<string, unknown>) => w.event(type, { type, sequence_number: seqNo++, ...data });
  await ev("response.created", { response: response("in_progress", []) });
  await ev("response.in_progress", { response: response("in_progress", []) });
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    if (item.type === "reasoning") {
      await ev("response.output_item.added", { output_index: i, item: { id: item.id, type: "reasoning", summary: [] } });
    } else if (item.type === "message") {
      const text = item.content[0].text as string;
      await ev("response.output_item.added", { output_index: i, item: { ...item, status: "in_progress", content: [] } });
      await ev("response.content_part.added", { item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      for (const t of textChunks(text)) await ev("response.output_text.delta", { item_id: item.id, output_index: i, content_index: 0, delta: t });
      await ev("response.output_text.done", { item_id: item.id, output_index: i, content_index: 0, text });
      await ev("response.content_part.done", { item_id: item.id, output_index: i, content_index: 0, part: item.content[0] });
    } else {
      await ev("response.output_item.added", { output_index: i, item: { ...item, status: "in_progress", arguments: "" } });
      for (const p of jsonChunks(JSON.parse(item.arguments))) await ev("response.function_call_arguments.delta", { item_id: item.id, output_index: i, delta: p });
      await ev("response.function_call_arguments.done", { item_id: item.id, output_index: i, arguments: item.arguments });
    }
    await ev("response.output_item.done", { output_index: i, item });
  }
  await ev(`response.${final}`, { response: response(final, output) });
  if (!w.closed) res.end();
}
