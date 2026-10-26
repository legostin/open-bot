// Scriptable brain for core integration tests.
// "CALL <tool> <json>" calls a hub tool over MCP; "LIMIT" makes brain `fake` hit its limit.
import type { PluginContext } from "@openbot/plugin-sdk";
import type { BrainEvent, BrainSessionOptions } from "@openbot/shared";

async function mcpCall(o: BrainSessionOptions, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const r = await fetch(o.mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${o.mcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.error) return { text: j.error.message, isError: true };
  return { text: (j.result.content ?? []).map((c: any) => c.text ?? "").join("\n"), isError: !!j.result.isError };
}

export default {
  async activate(ctx: PluginContext) {
    ctx.tools.register({
      name: "send",
      description: "Send a message somewhere (external effect)",
      effect: "external",
      approvalSummary: "Отправить {text}",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: async (input: { text: string }) => `sent: ${input.text}`,
    });
    for (const id of ["fake", "fake2"]) {
      ctx.brains.register({
        id,
        label: id,
        probe: async () => ({ available: true, authenticated: true }),
        createSession: async (o: BrainSessionOptions) => ({
          async *send(turn): AsyncGenerator<BrainEvent> {
            if (id === "fake" && turn.text.includes("LIMIT")) {
              yield { type: "limit_hit", resetAt: new Date(Date.now() + 3600_000).toISOString(), detail: "fake limit" };
              yield { type: "done" };
              return;
            }
            const m = /CALL (\S+) (\{.*\})/.exec(turn.text);
            if (m && !turn.text.includes("[Система]")) {
              yield { type: "tool_call", id: "c1", name: m[1], input: JSON.parse(m[2]) };
              const r = await mcpCall(o, m[1], JSON.parse(m[2]));
              yield { type: "tool_result", id: "c1", output: r.text, isError: r.isError };
              yield { type: "text", delta: `tool said: ${r.text}` };
            } else {
              const last = turn.text.trim().split("\n").at(-1);
              yield { type: "text", delta: `${id} heard: ${last}` };
            }
            yield { type: "done", resumeToken: `${id}-resume` };
          },
          interrupt() {},
          close() {},
        }),
      });
    }
  },
};
