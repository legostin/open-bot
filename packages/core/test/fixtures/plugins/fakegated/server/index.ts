// A brain that is signed in only while the file HOME/.gated-ok exists (HOME is the hub's agent home): the setup tests
// sign it in and out by writing that file. "CALL <tool> <json>" calls a hub tool; "SETUP?" says whether the system
// prompt has the hub setup section; anything else is echoed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@owlbot/plugin-sdk";
import type { BrainEvent, BrainSessionOptions } from "@owlbot/shared";

const signedIn = () => existsSync(join(process.env.HOME ?? "", ".gated-ok"));

async function mcpCall(o: BrainSessionOptions, name: string, args: unknown): Promise<string> {
  const r = await fetch(o.mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${o.mcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  return j.error ? j.error.message : (j.result.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

export default {
  activate(ctx: PluginContext) {
    ctx.brains.register({
      id: "gated",
      label: "Gated",
      probe: async () => ({ available: true, authenticated: signedIn(), detail: signedIn() ? "signed in" : "not signed in" }),
      createSession: async (o: BrainSessionOptions) => ({
        async *send(raw): AsyncGenerator<BrainEvent> {
          const turn = { ...raw, text: raw.text.replace(/^\[Now: [^\]]*\]\n/, "") };
          const last = turn.text.trim().split("\n").at(-1) ?? "";
          const m = /^CALL (\S+) (\{.*\})$/.exec(last);
          if (m) yield { type: "text", delta: `tool said: ${await mcpCall(o, m[1], JSON.parse(m[2]))}` };
          else if (last === "SETUP?") yield { type: "text", delta: `setup section: ${o.systemPrompt.includes("## Hub setup") ? "yes" : "no"}` };
          else yield { type: "text", delta: `gated heard: ${turn.text.trim().split("\n").filter(Boolean).join(" | ")}` };
          yield { type: "done" };
        },
        interrupt() {},
        close() {},
      }),
    });
  },
};
