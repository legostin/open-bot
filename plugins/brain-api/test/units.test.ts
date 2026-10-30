import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { applyFallbackBoundary, buildAnthropicRequest } from "../server/anthropic.ts";
import { SUMMARY_HEAD, TRIM_NOTE, compacted, compactionCut, digest, estimateTokens, transcriptOf, trimHistory, type HistoryMessage } from "../server/history.ts";
import { classifyHttpError, proxyEnvFrom, resetAtFromHeaders } from "../server/http.ts";
import { toOpenAiMessages } from "../server/openai.ts";
import { LlmError } from "../server/http.ts";
import { buildResponsesRequest, responsesStream, toResponsesInput } from "../server/responses.ts";
import { parseToolInput } from "../server/provider.ts";
import { VARIANTS, resolveModel, resolveSettings } from "../server/settings.ts";
import { catalogFrom, parseModels } from "../server/catalog.ts";
import { parseSse } from "../server/sse.ts";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function* bytes(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield new TextEncoder().encode(c);
}

describe("parseSse", () => {
  it("handles split chunks, CRLF, comments and multi-line data", async () => {
    const events = await collect(parseSse(bytes("event: a\r\nda", "ta: {\"x\":1}\r\n\r\n: comment\n", "data: line1\ndata: line2\n\n", "data: tail")));
    expect(events).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "message", data: "line1\nline2" },
      { event: "message", data: "tail" },
    ]);
  });

  it("decodes UTF-8 split across chunks", async () => {
    const buf = new TextEncoder().encode("data: привет\n\n");
    async function* split() {
      yield buf.slice(0, 8);
      yield buf.slice(8);
    }
    expect(await collect(parseSse(split()))).toEqual([{ event: "message", data: "привет" }]);
  });
});

describe("rate limit reset parsing", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it("prefers retry-after (seconds or HTTP date)", () => {
    expect(resetAtFromHeaders({ "retry-after": "30" }, now)).toBe("2026-10-26T12:00:30.000Z");
    expect(resetAtFromHeaders({ "retry-after": "Mon, 26 Oct 2026 12:05:00 GMT" }, now)).toBe("2026-10-26T12:05:00.000Z");
  });
  it("reads anthropic-ratelimit-*-reset and x-ratelimit-reset-* durations", () => {
    expect(resetAtFromHeaders({ "anthropic-ratelimit-tokens-reset": "2026-10-26T12:01:00Z", "anthropic-ratelimit-requests-reset": "2026-10-26T12:00:10Z" }, now)).toBe(
      "2026-10-26T12:01:00.000Z",
    );
    expect(resetAtFromHeaders({ "x-ratelimit-reset-requests": "1m30s", "x-ratelimit-reset-tokens": "20ms" }, now)).toBe("2026-10-26T12:01:30.000Z");
    expect(resetAtFromHeaders({}, now)).toBeUndefined();
  });
  it("classifies errors", () => {
    expect(classifyHttpError(429, {}, '{"error":{"type":"rate_limit_error","message":"slow"}}', "A").kind).toBe("limit");
    expect(classifyHttpError(500, {}, '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', "A").kind).toBe("limit");
    expect(classifyHttpError(401, {}, '{"error":{"message":"bad key"}}', "A")).toMatchObject({ kind: "auth" });
    expect(classifyHttpError(400, {}, '{"error":{"message":"prompt is too long: 300000 tokens > 200000 maximum"}}', "A").kind).toBe("context");
    expect(classifyHttpError(400, {}, '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 8192 tokens"}}', "O").kind).toBe(
      "context",
    );
    expect(classifyHttpError(403, {}, "egress to api.example.com is not allowed", "A").kind).toBe("network");
    expect(classifyHttpError(502, {}, "<html>bad gateway</html>", "A")).toMatchObject({ kind: "http", status: 502 });
  });
  it("takes proxies from the session env", () => {
    expect(proxyEnvFrom({})).toBeUndefined();
    expect(proxyEnvFrom({ https_proxy: "http://t:x@127.0.0.1:8089", no_proxy: "localhost" })).toEqual({ HTTPS_PROXY: "http://t:x@127.0.0.1:8089", NO_PROXY: "localhost" });
  });
});

describe("history trimming", () => {
  const big = (n: number) => "x".repeat(n * 4);
  const user = (t: string): HistoryMessage => ({ role: "user", parts: [{ type: "text", text: t }] });
  const asst = (t: string): HistoryMessage => ({ role: "assistant", parts: [{ type: "raw", provider: "anthropic", block: { type: "thinking", thinking: "", signature: "s" } }, { type: "text", text: t }] });

  it("keeps the first user message and the most recent turns, strips thinking", () => {
    const msgs: HistoryMessage[] = [user("task " + big(100))];
    for (let i = 0; i < 20; i++) msgs.push(asst(`a${i} ` + big(100)), user(`u${i} ` + big(100)));
    const before = estimateTokens(msgs);
    const { messages, trimmed } = trimHistory(msgs, 1000);
    expect(trimmed).toBe(true);
    expect(estimateTokens(messages)).toBeLessThan(before);
    expect(estimateTokens(messages)).toBeLessThanOrEqual(1000);
    expect(messages[0]).toBe(msgs[0]);
    expect(messages[1]).toEqual(user(TRIM_NOTE));
    expect((messages.at(-1)!.parts[0] as any).text).toMatch(/^u19 /);
    expect(JSON.stringify(messages)).not.toContain("thinking");
    // Re-trimming keeps a single note.
    const again = trimHistory([...messages, ...msgs.slice(1)], 1000).messages;
    expect(again.filter((m) => (m.parts[0] as any).text === TRIM_NOTE)).toHaveLength(1);
  });

  it("never starts the kept suffix with tool results", () => {
    const msgs: HistoryMessage[] = [user("task")];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "assistant", parts: [{ type: "tool_call", id: `t${i}`, name: "echo", input: { text: big(50) } }] });
      msgs.push({ role: "user", parts: [{ type: "tool_result", id: `t${i}`, content: [{ type: "text", text: big(200) }] }] });
    }
    const { messages } = trimHistory(msgs, 700);
    const first = messages[2];
    expect(first.role).toBe("assistant");
    // Every tool result still follows its tool call.
    for (let i = 2; i < messages.length; i++) {
      const p = messages[i].parts[0];
      if (p.type === "tool_result") expect((messages[i - 1].parts[0] as any).id).toBe(p.id);
    }
  });

  it("leaves short histories alone", () => {
    const msgs = [user("a"), asst("b"), user("c")];
    expect(trimHistory(msgs, 10_000)).toEqual({ messages: msgs, trimmed: false });
  });
});

describe("history compaction", () => {
  const big = (n: number) => "x".repeat(n * 4);
  const user = (t: string): HistoryMessage => ({ role: "user", parts: [{ type: "text", text: t }] });

  it("cuts where the kept part starts cleanly, folds an earlier summary in, and strips thinking", () => {
    const msgs: HistoryMessage[] = [user("task")];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "assistant", parts: [{ type: "raw", provider: "anthropic", block: { type: "thinking", thinking: "", signature: "s" } }, { type: "tool_call", id: `t${i}`, name: "echo", input: { i } }] });
      msgs.push({ role: "user", parts: [{ type: "tool_result", id: `t${i}`, content: [{ type: "text", text: big(200) }] }] });
    }
    const cut = compactionCut(msgs, 1000);
    expect(cut).toBeGreaterThan(1);
    expect(msgs[cut].role).toBe("assistant");
    const next = compacted(msgs, cut, "what happened");
    expect(next[0]).toEqual(user(`${SUMMARY_HEAD}\nwhat happened`));
    expect(JSON.stringify(next)).not.toContain("thinking");
    expect(estimateTokens(next)).toBeLessThan(estimateTokens(msgs));
    // The next compaction reads the summary as what came before.
    expect(transcriptOf(next.slice(0, 2))).toMatch(/^Earlier summary:\nwhat happened\nAgent called echo/);
    // Only a big summary before short recent messages: nothing new to fold.
    expect(compactionCut([user(`${SUMMARY_HEAD}\n${big(500)}`), user("a"), { role: "assistant", parts: [{ type: "text", text: "b" }] }], 100)).toBe(0);
  });

  it("keeps a line per message, newest first, when the model cannot summarize", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => user(`message ${i} ${big(100)}`));
    const d = digest(msgs, 2000);
    expect(d.length).toBeLessThanOrEqual(2100);
    expect(d).toMatch(/^\(\d+ earlier messages left out\)/);
    expect(d).toContain("- User: message 49");
  });
});

describe("request building", () => {
  const call = (messages: HistoryMessage[], prevMessageCount = 0) => ({
    model: "claude-haiku-5-5",
    system: "",
    tools: [
      { name: "zeta", inputSchema: { type: "object", properties: {} } },
      { name: "alpha", description: "a" },
    ],
    messages,
    maxTokens: 1000,
    signal: new AbortController().signal,
    prevMessageCount,
  });

  it("builds Anthropic tool_result blocks with images, sorted tools and cache points", () => {
    const { body, betas } = buildAnthropicRequest(
      call([
        { role: "user", parts: [{ type: "text", text: "shot" }] },
        {
          role: "assistant",
          parts: [
            { type: "raw", provider: "anthropic", block: { type: "thinking", thinking: "", signature: "sig" } },
            { type: "tool_call", id: "t1", name: "zeta", input: {} },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "text", text: "extra" },
            { type: "tool_result", id: "t1", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], isError: true },
          ],
        },
      ]),
      { baseUrl: "x", apiKey: "k", effort: "high", refusalFallback: true, eagerTools: false },
    );
    expect((body.tools as any[]).map((t) => t.name)).toEqual(["alpha", "zeta"]);
    expect((body.tools as any[])[1]).toEqual({ name: "zeta", description: "", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } });
    expect(body.system).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "high" });
    // Haiku 5.5 has no server-side fallback.
    expect(body.fallbacks).toBeUndefined();
    expect(betas).toEqual([]);
    const msgs = body.messages as any[];
    expect(msgs[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig" });
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], is_error: true },
      { type: "text", text: "extra", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("merges consecutive same-role messages for Anthropic", () => {
    const { body } = buildAnthropicRequest(
      call([
        { role: "user", parts: [{ type: "text", text: "first (refused)" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
      ]),
      { baseUrl: "x", apiKey: "k", effort: "", refusalFallback: false, eagerTools: false },
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first (refused)" },
          { type: "text", text: "second", cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
  });

  it("builds OpenAI messages with tool images as a follow-up user message", () => {
    const history: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "shot" }] },
      { role: "assistant", parts: [{ type: "text", text: "ok" }, { type: "tool_call", id: "c1", name: "snap", input: { a: 1 } }] },
      { role: "user", parts: [{ type: "tool_result", id: "c1", content: [{ type: "text", text: "taken" }, { type: "image", mimeType: "image/png", data: "AAAA" }] }] },
    ];
    expect(toOpenAiMessages("sys", history, true)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "shot" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "snap", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "taken\n[image: see the next message]" },
      {
        role: "user",
        content: [
          { type: "text", text: "Images returned by the tool calls above:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
    // No system prompt → no system message; no vision → no image follow-up.
    const noVision = toOpenAiMessages("", history, false);
    expect(noVision).toHaveLength(3);
    expect(noVision[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "taken\n[image omitted: the model has no vision support]" });
  });

  it("builds Responses input with tool images as a follow-up user message and the turn's reasoning only", () => {
    const reasoning = (n: number) => ({ type: "raw" as const, provider: "openai" as const, block: { type: "reasoning", summary: [], encrypted_content: `enc${n}` } });
    const history: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "shot" }, { type: "image", mimeType: "image/jpeg", data: "BBBB" }] },
      { role: "assistant", parts: [reasoning(1), { type: "text", text: "ok" }, { type: "tool_call", id: "c1", name: "snap", input: { a: 1 } }] },
      { role: "user", parts: [{ type: "tool_result", id: "c1", content: [{ type: "text", text: "taken" }, { type: "image", mimeType: "image/png", data: "AAAA" }] }] },
      { role: "assistant", parts: [{ type: "text", text: "done" }] },
      { role: "user", parts: [{ type: "text", text: "again" }] },
      { role: "assistant", parts: [reasoning(2), { type: "raw", provider: "anthropic", block: { type: "thinking", thinking: "", signature: "s" } }, { type: "tool_call", id: "c2", name: "snap", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", id: "c2", content: [], isError: true }] },
    ];
    expect(toResponsesInput(history, true)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "shot" },
          { type: "input_image", image_url: "data:image/jpeg;base64,BBBB", detail: "auto" },
        ],
      },
      // The first turn's reasoning is over: only the current turn's goes back.
      { role: "assistant", content: "ok" },
      { type: "function_call", call_id: "c1", name: "snap", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "c1", output: "taken\n[image: see the next message]" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Images returned by the tool calls above:" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
      { type: "reasoning", summary: [], encrypted_content: "enc2" },
      { type: "function_call", call_id: "c2", name: "snap", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "Error: (empty result)" },
    ]);
    // No vision: placeholders instead of pictures, no follow-up message. That turn is in progress here: its reasoning goes back.
    const noVision = toResponsesInput(history.slice(0, 3), false);
    expect(noVision[0]).toEqual({ role: "user", content: "shot\n\n[image omitted: the model has no vision support]" });
    expect(noVision[1]).toEqual({ type: "reasoning", summary: [], encrypted_content: "enc1" });
    expect(noVision).toHaveLength(5);
    expect(noVision[4]).toEqual({ type: "function_call_output", call_id: "c1", output: "taken\n[image omitted: the model has no vision support]" });
  });

  it("builds a Responses request: instructions, effort with encrypted reasoning, loose tool schemas", () => {
    const { body, headers } = buildResponsesRequest({ ...call([{ role: "user", parts: [{ type: "text", text: "hi" }] }]), system: "sys", effort: "medium" }, { baseUrl: "x", apiKey: "k", label: "OpenAI", vision: true });
    expect(body).toMatchObject({ instructions: "sys", max_output_tokens: 1000, store: false, stream: true, reasoning: { effort: "medium" }, include: ["reasoning.encrypted_content"] });
    expect(body.tools).toEqual([
      { type: "function", name: "alpha", description: "a", parameters: { type: "object", properties: {} }, strict: false },
      { type: "function", name: "zeta", description: "", parameters: { type: "object", properties: {} }, strict: false },
    ]);
    expect(headers.authorization).toBe("Bearer k");
    const plain = buildResponsesRequest({ ...call([]), tools: [] }, { baseUrl: "x", label: "OpenAI", vision: true }).body;
    expect(plain.instructions).toBeUndefined();
    expect(plain.tools).toBeUndefined();
    expect(plain.reasoning).toBeUndefined();
  });

  it("echoes only text before a server-side fallback boundary", () => {
    const parts = applyFallbackBoundary([
      { type: "raw", provider: "anthropic", block: { type: "thinking", thinking: "", signature: "a" } },
      { type: "text", text: "partial" },
      { type: "tool_call", id: "x", name: "n", input: {} },
      { type: "raw", provider: "anthropic", block: { type: "fallback", from: { model: "a" }, to: { model: "b" } } },
      { type: "text", text: "rest" },
    ]);
    expect(parts).toEqual([
      { type: "text", text: "partial" },
      { type: "text", text: "rest" },
    ]);
  });

  it("parses tool input strictly", () => {
    expect(parseToolInput('{"a":1}')).toEqual({ input: { a: 1 } });
    expect(parseToolInput("")).toEqual({ input: {} });
    expect(parseToolInput('{"a":')).toEqual({ input: {}, invalid: '{"a":' });
    expect(parseToolInput("[1]")).toEqual({ input: {}, invalid: "[1]" });
  });
});

describe("settings and models", () => {
  it("applies defaults and ignores junk", () => {
    const s = resolveSettings({ maxTokens: "8000", maxSteps: -1, anthropicModel: "  ", customVision: "true", anthropicEffort: "" });
    expect(s.maxTokens).toBe(8000);
    expect(s.maxSteps).toBe(40);
    expect(s.anthropicModel).toBe("claude-opus-5-5");
    expect(s.customVision).toBe(true);
  });

  it("maps agent models per variant", () => {
    const s = resolveSettings({});
    expect(resolveModel(VARIANTS.anthropic, "opus", s)).toBe("claude-opus-5-5");
    expect(resolveModel(VARIANTS.anthropic, "fable", s)).toBe("claude-fable-5-1");
    expect(resolveModel(VARIANTS.anthropic, "claude-opus-4-8", s)).toBe("claude-opus-4-8");
    expect(resolveModel(VARIANTS.anthropic, "gpt-5", s)).toBe("claude-opus-5-5");
    expect(resolveModel(VARIANTS.anthropic, undefined, s)).toBe("claude-opus-5-5");
    expect(resolveModel(VARIANTS.openai, "sonnet", s)).toBe("gpt-5");
    expect(resolveModel(VARIANTS.openai, "gpt-5-mini", s)).toBe("gpt-5-mini");
    expect(resolveModel(VARIANTS.openrouter, "anthropic/claude-sonnet-4.5", s)).toBe("anthropic/claude-sonnet-4.5");
    expect(resolveModel(VARIANTS.custom, undefined, s)).toBe("llama3.1");
  });
});

describe("the providers' own model lists", () => {
  it("keeps the models that chat, newest first, with what the provider says of them", () => {
    const openai = parseModels("openai", {
      data: [
        { id: "gpt-5.6-luna", created: 100 },
        { id: "text-embedding-3-large", created: 300 },
        { id: "gpt-6-astra", created: 200 },
        { id: "whisper-1", created: 50 },
        { id: "gpt-image-2", created: 400 },
      ],
    });
    expect(openai.map((l) => l.meta.id)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
    expect(catalogFrom(openai).map((p) => [p.id, !!p.legacy])).toEqual([["gpt-6-astra", false], ["gpt-5.6-luna", true]]);

    const router = parseModels("openai", {
      data: [
        { id: "deepseek/deepseek-v4", name: "DeepSeek V4", description: "Fast and affordable.", pricing: { prompt: "0.0000003", completion: "0.0000012" }, architecture: { output_modalities: ["text"] }, created: 2 },
        { id: "black-forest/flux", architecture: { output_modalities: ["image"] }, created: 3 },
      ],
    });
    expect(router).toEqual([{ meta: { id: "deepseek/deepseek-v4", name: "DeepSeek V4", description: "Fast and affordable.", price: { input: 0.3, output: 1.2 } }, created: 2 }]);
    expect(catalogFrom(router)[0]).toMatchObject({ cost: 1, speed: 3 });

    const anthropic = parseModels("anthropic", { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z" }] });
    expect(anthropic[0].meta).toEqual({ id: "claude-opus-5-5", name: "Claude Opus 5.5" });
    expect(parseModels("openai", { data: [{ id: "mistral-old", capabilities: { completion_chat: true }, deprecation: "2026-11-30" }] })[0].meta.deprecated).toBe(true);
    expect(parseModels("openai", { nope: 1 })).toEqual([]);
  });
});

describe("Responses stream", () => {
  /** A server answering every request with this SSE body (a list of [event, data] pairs; strings are sent as-is). */
  async function serve(events: Array<[string, unknown] | string>): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(typeof e === "string" ? e : `event: ${e[0]}\ndata: ${JSON.stringify({ type: e[0], ...(e[1] as object) })}\n\n`);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
  }

  async function run(events: Array<[string, unknown] | string>) {
    const srv = await serve(events);
    const deltas: string[] = [];
    try {
      const it = responsesStream({ baseUrl: srv.url, label: "OpenAI", vision: true }, { model: "m", system: "", tools: [], messages: [], maxTokens: 10, signal: new AbortController().signal });
      for (;;) {
        const r = await it.next();
        if (r.done) return { result: r.value, deltas };
        if (r.value.type === "text") deltas.push(r.value.delta);
      }
    } finally {
      await srv.close();
    }
  }

  it("takes text the finished message has but no delta brought, and usage with cached tokens", async () => {
    const { result, deltas } = await run([
      ["response.output_item.added", { output_index: 0, item: { type: "message", content: [] } }],
      ["response.output_text.delta", { output_index: 0, delta: "Hel" }],
      ["response.output_item.done", { output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "Hello" }] } }],
      ["response.output_item.done", { output_index: 1, item: { type: "reasoning", summary: [] } }],
      ["response.completed", { response: { model: "gpt-x", usage: { input_tokens: 9, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } } } }],
    ]);
    expect(deltas).toEqual(["Hel", "lo"]);
    // Reasoning without its encrypted content cannot be passed back: it is not kept.
    expect(result).toEqual({ parts: [{ type: "text", text: "Hello" }], stop: "end", stopDetail: undefined, usage: { input: 9, output: 4, cacheRead: 5 }, model: "gpt-x" });
  });

  it("reports in-stream errors and failed responses like HTTP errors", async () => {
    const limit = await run([["error", { code: "rate_limit_exceeded", message: "slow down" }]]).catch((e) => e);
    expect(limit).toBeInstanceOf(LlmError);
    expect(limit.kind).toBe("limit");
    const context = await run([
      ["response.output_text.delta", { output_index: 0, delta: "par" }],
      ["response.failed", { response: { status: "failed", error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } } }],
    ]).catch((e) => e);
    expect(context.kind).toBe("context");
    expect(context.partial).toEqual([{ type: "text", text: "par" }]);
  });

  it("says a stream that ends before the response is complete broke off, and a filtered one was refused", async () => {
    const cut = await run([["response.output_text.delta", { output_index: 0, delta: "half" }]]).catch((e) => e);
    expect(cut.key).toBe("error.streamEnded");
    expect(cut.partial).toEqual([{ type: "text", text: "half" }]);
    const { result } = await run([["response.incomplete", { response: { incomplete_details: { reason: "content_filter" } } }]]);
    expect(result).toMatchObject({ stop: "refusal", stopDetail: "content_filter" });
  });
});
