import type { PluginContext } from "@owlbot/plugin-sdk";

export default {
  async activate(ctx: PluginContext) {
    ctx.tools.register({
      name: "say",
      description: "Echo text back",
      effect: "read",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: async (input: { text: string }) => {
        const secret = await ctx.vault.get("vault://demo");
        await ctx.core.call("notify", { level: "silent", title: input.text });
        return `echo: ${input.text} (${secret.value.length})`;
      },
    });
    ctx.http.handle((req) => ({ status: 200, body: { path: req.path } }));
    ctx.brains.register({
      id: "echo",
      label: "Echo brain",
      probe: async () => ({ available: true, authenticated: true }),
      createSession: async () => ({
        async *send(turn) {
          yield { type: "text", delta: `you said: ${turn.text}` };
          yield { type: "done", resumeToken: "r1" };
        },
        interrupt() {},
        close() {},
      }),
    });
  },
};
