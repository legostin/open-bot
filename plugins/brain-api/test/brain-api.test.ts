import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { BrainEvent, BrainSessionOptions } from "@owlbot/shared";
import { startMockLlm, startPlugin, type MockLlm, type PluginHarness } from "@owlbot/testkit";
import { ECHO_TOOL, startFakeMcp, type FakeMcp } from "./fake-mcp.ts";

const PLUGIN_DIR = join(import.meta.dirname, "..");
const VAULT = { anthropic_api_key: { value: "sk-ant-test" }, openai_api_key: { value: "sk-openai-test" } };

const text = (events: BrainEvent[]) =>
  events
    .filter((e) => e.type === "text")
    .map((e) => (e as { delta: string }).delta)
    .join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("brain-api plugin", () => {
  let llm: MockLlm;
  let mcp: FakeMcp;
  let h: PluginHarness;
  let settings: Record<string, unknown>;

  const opts = (sessionId: string, over: Partial<BrainSessionOptions> = {}): BrainSessionOptions => ({
    sessionId,
    agent: {
      id: "assistant",
      name: "Ассистент",
      description: "",
      brains: ["api:anthropic"],
      initiative: 1,
      tools: ["*"],
      skills: ["*"],
      policyProfile: "default",
      budget: { backgroundRunsPerDay: 10 },
      prompt: "",
      source: "builtin",
    },
    variant: "anthropic",
    model: "sonnet",
    workspace: mkdtempSync(join(tmpdir(), "owl-api-ws-")),
    mcp: { url: mcp.url, token: mcp.token, bridgeCommand: [] },
    systemPrompt: "You are a test assistant.",
    env: {},
    background: false,
    ...over,
  });

  beforeAll(async () => {
    llm = await startMockLlm();
    mcp = await startFakeMcp();
    settings = { anthropicBaseUrl: llm.url, openaiBaseUrl: `${llm.url}/v1`, customBaseUrl: `${llm.url}/v1` };
    h = await startPlugin({ dir: PLUGIN_DIR, settings, vault: VAULT });
  });
  afterAll(async () => {
    await h?.stop();
    await llm?.close();
    await mcp?.close();
  });
  beforeEach(() => {
    llm.reset();
    mcp.calls.length = 0;
  });

  it("registers the api brain", () => {
    expect([...h.brains.keys()]).toEqual(["api"]);
  });

  it("streams a text-only turn and then done", async () => {
    llm.script([{ text: "Привет, мир! Как дела?" }]);
    await h.brainCreate("api", opts("s-text"));
    const events = await h.brainSend("s-text", { text: "Привет" });

    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(1);
    expect(text(events)).toBe("Привет, мир! Как дела?");
    expect(events.some((e) => e.type === "usage" && (e.outputTokens ?? 0) > 0)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", resumeToken: "s-text" });

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req.path).toBe("/v1/messages");
    expect(req.headers.authorization).toBe("Bearer sk-ant-test");
    expect(req.headers["anthropic-version"]).toBe("2026-10-21");
    expect(req.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 16000, stream: true, fallbacks: "default" });
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.system).toEqual([{ type: "text", text: "You are a test assistant.", cache_control: { type: "ephemeral" } }]);
    expect(req.body.tools).toEqual([
      {
        name: "echo",
        description: "Echo the text back",
        input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        eager_input_streaming: true,
      },
    ]);
    expect(req.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Привет", cache_control: { type: "ephemeral" } }] }]);
    expect(mcp.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(mcp.calls.every((c) => c.auth === `Bearer ${mcp.token}`)).toBe(true);
  });

  it("runs a tool-use turn through MCP and sends the tool_result back", async () => {
    llm.script([{ text: "Проверю.", toolCalls: [{ name: "echo", input: { text: "ping" } }] }, { text: "Готово: ping" }]);
    await h.brainCreate("api", opts("s-tool"));
    const events = await h.brainSend("s-tool", { text: "Скажи ping" });

    const kinds = events.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]);
    expect(kinds).toEqual(["model", "text", "usage", "tool_call", "tool_result", "text", "usage", "done"]);
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", id: "toolu_mock_1_0", name: "echo", input: { text: "ping" } });
    expect(events.find((e) => e.type === "tool_result")).toEqual({ type: "tool_result", id: "toolu_mock_1_0", output: "echo: ping" });
    expect(text(events)).toBe("Проверю.Готово: ping");

    const toolCall = mcp.calls.find((c) => c.method === "tools/call")!;
    expect(toolCall.params).toEqual({ name: "echo", arguments: { text: "ping" } });
    expect(toolCall.id).toBe("toolu_mock_1_0");

    expect(llm.requests).toHaveLength(2);
    const second = llm.requests[1].body.messages;
    expect(second).toHaveLength(3);
    expect(second[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "Скажи ping" }] });
    expect(second[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Проверю." },
        { type: "tool_use", id: "toolu_mock_1_0", name: "echo", input: { text: "ping" } },
      ],
    });
    expect(second[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_mock_1_0", content: [{ type: "text", text: "echo: ping" }], cache_control: { type: "ephemeral" } }],
    });
    // The previous request's end stays a cache breakpoint.
    expect(second[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("replays thinking blocks unchanged", async () => {
    llm.script([{ thinking: "Нужно вызвать echo", toolCalls: [{ name: "echo", input: { text: "x" } }] }, { text: "ok" }]);
    await h.brainCreate("api", opts("s-think"));
    await h.brainSend("s-think", { text: "go" });
    const assistant = llm.requests[1].body.messages[1];
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "Нужно вызвать echo", signature: "sig_mock_1" });
    expect(assistant.content[1]).toMatchObject({ type: "tool_use", name: "echo" });
  });

  it("drops stored thinking blocks when the tool set changes between turns", async () => {
    llm.script([{ thinking: "размышление", text: "первый" }, { text: "второй" }, { text: "третий" }]);
    await h.brainCreate("api", opts("s-prefix"));
    await h.brainSend("s-prefix", { text: "раз" });
    await h.brainSend("s-prefix", { text: "два" });
    // Same tools: the thinking block is replayed.
    expect(llm.requests[1].body.messages[1].content[0]).toMatchObject({ type: "thinking", signature: "sig_mock_1" });
    mcp.tools = [...mcp.tools, { name: "extra", description: "x", inputSchema: { type: "object", properties: {} } }];
    try {
      await h.brainSend("s-prefix", { text: "три" });
    } finally {
      mcp.tools = [ECHO_TOOL];
    }
    const third = llm.requests[2].body;
    expect(third.tools.map((t: any) => t.name)).toEqual(["echo", "extra"]);
    expect(third.messages[1].content).toEqual([{ type: "text", text: "первый" }]);
    expect(JSON.stringify(third.messages)).not.toContain("thinking");
  });

  it("runs the same loop over OpenAI's Responses API", async () => {
    llm.script([{ toolCalls: [{ name: "echo", input: { text: "pong" } }] }, { text: "Ответ: pong" }]);
    await h.brainCreate("api", opts("s-openai", { variant: "openai" }));
    const events = await h.brainSend("s-openai", { text: "Скажи pong" });

    expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", id: "call_mock_1_0", name: "echo", input: { text: "pong" } });
    expect(events.find((e) => e.type === "tool_result")).toEqual({ type: "tool_result", id: "call_mock_1_0", output: "echo: pong" });
    expect(text(events)).toBe("Ответ: pong");
    expect(events.filter((e) => e.type === "usage").every((e) => (e as { outputTokens: number }).outputTokens > 0)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", resumeToken: "s-openai" });

    expect(llm.requests.map((r) => r.path)).toEqual(["/v1/responses", "/v1/responses"]);
    const [first, second] = llm.requests;
    expect(first.headers.authorization).toBe("Bearer sk-openai-test");
    // Claude aliases do not apply to OpenAI: the variant default is used. Nothing is stored on OpenAI's side.
    expect(first.body).toMatchObject({ model: "gpt-5", stream: true, store: false, max_output_tokens: 16000, instructions: "You are a test assistant." });
    // No effort for the session: none is sent.
    expect(first.body.reasoning).toBeUndefined();
    expect(first.body.include).toBeUndefined();
    expect(first.body.tools).toEqual([
      { type: "function", name: "echo", description: "Echo the text back", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, strict: false },
    ]);
    expect(second.body.input).toEqual([
      { role: "user", content: "Скажи pong" },
      { type: "function_call", call_id: "call_mock_1_0", name: "echo", arguments: '{"text":"pong"}' },
      { type: "function_call_output", call_id: "call_mock_1_0", output: "echo: pong" },
    ]);
  });

  it("calls tools with a reasoning effort on OpenAI and passes the turn's reasoning back", async () => {
    llm.script([
      { thinking: "plan", text: "Проверю.", toolCalls: [{ name: "echo", input: { text: "a" } }, { name: "echo", input: { text: "b" } }], usage: { inputTokens: 50, outputTokens: 30 } },
      { thinking: "more", text: "Готово." },
      { text: "Ещё." },
    ]);
    await h.brainCreate("api", opts("s-openai-effort", { variant: "openai", model: "gpt-6.1-sol", effort: "high" }));
    const events = await h.brainSend("s-openai-effort", { text: "Два эха" });

    expect(events.filter((e) => e.type === "tool_result").map((e) => (e as { output: string }).output)).toEqual(["echo: a", "echo: b"]);
    expect(text(events)).toBe("Проверю.Готово.");
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 50, outputTokens: 30 });
    expect(events.some((e) => e.type === "error")).toBe(false);

    const [first, second] = llm.requests;
    expect(first.body).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"] });
    expect(first.body.tools).toHaveLength(1);
    // The reasoning goes back in place, before the text and the calls it led to; no item ids (nothing is stored).
    expect(second.body.input).toEqual([
      { role: "user", content: "Два эха" },
      { type: "reasoning", summary: [], encrypted_content: "enc_mock_1" },
      { role: "assistant", content: "Проверю." },
      { type: "function_call", call_id: "call_mock_1_0", name: "echo", arguments: '{"text":"a"}' },
      { type: "function_call", call_id: "call_mock_1_1", name: "echo", arguments: '{"text":"b"}' },
      { type: "function_call_output", call_id: "call_mock_1_0", output: "echo: a" },
      { type: "function_call_output", call_id: "call_mock_1_1", output: "echo: b" },
    ]);
    expect(second.body.reasoning).toEqual({ effort: "high" });

    // A new turn: the finished turn's reasoning stays behind.
    await h.brainSend("s-openai-effort", { text: "Ещё раз" });
    const third = llm.requests[2].body;
    expect(JSON.stringify(third.input)).not.toContain("enc_mock");
    expect(third.input.at(-2)).toEqual({ role: "assistant", content: "Готово." });
    expect(third.input.at(-1)).toEqual({ role: "user", content: "Ещё раз" });
  });

  it("says when an OpenAI answer ran out of output tokens", async () => {
    llm.script([{ text: "Начало", stopReason: "max_output_tokens" }]);
    await h.brainCreate("api", opts("s-openai-max", { variant: "openai" }));
    const events = await h.brainSend("s-openai-max", { text: "Длинно" });
    expect(text(events)).toMatch(/^Начало\n\n\S/);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("talks to a custom OpenAI-compatible server without a key", async () => {
    llm.script([{ text: "локально" }]);
    await h.brainCreate("api", opts("s-custom", { variant: "custom" }));
    const events = await h.brainSend("s-custom", { text: "hi" });
    expect(text(events)).toBe("локально");
    const req = llm.requests[0];
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toMatchObject({ model: "llama3.1", max_tokens: 16000 });
  });

  it("reports 429 as limit_hit with resetAt from retry-after", async () => {
    llm.script([{ status: 429, headers: { "retry-after": "120" }, error: "Too many requests" }]);
    await h.brainCreate("api", opts("s-429"));
    const before = Date.now();
    const events = await h.brainSend("s-429", { text: "hi" });
    const lim = events.find((e) => e.type === "limit_hit") as Extract<BrainEvent, { type: "limit_hit" }>;
    expect(lim).toBeDefined();
    expect(lim.detail).toContain("Too many requests");
    const reset = Date.parse(lim.resetAt!);
    expect(reset).toBeGreaterThanOrEqual(before + 119_000);
    expect(reset).toBeLessThanOrEqual(Date.now() + 121_000);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("reports 529 overloaded as limit_hit with anthropic-ratelimit reset headers", async () => {
    const at = new Date(Date.now() + 90_000).toISOString();
    llm.script([{ status: 529, headers: { "anthropic-ratelimit-requests-reset": at }, error: "Overloaded" }]);
    await h.brainCreate("api", opts("s-529"));
    const events = await h.brainSend("s-529", { text: "hi" });
    expect(events.find((e) => e.type === "limit_hit")).toMatchObject({ resetAt: at });
  });

  it("reports 401 as a fatal error", async () => {
    llm.script([{ status: 401, error: "invalid x-api-key" }]);
    await h.brainCreate("api", opts("s-401"));
    const events = await h.brainSend("s-401", { text: "hi" });
    const err = events.find((e) => e.type === "error") as Extract<BrainEvent, { type: "error" }>;
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/^API key rejected \(Anthropic, 401\)/);
    expect(err.message).toContain("invalid x-api-key");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails fast without a vault key", async () => {
    await h.brainCreate("api", opts("s-nokey", { variant: "openrouter" }));
    // openrouter has no key in this vault → fatal before any request.
    const events = await h.brainSend("s-nokey", { text: "hi" });
    expect(events[0]).toEqual({ type: "error", message: "No API key yet: paste it into the chat (it is stored as openrouter_api_key)", fatal: true });
    expect(llm.requests).toHaveLength(0);
  });

  it("reports an unreachable server as a fatal network error", async () => {
    h.setSettings({ ...settings, customBaseUrl: "http://127.0.0.1:1/v1" });
    await sleep(100);
    try {
      await h.brainCreate("api", opts("s-net", { variant: "custom" }));
      const events = await h.brainSend("s-net", { text: "hi" });
      const err = events.find((e) => e.type === "error") as Extract<BrainEvent, { type: "error" }>;
      expect(err.fatal).toBe(true);
      expect(err.message).toContain("Could not reach 127.0.0.1:1");
    } finally {
      h.setSettings(settings);
      await sleep(100);
    }
  });

  it("stops after maxSteps with a note", async () => {
    h.setSettings({ ...settings, maxSteps: 2 });
    await sleep(100);
    try {
      llm.script([{ toolCalls: [{ name: "echo", input: { text: "1" } }] }, { toolCalls: [{ name: "echo", input: { text: "2" } }] }]);
      await h.brainCreate("api", opts("s-steps"));
      const events = await h.brainSend("s-steps", { text: "loop" });
      expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
      expect(text(events)).toContain("(Turn stopped: reached the limit of 2 steps.)");
      expect(llm.requests).toHaveLength(2);
    } finally {
      h.setSettings(settings);
      await sleep(100);
    }
  });

  it("interrupt aborts the in-flight request and ends the turn cleanly", async () => {
    // message_start, ping, content_block_start, then one word every 100 ms.
    llm.script([{ text: "раз два три четыре пять шесть семь восемь девять десять", chunkDelayMs: 100 }]);
    await h.brainCreate("api", opts("s-int"));
    const pending = h.brainSend("s-int", { text: "Считай" });
    for (let i = 0; i < 50 && llm.requests.length === 0; i++) await sleep(20);
    await sleep(700);
    await h.brainInterrupt("s-int");
    const events = await pending;
    expect(events.at(-1)).toEqual({ type: "done", resumeToken: "s-int" });
    expect(events.some((e) => e.type === "error" || e.type === "limit_hit")).toBe(false);
    const partial = text(events);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan("раз два три четыре пять шесть семь восемь девять десять".length);

    // The partial answer stays in the history and the session keeps working.
    llm.script([{ text: "ok" }]);
    const next = await h.brainSend("s-int", { text: "дальше" });
    expect(text(next)).toBe("ok");
    const msgs = llm.requests.at(-1)!.body.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content[0].text).toBe(partial);
  });

  it("takes input that arrives mid-turn with its next request: after the tool results, or as a new message", async () => {
    llm.script([
      { text: "Проверю.", toolCalls: [{ name: "echo", input: { text: "ping" } }], chunkDelayMs: 60 },
      { text: "Готово, и про второе тоже.", chunkDelayMs: 60 },
      { text: "И третье." },
    ]);
    await h.brainCreate("api", opts("s-steer"));
    const pending = h.brainSend("s-steer", { text: "Скажи ping" });
    for (let i = 0; i < 50 && llm.requests.length === 0; i++) await sleep(20);
    expect(await h.brainSteer("s-steer", { text: "и ещё второе" })).toBe(true);
    // The second answer is streaming: this one comes after it, as a new message.
    for (let i = 0; i < 100 && llm.requests.length < 2; i++) await sleep(20);
    expect(await h.brainSteer("s-steer", { text: "и третье" })).toBe(true);
    const events = await pending;
    expect(text(events)).toBe("Проверю.Готово, и про второе тоже.И третье.");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);

    expect(llm.requests).toHaveLength(3);
    const second = llm.requests[1].body.messages;
    expect(second.at(-1).content.map((b: any) => b.type)).toEqual(["tool_result", "text"]);
    expect(second.at(-1).content[1].text).toBe("и ещё второе");
    const third = llm.requests[2].body.messages;
    expect(third.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(third.at(-1).content[0].text).toBe("и третье");
    // Over: nothing to join.
    expect(await h.brainSteer("s-steer", { text: "поздно" })).toBe(false);
  });

  it("routes model calls through the session's egress proxy from opts.env", async () => {
    const seen: Array<{ url?: string; auth?: string }> = [];
    const proxy = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers["proxy-authorization"] as string | undefined });
      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const up = http.request(req.url!, { method: req.method, headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as AddressInfo).port;
    try {
      llm.script([{ text: "через прокси" }]);
      await h.brainCreate("api", opts("s-proxy", { env: { HTTP_PROXY: `http://brain-token:x@127.0.0.1:${port}`, NO_PROXY: "" } }));
      const events = await h.brainSend("s-proxy", { text: "hi" });
      expect(text(events)).toBe("через прокси");
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(`${llm.url}/v1/messages`);
      expect(seen[0].auth).toBe(`Basic ${Buffer.from("brain-token:x").toString("base64")}`);
      // MCP (hub-local) is not proxied.
      expect(mcp.calls.some((c) => c.method === "tools/list")).toBe(true);
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });

  it("probes variants by vault key presence", async () => {
    expect(await h.brainProbe("api", "anthropic")).toMatchObject({ available: true, authenticated: true, models: expect.arrayContaining(["claude-sonnet-5-5", "claude-opus-5-5"]) });
    // The provider's own list (here the mock's /models), with what it says of each model, over the built-in one.
    const openai = await h.brainProbe("api", "openai");
    expect(openai).toMatchObject({ available: true, authenticated: true, models: expect.arrayContaining(["gpt-mock"]) });
    expect(openai.catalog?.map((m: { id: string }) => m.id)).toEqual(openai.models);

    const bare = await startPlugin({ dir: PLUGIN_DIR, settings, vault: {} });
    try {
      expect(await bare.brainProbe("api", "anthropic")).toMatchObject({ available: true, authenticated: false, detail: "No API key yet: paste it into the chat (it is stored as anthropic_api_key)" });
      expect(await bare.brainProbe("api", "openrouter")).toMatchObject({ available: true, authenticated: false, detail: "No API key yet: paste it into the chat (it is stored as openrouter_api_key)" });
      expect(await bare.brainProbe("api")).toMatchObject({ authenticated: false, detail: "No API key yet: paste it into the chat (it is stored as anthropic_api_key)" });
      // A server on this machine must have the model: the mock lists gpt-mock, not the default llama3.1.
      expect(await bare.brainProbe("api", "custom")).toMatchObject({
        available: true,
        authenticated: false,
        model: "llama3.1",
        models: expect.arrayContaining(["gpt-mock"]),
        detail: expect.stringMatching(/has no model "llama3\.1"\. It has: .*gpt-mock.*ollama pull llama3\.1$/),
      });
      bare.setSettings({ ...settings, customModel: "gpt-mock" });
      expect(await bare.brainProbe("api", "custom")).toMatchObject({ available: true, authenticated: true, model: "gpt-mock", detail: `${llm.url}/v1` });
      expect(await bare.brainProbe("api", "nope")).toMatchObject({
        available: false,
        authenticated: false,
        detail: 'Unknown variant "nope". Available: anthropic, openai, openrouter, custom, moonshot, deepseek, zhipu, qwen, gemini, xai, mistral, groq',
      });
      // Every provider offers its models for the hub to choose from, and waits for its own key.
      expect(await bare.brainProbe("api", "deepseek")).toMatchObject({ available: true, authenticated: false, models: ["deepseek-chat", "deepseek-reasoner"], detail: expect.stringContaining("deepseek_api_key") });
      expect(await bare.brainProbe("api", "moonshot")).toMatchObject({ models: expect.arrayContaining(["kimi-k2-thinking"]) });
      expect(await bare.brainProbe("api", "zhipu")).toMatchObject({ models: expect.arrayContaining(["glm-4.6"]) });
      // More models from the settings, ids with their own ":" too.
      bare.setSettings({ ...settings, extraModels: "deepseek: deepseek-v4, deepseek-v4-reasoner\ncustom: qwen3:8b" });
      expect((await bare.brainProbe("api", "deepseek")).models).toEqual(["deepseek-chat", "deepseek-reasoner", "deepseek-v4", "deepseek-v4-reasoner"]);
      bare.setSettings(settings);
      // Probe details are shown on the Brains page in the hub language.
      bare.setLocale("ru");
      expect(await bare.brainProbe("api", "anthropic")).toMatchObject({ authenticated: false, detail: "Нет ключа API: вставьте его в чат (он сохранится как anthropic_api_key)" });
      // A local server that does not answer (Ollama not started) is not a ready brain.
      bare.setLocale("en");
      bare.setSettings({ ...settings, customBaseUrl: "http://127.0.0.1:1/v1" });
      expect(await bare.brainProbe("api", "custom")).toMatchObject({ available: true, authenticated: false, detail: expect.stringMatching(/does not answer at http:\/\/127\.0\.0\.1:1\/v1/) });
    } finally {
      await bare.stop();
    }
  });

  it("asks the hub for a missing key once, until the vault changes", async () => {
    // The hub probes brains every minute and the Brains page asks for fresh probes: each ask used to reach the vault
    // and its audit log as another vault.denied.
    const bare = await startPlugin({ dir: PLUGIN_DIR, settings, vault: {} });
    const asked = () => bare.vaultGets.filter((id) => id === "openrouter_api_key").length;
    try {
      for (let i = 0; i < 5; i++) expect(await bare.brainProbe("api", "openrouter")).toMatchObject({ authenticated: false });
      // The first answer, then once more after subscribing to vault changes (the key may have come in between).
      expect(asked()).toBe(2);
      expect(bare.subscriptions.has("vault.updated") && bare.subscriptions.has("vault.state")).toBe(true);
      // Another missing item is a lookup of its own.
      expect(await bare.brainProbe("api", "anthropic")).toMatchObject({ authenticated: false });
      expect(bare.vaultGets.filter((id) => id === "anthropic_api_key").length).toBe(1);
      // A key stored from the chat or the security console counts at once.
      bare.setVault("openrouter_api_key", { value: "sk-or-v1-test" });
      expect(await bare.brainProbe("api", "openrouter")).toMatchObject({ authenticated: true });
      expect(asked()).toBe(3);
      // Found keys are not remembered: removing it is seen on the next probe, and so is the vault opening again.
      bare.setVault("openrouter_api_key");
      expect(await bare.brainProbe("api", "openrouter")).toMatchObject({ authenticated: false });
      bare.emit("vault.state", { state: "unlocked" });
      expect(await bare.brainProbe("api", "openrouter")).toMatchObject({ authenticated: false });
      expect(asked()).toBe(5);
    } finally {
      await bare.stop();
    }
  });

  it("persists history and resumes it in a new plugin process", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "owl-api-data-"));
    const h1 = await startPlugin({ dir: PLUGIN_DIR, settings, vault: VAULT, dataDir });
    llm.script([{ text: "Приятно познакомиться, Оля!" }]);
    await h1.brainCreate("api", opts("s-resume"));
    const first = await h1.brainSend("s-resume", { text: "Меня зовут Оля" });
    expect(first.at(-1)).toEqual({ type: "done", resumeToken: "s-resume" });
    await h1.brainClose("s-resume");
    await h1.stop();

    const h2 = await startPlugin({ dir: PLUGIN_DIR, settings, vault: VAULT, dataDir });
    try {
      llm.script([{ text: "Вас зовут Оля." }]);
      await h2.brainCreate("api", opts("s-resume", { resume: "s-resume" }));
      const events = await h2.brainSend("s-resume", { text: "Как меня зовут?" });
      expect(text(events)).toBe("Вас зовут Оля.");
      const msgs = llm.requests.at(-1)!.body.messages;
      expect(msgs.map((m: any) => [m.role, m.content.map((c: any) => c.text).join("")])).toEqual([
        ["user", "Меня зовут Оля"],
        ["assistant", "Приятно познакомиться, Оля!"],
        ["user", "Как меня зовут?"],
      ]);

      // A saved history that ends with an unanswered tool call is sealed before the next turn.
      writeFileSync(
        join(dataDir, "sessions", "s-dangling.json"),
        JSON.stringify({
          version: 1,
          sessionId: "s-dangling",
          variant: "anthropic",
          updatedAt: new Date().toISOString(),
          messages: [
            { role: "user", parts: [{ type: "text", text: "go" }] },
            { role: "assistant", parts: [{ type: "tool_call", id: "toolu_old", name: "echo", input: { text: "x" } }] },
          ],
        }),
      );
      llm.script([{ text: "продолжаю" }]);
      await h2.brainCreate("api", opts("s-dangling", { resume: "s-dangling" }));
      await h2.brainSend("s-dangling", { text: "дальше" });
      const sealed = llm.requests.at(-1)!.body.messages;
      expect(sealed).toHaveLength(3);
      expect(sealed[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_old", is_error: true });
      expect(sealed[2].content[1]).toMatchObject({ type: "text", text: "дальше" });

      // Without resume the same id starts from scratch.
      llm.script([{ text: "?" }]);
      await h2.brainCreate("api", opts("s-resume"));
      await h2.brainSend("s-resume", { text: "Новый разговор" });
      expect(llm.requests.at(-1)!.body.messages).toHaveLength(1);
    } finally {
      await h2.stop();
    }
  });
});
