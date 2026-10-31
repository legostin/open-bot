import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KEY_PROVIDERS, type KeyProvider, type MachineUsage } from "@piomio/shared";
import { ModelGateway, type GatewaySetup } from "../src/gateway.ts";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const shut = (s: Server) => new Promise<void>((r) => (s.close(() => r()), s.closeAllConnections()));
const readText = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks).toString("utf8")));
  });
const sse = (events: Array<[string, unknown]>) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

// A fake provider on another loopback port: Anthropic at /, DeepSeek at /deepseek, OpenAI at /openai/v1.
let handler: Handler = (_req, _body, res) => res.end("{}");
let seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
const fake = createServer(async (req, res) => {
  const body = await readText(req);
  seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
  await handler(req, body, res);
});

const NOW = new Date("2026-10-30T12:00:00.000Z");
const usages: MachineUsage[] = [];
const logs: string[] = [];
let catalog: KeyProvider[] = [];
let gw: ModelGateway;
let base = "";

const OPUS = { id: "claude-opus-x", provider: "anthropic", price: { input: 15, output: 75 } };
const SONNET = { id: "claude-sonnet-x", provider: "anthropic", price: { input: 3, output: 15 } };
const HAIKU = { id: "claude-haiku-x", provider: "anthropic", price: { input: 1, output: 5 } };
const DS = { id: "deepseek-x", provider: "deepseek", price: { input: 0.5, output: 2 } };
const GPT = { id: "gpt-x", provider: "openai", price: { input: 1.25, output: 10 } };

const setup = (over: Partial<GatewaySetup> = {}): GatewaySetup => ({
  wires: {
    anthropic: {
      models: [OPUS, SONNET, HAIKU],
      providers: [
        { id: "anthropic", key: "sk-ant-test" },
        { id: "deepseek", key: "sk-ds-test" },
      ],
    },
    openai: { models: [GPT], providers: [{ id: "openai", key: "sk-oa-test" }] },
  },
  ...over,
});

const claude = (token: string, body: unknown, path = "/v1/messages?beta=true", headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const codex = (token: string, body?: unknown, path = "/v1/responses") =>
  fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const messageJson = (usage: Record<string, number>) => (_req: IncomingMessage, _body: string, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json", "request-id": "req_1" });
  res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], usage }));
};

beforeAll(async () => {
  const port = await listen(fake);
  const at = (id: string, baseUrl: string) => ({ ...KEY_PROVIDERS.find((p) => p.id === id)!, baseUrl });
  catalog = [
    at("anthropic", `http://127.0.0.1:${port}`),
    at("deepseek", `http://127.0.0.1:${port}/deepseek`),
    at("openai", `http://127.0.0.1:${port}/openai/v1`),
  ];
  gw = new ModelGateway({ onUsage: (u) => usages.push(u), log: (m) => logs.push(m), providers: catalog, now: () => NOW });
  base = `http://127.0.0.1:${await gw.start()}`;
});
afterAll(async () => {
  await gw.stop();
  await shut(fake);
});
beforeEach(() => {
  seen = [];
  usages.length = 0;
  logs.length = 0;
  handler = messageJson({ input_tokens: 10, output_tokens: 5 });
  gw.configure(setup());
});

describe("ModelGateway", () => {
  it("listens on loopback and hands out a fresh token per session", () => {
    expect(gw.port).toBeGreaterThan(0);
    const a = gw.open("s1", "claude-code");
    const b = gw.open("s1", "claude-code");
    expect(a).not.toBe(b);
    expect(b).toMatch(/^[\w-]{40,}$/);
  });

  it("rewrites a model off the list to the cheapest allowed one", async () => {
    const token = gw.open("s-cheap", "claude-code");
    const r = await claude(token, { model: "claude-opus-9", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect(JSON.parse(seen[0].body)).toMatchObject({ model: "claude-haiku-x", max_tokens: 10 });
    expect(logs).toContain("model claude-opus-9 → claude-haiku-x");
    expect(usages[0]).toMatchObject({ model: "claude-haiku-x", provider: "anthropic", inputTokens: 10, outputTokens: 5, usd: 0.000035 });
  });

  it("passes an allowed model and the query through unchanged", async () => {
    const token = gw.open("s-ok", "claude-code");
    const raw = '{"model":"claude-opus-x",  "max_tokens":10,"messages":[]}';
    const r = await claude(token, raw);
    expect(r.status).toBe(200);
    expect(r.headers.get("request-id")).toBe("req_1");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/messages?beta=true", body: raw });
    expect(logs).toEqual([]);
  });

  it("answers 401 in the wire's shape for unknown and closed tokens", async () => {
    let r = await claude("nope", { model: "claude-opus-x" });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    const token = gw.open("s-closed", "codex");
    gw.close("s-closed");
    r = await codex(token, { model: "gpt-x" });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: { type: "invalid_request_error", code: "invalid_api_key" } });
    expect(seen).toEqual([]);
  });

  it("answers 403 without a provider key or without allowed models", async () => {
    gw.configure(setup({ wires: { anthropic: { models: [OPUS], providers: [{ id: "anthropic", key: "" }] }, openai: { models: [], providers: [{ id: "openai", key: "k" }] } } }));
    let r = await claude(gw.open("s-nokey", "claude-code"), { model: "claude-opus-x" });
    expect(r.status).toBe(403);
    const e = await r.json();
    expect(e).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect(e.error.message).toMatch(/No provider key/);
    r = await codex(gw.open("s-nomodels", "codex"), { model: "gpt-x" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toMatch(/No models are allowed/);
    expect(seen).toEqual([]);
  });

  it("refuses paths that are not model calls", async () => {
    const r = await claude(gw.open("s-path", "claude-code"), { requests: [] }, "/v1/messages/batches");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
    expect(seen).toEqual([]);
  });

  it("answers 429 over the limit, and the running total stops the next call", async () => {
    gw.configure(setup({ limit: { usd: 1, spent: 1 } }));
    let r = await claude(gw.open("s-lim", "claude-code"), { model: "claude-opus-x" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "Spend limit reached on this machine: $1.00 of $1.00" } });
    r = await codex(gw.open("s-lim-codex", "codex"), { model: "gpt-x" });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: { type: "insufficient_quota", code: "insufficient_quota" } });
    expect(seen).toEqual([]);

    gw.configure(setup({ limit: { usd: 0.01, spent: 0.005 } }));
    expect(gw.spent()).toBe(0.005);
    handler = messageJson({ input_tokens: 1000, output_tokens: 0 }); // 1000 × $15/M = $0.015
    const token = gw.open("s-lim2", "claude-code");
    r = await claude(token, { model: "claude-opus-x" });
    expect(r.status).toBe(200);
    await r.text();
    expect(gw.spent()).toBe(0.02);
    r = await claude(token, { model: "claude-opus-x" });
    expect(r.status).toBe(429);
    expect((await r.json()).error.message).toBe("Spend limit reached on this machine: $0.02 of $0.01");
    expect(seen).toHaveLength(1);
  });

  it("reads usage from a streamed Anthropic answer, cache tokens included", async () => {
    const stream = sse([
      ["message_start", { type: "message_start", message: { id: "m", model: "claude-sonnet-x", usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 1 } } }],
      ["ping", { type: "ping" }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'the "usage" word' } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    handler = (_req, _body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Split mid-line and with CRLF, as a network would.
      const crlf = stream.replace(/\n/g, "\r\n");
      for (let i = 0; i < crlf.length; i += 37) res.write(crlf.slice(i, i + 37));
      res.end();
    };
    const r = await claude(gw.open("s-sse", "claude-code"), { model: "claude-sonnet-x", stream: true });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect((await r.text()).replace(/\r\n/g, "\n")).toBe(stream);
    expect(usages).toEqual([
      {
        brainId: "claude-code",
        provider: "anthropic",
        model: "claude-sonnet-x",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        usd: 0.0021, // 100×3 + 1000×0.3 + 200×3.75 + 50×15, per million
        at: NOW.toISOString(),
      },
    ]);
  });

  it("reads usage from an Anthropic JSON answer; count_tokens reports nothing", async () => {
    handler = messageJson({ input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 4 });
    const token = gw.open("s-json", "claude-code");
    let r = await claude(token, { model: "claude-sonnet-x" });
    expect((await r.json()).content[0].text).toBe("hi");
    expect(usages).toMatchObject([{ inputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 4, usd: 0.00015 }]);

    handler = (_req, _body, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":42}');
    r = await claude(token, { model: "claude-sonnet-x", messages: [] }, "/v1/messages/count_tokens?beta=true");
    expect(await r.json()).toEqual({ input_tokens: 42 });
    expect(seen.at(-1)!.url).toBe("/v1/messages/count_tokens?beta=true");
    expect(usages).toHaveLength(1);
  });

  it("forwards Codex under the provider's /v1 and reads Responses usage, cached tokens included", async () => {
    handler = (req, _body, res) => {
      if (req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[]}');
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([["response.created", { type: "response.created", response: { id: "r", status: "in_progress", usage: null } }]]));
      res.write(sse([["response.output_text.delta", { type: "response.output_text.delta", delta: "ok" }]]));
      res.end(sse([["response.completed", { type: "response.completed", response: { id: "r", status: "completed", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 1080 } } }]]));
    };
    const token = gw.open("s-codex", "codex");
    let r = await codex(token, { model: "gpt-x", stream: true, input: [] });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen[0].url).toBe("/openai/v1/responses");
    expect(seen[0].headers.authorization).toBe("Bearer sk-oa-test");
    expect(usages).toEqual([
      { brainId: "codex", provider: "openai", model: "gpt-x", inputTokens: 400, outputTokens: 80, cacheReadTokens: 600, cacheWriteTokens: 0, usd: 0.001375, at: NOW.toISOString() },
    ]);

    r = await codex(token, undefined, "/v1/models?client_version=0.1");
    expect(await r.json()).toEqual({ object: "list", data: [] });
    expect(seen[1]).toMatchObject({ method: "GET", url: "/openai/v1/models?client_version=0.1" });
    expect(usages).toHaveLength(1);
  });

  it("gives the provider its key and never the session token", async () => {
    const token = gw.open("s-keys", "claude-code");
    const r = await claude(token, { model: "claude-opus-x" }, undefined, { "anthropic-beta": "interleaved-thinking-2025-05-14", "x-api-key": token, "accept-encoding": "gzip, br" });
    expect(r.status).toBe(200);
    const h = seen[0].headers;
    expect(h["x-api-key"]).toBe("sk-ant-test");
    expect(h.authorization).toBeUndefined();
    expect(h["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["accept-encoding"]).toBe("identity");
    expect(JSON.stringify(seen[0])).not.toContain(token);
  });

  it("sends the key the way each provider takes it, the CLI may use either header", async () => {
    gw.configure(setup({ wires: { anthropic: { models: [DS, HAIKU], providers: [{ id: "anthropic", key: "sk-ant-test" }, { id: "deepseek", key: "sk-ds-test" }] } } }));
    const token = gw.open("s-ds", "claude-code");
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-x" }),
    });
    expect(r.status).toBe(200);
    expect(seen[0].url).toBe("/deepseek/v1/messages");
    expect(seen[0].headers.authorization).toBe("Bearer sk-ds-test");
    expect(seen[0].headers["x-api-key"]).toBeUndefined();
    expect(usages[0]).toMatchObject({ provider: "deepseek", model: "deepseek-x" });

    // A model whose provider has no key goes to the wire's first keyed provider.
    gw.configure(setup({ wires: { anthropic: { models: [DS], providers: [{ id: "anthropic", key: "sk-ant-test" }] } } }));
    await claude(token, { model: "deepseek-x" });
    expect(seen[1].url).toBe("/v1/messages?beta=true");
    expect(seen[1].headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("passes a stream through as it arrives", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let finished = false;
    handler = async (_req, _body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([["message_start", { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } }]]));
      await held;
      finished = true;
      res.end(sse([["message_delta", { type: "message_delta", usage: { output_tokens: 3 } }]]));
    };
    const r = await claude(gw.open("s-inc", "claude-code"), { model: "claude-haiku-x", stream: true });
    const reader = r.body!.getReader();
    const first = await Promise.race([reader.read(), new Promise<never>((_, no) => setTimeout(() => no(new Error("first chunk was held back")), 3000))]);
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    expect(finished).toBe(false);
    expect(usages).toEqual([]);
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("message_delta");
    expect(usages).toMatchObject([{ inputTokens: 7, outputTokens: 3 }]);
  });

  it("answers 502 for a dead provider and survives an answer that breaks off", async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await shut(dead);
    const lone = new ModelGateway({ onUsage: () => {}, providers: [{ ...catalog[0], baseUrl: `http://127.0.0.1:${deadPort}` }] });
    const port = await lone.start();
    lone.configure(setup());
    const token = lone.open("s-dead", "claude-code");
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-x" }),
      });
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    }
    await lone.stop();

    handler = (_req, _body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([["message_start", { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 1 } } }]]));
      setTimeout(() => res.socket?.destroy(), 20);
    };
    const t = gw.open("s-broken", "claude-code");
    const r = await claude(t, { model: "claude-haiku-x", stream: true });
    await expect(r.text()).rejects.toThrow();
    expect(usages).toMatchObject([{ inputTokens: 9, outputTokens: 1 }]); // what was used up to the break still counts
    handler = messageJson({ input_tokens: 1, output_tokens: 1 });
    expect((await claude(t, { model: "claude-haiku-x" })).status).toBe(200);
  });
});
