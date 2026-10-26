// The hub's MCP endpoint (Streamable HTTP, JSON responses only). Every brain session talks to it with its
// own bearer token; tool calls go through the ToolGateway (policy, approvals, audit, redaction).

import type { ToolDescriptor } from "@owlbot/shared";
import type { ToolGateway } from "../tools/gateway.ts";
import type { Store, SessionRow } from "../store.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2025-11-25"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export function toMcpTool(t: ToolDescriptor) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema?.type ? t.inputSchema : { type: "object", properties: {}, ...(t.inputSchema ?? {}) },
    annotations: {
      readOnlyHint: t.effect === "read",
      destructiveHint: t.effect === "external",
      openWorldHint: !!t.source || t.effect === "external",
    },
  };
}

export class McpEndpoint {
  gateway: ToolGateway;
  store: Store;
  version: string;
  constructor(gateway: ToolGateway, store: Store, version: string) {
    this.gateway = gateway;
    this.store = store;
    this.version = version;
  }

  authenticate(authorization: string | undefined): SessionRow | undefined {
    const m = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    return m ? this.store.sessionByToken(m[1].trim()) : undefined;
  }

  /** Handle a POSTed JSON-RPC message or batch. Returns undefined when nothing should be sent (notifications only). */
  async handle(session: SessionRow, body: unknown): Promise<unknown | undefined> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.one(session, m)))).filter((r) => r !== undefined);
      return out.length ? out : undefined;
    }
    return this.one(session, body);
  }

  private async one(session: SessionRow, raw: unknown): Promise<unknown | undefined> {
    const msg = raw as JsonRpcRequest;
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      // Responses from the client (we never send requests) and garbage are ignored.
      return undefined;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const reply = (result: unknown) => (isNotification ? undefined : { jsonrpc: "2.0", id: msg.id, result });
    const error = (code: number, message: string) => (isNotification ? undefined : { jsonrpc: "2.0", id: msg.id, error: { code, message } });

    try {
      switch (msg.method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "owlbot", version: this.version },
            instructions: "Owlbot platform tools. Approval-gated tools may return status awaiting_approval: do not retry them.",
          });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return undefined;
        case "ping":
          return reply({});
        case "tools/list": {
          const fresh = this.store.getSession(session.id) ?? session;
          return reply({ tools: this.gateway.listFor(fresh).map(toMcpTool) });
        }
        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          const args = msg.params?.arguments ?? {};
          const result = await this.gateway.call(session.id, name, args, msg.id !== undefined && msg.id !== null ? `mcp_${msg.id}` : undefined);
          return reply(result);
        }
        case "resources/list":
          return reply({ resources: [] });
        case "prompts/list":
          return reply({ prompts: [] });
        default:
          return error(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e: any) {
      return error(-32603, e?.message ?? "internal error");
    }
  }
}
