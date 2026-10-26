// Tiny stand-in for the hub's MCP endpoint: JSON-RPC over POST, one "echo" tool.

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakeMcp {
  url: string;
  token: string;
  calls: Array<{ method: string; params: any; id: unknown; auth?: string }>;
  /** Returned by tools/list; tests may change it. */
  tools: any[];
  close(): Promise<void>;
}

export const ECHO_TOOL = {
  name: "echo",
  description: "Echo the text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: { readOnlyHint: true },
};

export async function startFakeMcp(token = "mcp-test-token"): Promise<FakeMcp> {
  const calls: FakeMcp["calls"] = [];
  const state = { tools: [ECHO_TOOL] as any[] };
  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const msg = JSON.parse(raw || "{}");
    calls.push({ method: msg.method, params: msg.params, id: msg.id, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid session token" } }));
      return;
    }
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "tools/list":
        return reply({ tools: state.tools });
      case "tools/call":
        return reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] });
      default:
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    get tools() {
      return state.tools;
    },
    set tools(t: any[]) {
      state.tools = t;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
