// The machine's model gateway: a loopback HTTP server key-mode CLI brains talk to instead of the provider.
// Each session gets its own token; the gateway keeps the model to the allowed list (off-list → the cheapest allowed),
// stops at the spend limit, adds the provider's key, streams the answer through and counts what each call cost.
// The key never reaches the CLI's environment or this machine's disk. Spec: docs/superpowers/specs/2026-10-30-cluster-design.md.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { KEY_PROVIDERS, brainWire, cheapestModel, costOf } from "@piomio/shared";
import type { CallTokens, KeyProvider, KeyWire, MachineBrainId, MachineModel, MachineUsage } from "@piomio/shared";

export interface GatewaySetup {
  wires: Partial<Record<KeyWire, { models: MachineModel[]; providers: Array<{ id: string; key: string }> }>>;
  /** spent: what the hub already counted this period. */
  limit?: { usd: number; spent: number };
}

export interface ModelGatewayOptions {
  onUsage: (u: MachineUsage) => void;
  log?: (m: string) => void;
  /** The provider catalog (tests point base URLs at a fake provider). */
  providers?: readonly KeyProvider[];
  now?: () => Date;
}

/** The paths a CLI may call, per wire: model calls and model lists only, so nothing bypasses the list or the count. */
const PATHS: Record<KeyWire, RegExp> = {
  anthropic: /^\/v1\/(messages(\/count_tokens)?|models(\/[\w:@-][\w.:@-]*)?)$/,
  openai: /^\/v1\/(responses(\/compact)?|models(\/[\w:@-][\w.:@-]*)?)$/,
};

/** Request headers that stay here: hop-by-hop, the CLI's own credentials, what fetch sets itself. */
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "http2-settings",
  "content-length",
  "authorization",
  "x-api-key",
  "accept-encoding",
]);

/** Response headers that stay at the provider: hop-by-hop, and the body's length/encoding (fetch decodes it). */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "content-encoding", "content-length"]);

const MAX_BODY = 64 * 1024 * 1024;
const MAX_JSON_ANSWER = 32 * 1024 * 1024;

const ANTHROPIC_ERRORS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  502: "api_error",
};
const OPENAI_ERRORS: Record<number, { type: string; code: string | null }> = {
  400: { type: "invalid_request_error", code: null },
  401: { type: "invalid_request_error", code: "invalid_api_key" },
  403: { type: "invalid_request_error", code: "permission_denied" },
  404: { type: "invalid_request_error", code: "unknown_url" },
  413: { type: "invalid_request_error", code: "request_too_large" },
  429: { type: "insufficient_quota", code: "insufficient_quota" },
  502: { type: "server_error", code: null },
};

/** An error body in the shape the wire's CLI understands. */
export function wireError(wire: KeyWire, status: number, message: string): string {
  if (wire === "anthropic") return JSON.stringify({ type: "error", error: { type: ANTHROPIC_ERRORS[status] ?? "api_error", message } });
  const e = OPENAI_ERRORS[status] ?? OPENAI_ERRORS[502];
  return JSON.stringify({ error: { message, type: e.type, param: null, code: e.code } });
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

interface Session {
  sessionId: string;
  brainId: MachineBrainId;
}

/** Reads a call's token counts from the answer's bytes as they pass: SSE events or one JSON body. */
class UsageReader {
  private wire: KeyWire;
  private sse: boolean;
  private decoder = new TextDecoder();
  private buf = "";
  private data: string[] = [];
  private json: string[] = [];
  private jsonSize = 0;
  private t: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;

  constructor(wire: KeyWire, contentType: string) {
    this.wire = wire;
    this.sse = contentType.includes("text/event-stream");
  }

  push(chunk: Uint8Array): void {
    this.text(this.decoder.decode(chunk, { stream: true }));
  }

  /** The tokens seen, once the answer is over (or cut off); undefined when the answer carried no usage. */
  end(): CallTokens | undefined {
    this.text(this.decoder.decode());
    if (this.sse) {
      if (this.buf) this.line(this.buf);
      this.line("");
    } else if (this.jsonSize <= MAX_JSON_ANSWER) {
      try {
        const body = JSON.parse(this.json.join(""));
        if (body?.usage && typeof body.usage === "object") this.usage(body.usage, false);
      } catch {
        /* not JSON: no usage */
      }
    }
    return this.t;
  }

  private text(text: string): void {
    if (!text) return;
    if (!this.sse) {
      this.jsonSize += text.length;
      if (this.jsonSize <= MAX_JSON_ANSWER) this.json.push(text);
      return;
    }
    // Scan only the new text for line ends: a long data line arriving in pieces stays linear.
    let from = this.buf.length;
    this.buf += text;
    let start = 0;
    let nl: number;
    while ((nl = this.buf.indexOf("\n", from)) >= 0) {
      this.line(this.buf.slice(start, nl > start && this.buf[nl - 1] === "\r" ? nl - 1 : nl));
      start = from = nl + 1;
    }
    this.buf = this.buf.slice(start);
  }

  private line(line: string): void {
    if (line === "") {
      const data = this.data.join("\n");
      this.data = [];
      if (data.includes('"usage"')) this.event(data);
    } else if (line.startsWith("data:")) {
      this.data.push(line.slice(line[5] === " " ? 6 : 5));
    }
  }

  private event(data: string): void {
    let e: any;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (this.wire === "anthropic") {
      if (e?.type === "message_start" && e.message?.usage) this.usage(e.message.usage, true);
      else if (e?.type === "message_delta" && e.usage) this.usage(e.usage, true);
    } else if (e?.response?.usage && typeof e.response.usage === "object") {
      // response.completed, also .incomplete / .failed: the provider bills those too.
      this.usage(e.response.usage, false);
    }
  }

  /** Anthropic stream counts are cumulative and may arrive in either event, so each field keeps its largest value. */
  private usage(u: any, cumulative: boolean): void {
    const next =
      this.wire === "anthropic"
        ? { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) }
        : (() => {
            const cached = num(u.input_tokens_details?.cached_tokens);
            return { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cacheRead: cached, cacheWrite: 0 };
          })();
    const t = this.t;
    this.t =
      cumulative && t
        ? { input: Math.max(t.input, next.input), output: Math.max(t.output, next.output), cacheRead: Math.max(t.cacheRead, next.cacheRead), cacheWrite: Math.max(t.cacheWrite, next.cacheWrite) }
        : next;
  }
}

export class ModelGateway {
  private o: ModelGatewayOptions;
  private server: Server | undefined;
  private setup: GatewaySetup = { wires: {} };
  private total = 0;
  private tokens = new Map<string, Session>();
  private bySession = new Map<string, string>();
  private inflight = new Set<AbortController>();

  constructor(o: ModelGatewayOptions) {
    this.o = o;
  }

  /** Listens on 127.0.0.1 at a random port; resolves with the port. */
  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.port);
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.o.log?.(`gateway: ${e?.message ?? e}`);
        if (!res.headersSent) this.fail(res, guessWire(req), 502, "The model gateway failed on this request");
        else res.destroy();
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(this.port);
      });
    });
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === "object" ? (a as AddressInfo).port : 0;
  }

  /** The allowed models, the keys and the limit; `limit.spent` resets the running total to the hub's figure. */
  configure(setup: GatewaySetup): void {
    this.setup = setup;
    if (setup.limit) this.total = setup.limit.spent;
  }

  /** A fresh token for a session (replacing any it had): the CLI's API key. */
  open(sessionId: string, brainId: MachineBrainId): string {
    this.close(sessionId);
    const token = `owlgw-${randomBytes(32).toString("base64url")}`;
    this.tokens.set(token, { sessionId, brainId });
    this.bySession.set(sessionId, token);
    return token;
  }

  close(sessionId: string): void {
    const token = this.bySession.get(sessionId);
    if (token === undefined) return;
    this.bySession.delete(sessionId);
    this.tokens.delete(token);
  }

  /** Dollars spent this period: the hub's figure plus what passed through since. */
  spent(): number {
    return this.total;
  }

  async stop(): Promise<void> {
    for (const a of this.inflight) a.abort();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private fail(res: ServerResponse, wire: KeyWire, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(wireError(wire, status, message));
  }

  private session(req: IncomingMessage): Session | undefined {
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : undefined;
    const key = req.headers["x-api-key"];
    for (const t of [typeof key === "string" ? key.trim() : undefined, bearer]) {
      const s = t ? this.tokens.get(t) : undefined;
      if (s) return s;
    }
    return undefined;
  }

  private catalog(): readonly KeyProvider[] {
    return this.o.providers ?? KEY_PROVIDERS;
  }

  /** The provider for a model: its own if keyed, else the wire's first keyed one. */
  private provider(wire: KeyWire, providers: Array<{ id: string; key: string }>, preferred?: string): { p: KeyProvider; key: string } | undefined {
    const keyed = providers
      .filter((k) => typeof k.key === "string" && k.key !== "")
      .map((k) => ({ p: this.catalog().find((p) => p.id === k.id && p.wire === wire), key: k.key }))
      .filter((k): k is { p: KeyProvider; key: string } => !!k.p);
    return (preferred ? keyed.find((k) => k.p.id === preferred) : undefined) ?? keyed[0];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.session(req);
    if (!session) {
      req.resume();
      return this.fail(res, guessWire(req), 401, "Unknown or closed session token for this machine's model gateway");
    }
    const { brainId } = session;
    const wire = brainWire(brainId);
    const url = new URL(req.url ?? "/", "http://gateway");
    if (!PATHS[wire].test(url.pathname)) {
      req.resume();
      return this.fail(res, wire, 404, `The model gateway does not serve ${req.method} ${url.pathname}`);
    }
    const setup = this.setup;
    const limit = setup.limit;
    if (limit && this.total >= limit.usd) {
      req.resume();
      return this.fail(res, wire, 429, `Spend limit reached on this machine: ${usd(this.total)} of ${usd(limit.usd)}`);
    }
    const cfg = setup.wires[wire];
    const allowed = cfg?.models ?? [];
    if (!allowed.length) {
      req.resume();
      return this.fail(res, wire, 403, `No models are allowed for ${brainId} on this machine: set them up in the hub`);
    }
    const keys = cfg?.providers ?? [];
    if (!this.provider(wire, keys)) {
      req.resume();
      return this.fail(res, wire, 403, `No provider key for ${brainId} on this machine: add one in the hub`);
    }

    let body = await readBody(req);
    if (body === undefined) return this.fail(res, wire, 413, "The request is too large for the model gateway");

    // The model: an allowed one passes, anything else becomes the cheapest allowed one.
    let model: MachineModel | undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && body.length) {
      let json: any;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        return this.fail(res, wire, 400, "The model gateway takes JSON request bodies only");
      }
      if (json && typeof json === "object" && !Array.isArray(json)) {
        const asked = typeof json.model === "string" ? json.model : undefined;
        model = allowed.find((m) => m.id === asked);
        if (!model) {
          model = cheapestModel(allowed)!;
          this.o.log?.(`model ${asked ?? "(none)"} → ${model.id}`);
          json.model = model.id;
          body = Buffer.from(JSON.stringify(json));
        }
      }
    }
    const chosen = this.provider(wire, keys, model?.provider)!;

    const path = wire === "openai" ? url.pathname.replace(/^\/v1(?=\/|$)/, "") : url.pathname;
    const target = `${chosen.p.baseUrl}${path}${url.search}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQUEST.has(k)) continue;
      for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
    }
    headers.set("accept-encoding", "identity");
    if (chosen.p.auth === "x-api-key") headers.set("x-api-key", chosen.key);
    else headers.set("authorization", `Bearer ${chosen.key}`);

    const abort = new AbortController();
    this.inflight.add(abort);
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      let answer: Response;
      try {
        answer = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          redirect: "manual",
          signal: abort.signal,
        });
      } catch (e: any) {
        if (abort.signal.aborted) return;
        this.o.log?.(`gateway: ${chosen.p.id} unreachable: ${e?.cause?.message ?? e?.message ?? e}`);
        return this.fail(res, wire, 502, `The model provider (${chosen.p.label}) could not be reached`);
      }

      const out: Record<string, string | string[]> = {};
      for (const [k, v] of answer.headers) if (!DROP_RESPONSE.has(k) && k !== "set-cookie") out[k] = v;
      const cookies = answer.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(answer.status, out);
      res.flushHeaders();

      const counted = model && req.method === "POST" && !url.pathname.endsWith("/count_tokens");
      const reader = counted ? new UsageReader(wire, answer.headers.get("content-type") ?? "") : undefined;
      let broken = false;
      if (answer.body) {
        const r = answer.body.getReader();
        try {
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            reader?.push(value);
            if (res.destroyed) break;
            if (!res.write(value)) await drained(res);
          }
        } catch (e: any) {
          broken = true;
          if (!abort.signal.aborted) this.o.log?.(`gateway: ${chosen.p.id} answer broke off: ${e?.cause?.message ?? e?.message ?? e}`);
        } finally {
          r.cancel().catch(() => {});
        }
      }
      // Counted before the CLI sees the end, so the next call already meets the new total.
      if (reader && model) this.count(session, chosen.p.id, model, reader.end());
      if (broken || res.destroyed) res.destroy();
      else res.end();
    } finally {
      this.inflight.delete(abort);
    }
  }

  /** One call's tokens, priced at the (final) model's price: added to the running total and reported. */
  private count(s: Session, provider: string, model: MachineModel, t: CallTokens | undefined): void {
    if (!t) return;
    const cost = costOf(t, model.price);
    this.total = Math.round((this.total + cost) * 1e6) / 1e6;
    try {
      this.o.onUsage({
        brainId: s.brainId,
        provider,
        model: model.id,
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
        usd: cost,
        at: (this.o.now ?? (() => new Date()))().toISOString(),
      });
    } catch (e: any) {
      this.o.log?.(`gateway: usage report failed: ${e?.message ?? e}`);
    }
  }
}

/** Without a valid token the brain is unknown: Claude Code's requests carry anthropic-version, Codex's do not. */
function guessWire(req: IncomingMessage): KeyWire {
  return req.headers["anthropic-version"] || (req.url ?? "").startsWith("/v1/messages") ? "anthropic" : "openai";
}

/** The whole request body; undefined when it is over the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Waits until the CLI took the bytes, or went away. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve();
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}
