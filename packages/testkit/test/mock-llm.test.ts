import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockLlm, type MockLlm } from "../src/index.ts";

/** Parse an SSE body into {event, data} records. */
function sse(text: string): Array<{ event?: string; data: string }> {
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const out: { event?: string; data: string } = { data: "" };
      for (const line of b.split("\n")) {
        if (line.startsWith("event: ")) out.event = line.slice(7);
        if (line.startsWith("data: ")) out.data += line.slice(6);
      }
      return out;
    });
}

describe("mock LLM", () => {
  let llm: MockLlm;
  beforeAll(async () => {
    llm = await startMockLlm();
  });
  afterAll(() => llm.close());
  beforeEach(() => llm.reset());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(llm.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("streams Anthropic text and tool_use with the real event sequence", async () => {
    llm.script([{ text: "Hello there", toolCalls: [{ name: "echo", input: { text: "hi" } }] }]);
    const res = await post("/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "x" }] }, { "x-api-key": "k" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sse(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const data = events.map((e) => JSON.parse(e.data));
    expect(data[0].message.model).toBe("claude-sonnet-5-5");
    const text = data.filter((d) => d.delta?.type === "text_delta").map((d) => d.delta.text).join("");
    expect(text).toBe("Hello there");
    expect(data[6].content_block).toMatchObject({ type: "tool_use", name: "echo" });
    const json = data.filter((d) => d.delta?.type === "input_json_delta").map((d) => d.delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ text: "hi" });
    expect(data[11].delta.stop_reason).toBe("tool_use");
    expect(data[11].usage.output_tokens).toBeGreaterThan(0);
    expect(llm.requests[0]).toMatchObject({ method: "POST", path: "/v1/messages", headers: { "x-api-key": "k" } });
    expect(llm.requests[0].body.model).toBe("claude-sonnet-5-5");
  });

  it("returns non-streaming Anthropic messages, thinking blocks and scripted errors", async () => {
    llm.script([{ text: "ok", thinking: "hmm" }, { status: 429, headers: { "retry-after": "30" }, error: "slow down" }]);
    const r1 = await (await post("/v1/messages", { model: "m", messages: [] })).json();
    expect(r1).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn" });
    expect(r1.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig_mock_1" },
      { type: "text", text: "ok" },
    ]);
    const r2 = await post("/v1/messages", { model: "m", stream: true, messages: [] });
    expect(r2.status).toBe(429);
    expect(r2.headers.get("retry-after")).toBe("30");
    expect(await r2.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    // Queue exhausted.
    const r3 = await post("/v1/messages", { model: "m", messages: [] });
    expect(r3.status).toBe(500);
  });

  it("streams OpenAI chunks with tool_calls, usage and [DONE]", async () => {
    llm.script([{ text: "Hi you", toolCalls: [{ name: "echo", input: { text: "yo" } }] }]);
    const res = await post("/v1/chat/completions", { model: "gpt-mock", stream: true, stream_options: { include_usage: true }, messages: [] });
    const events = sse(await res.text());
    expect(events.at(-1)!.data).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data));
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("Hi you");
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls[0]).toMatchObject({ index: 0, type: "function", function: { name: "echo" } });
    expect(JSON.parse(calls.map((c: any) => c.function.arguments).join(""))).toEqual({ text: "yo" });
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
    expect(chunks.at(-1).usage.total_tokens).toBeGreaterThan(0);
  });

  it("streams Responses items: reasoning, text and function calls, then usage", async () => {
    llm.script([{ thinking: "hmm", text: "Hi you", toolCalls: [{ name: "echo", input: { text: "yo" } }] }]);
    const res = await post("/v1/responses", { model: "gpt-mock", stream: true, include: ["reasoning.encrypted_content"], input: [] });
    const events = sse(await res.text()).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
    expect(events.every((e) => e.event === e.data.type)).toBe(true);
    expect(events[0].event).toBe("response.created");
    const text = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
    expect(text).toBe("Hi you");
    const items = events.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item);
    expect(items.map((i) => i.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(items[0].encrypted_content).toBe("enc_mock_1");
    expect(items[2]).toMatchObject({ call_id: "call_mock_1_0", name: "echo", arguments: '{"text":"yo"}' });
    const args = events.filter((e) => e.event === "response.function_call_arguments.delta").map((e) => e.data.delta).join("");
    expect(JSON.parse(args)).toEqual({ text: "yo" });
    const last = events.at(-1)!;
    expect(last.event).toBe("response.completed");
    expect(last.data.response.usage.output_tokens).toBeGreaterThan(0);

    llm.script([{ text: "cut", stopReason: "max_output_tokens" }]);
    const plain = await (await post("/v1/responses", { model: "gpt-mock", input: [] })).json();
    expect(plain).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(plain.output[0].content[0].text).toBe("cut");
  });

  it("returns non-streaming OpenAI completions and errors", async () => {
    llm.script([{ text: "plain" }, { status: 401, error: "bad key" }]);
    const r1 = await (await post("/v1/chat/completions", { model: "gpt-mock", messages: [] })).json();
    expect(r1.choices[0]).toMatchObject({ message: { role: "assistant", content: "plain" }, finish_reason: "stop" });
    const r2 = await post("/v1/chat/completions", { model: "gpt-mock", messages: [] });
    expect(r2.status).toBe(401);
    expect((await r2.json()).error).toMatchObject({ message: "bad key", code: "invalid_api_key" });
    expect(llm.requests.map((r) => r.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
  });

  it("lists models and uses the default turn when the queue is empty", async () => {
    const other = await startMockLlm({ defaultTurn: { text: "default" } });
    try {
      const models = await (await fetch(other.url + "/v1/models")).json();
      expect(models.data.map((m: any) => m.id)).toContain("claude-sonnet-5-5");
      const r = await (await fetch(other.url + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "x", messages: [] }) })).json();
      expect(r.choices[0].message.content).toBe("default");
      expect(other.pending()).toBe(0);
    } finally {
      await other.close();
    }
  });
});
