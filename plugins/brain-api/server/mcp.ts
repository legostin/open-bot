// JSON-RPC client for the hub's MCP endpoint (Streamable HTTP, JSON responses): initialize, tools/list, tools/call.

import { request } from "./http.ts";
import { parseSse } from "./sse.ts";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export class McpClient {
  url: string;
  token: string;
  private seq = 0;
  private init?: Promise<void>;
  private protocolVersion = PROTOCOL_VERSION;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "mcp-protocol-version": this.protocolVersion,
    };
  }

  private async post(message: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const res = await request(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal });
    if (res.status === 202 || res.status === 204) {
      await res.text();
      return undefined;
    }
    const ctype = res.headers["content-type"] ?? "";
    if (ctype.includes("text/event-stream")) {
      for await (const ev of parseSse(res.body)) {
        try {
          const m = JSON.parse(ev.data);
          if (m && m.id === message.id) return m;
        } catch {
          /* skip */
        }
      }
      throw new McpError(`MCP: no response to ${String(message.method)}`);
    }
    const text = await res.text();
    if (res.status === 401) throw new McpError("MCP: the hub rejected the session token (401)", 401);
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      throw new McpError(`MCP: malformed response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async rpc<T = any>(method: string, params: unknown, signal?: AbortSignal, id?: string | number): Promise<T> {
    const msg = { jsonrpc: "2.0", id: id ?? `ob_${++this.seq}`, method, params };
    const r = await this.post(msg, signal);
    if (!r) throw new McpError(`MCP: empty response to ${method}`);
    if (r.error) throw new McpError(String(r.error.message ?? "MCP error"), r.error.code);
    return r.result as T;
  }

  private ensureInit(signal?: AbortSignal): Promise<void> {
    if (!this.init) {
      this.init = (async () => {
        const r = await this.rpc<{ protocolVersion?: string }>(
          "initialize",
          { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "openbot-brain-api", version: "0.1.0" } },
          signal,
        );
        if (r?.protocolVersion) this.protocolVersion = r.protocolVersion;
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => {});
      })();
      this.init.catch(() => {
        this.init = undefined;
      });
    }
    return this.init;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.ensureInit(signal);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.rpc<{ tools?: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {}, signal);
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** `id` becomes the JSON-RPC id (the hub derives the audit call id from it). */
  async callTool(name: string, args: unknown, signal?: AbortSignal, id?: string): Promise<McpCallResult> {
    await this.ensureInit(signal);
    const r = await this.rpc<McpCallResult>("tools/call", { name, arguments: args ?? {} }, signal, id);
    return { content: Array.isArray(r?.content) ? r.content : [], isError: r?.isError, _meta: r?._meta };
  }
}
