// An integration for the tests: asks the hub for its Google token, adds a section to the digest.
import type { PluginContext } from "@piomio/plugin-sdk";

export default {
  async activate(ctx: PluginContext) {
    ctx.tools.register({
      name: "token",
      description: "The Google access token the hub gives this plugin",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const t = await ctx.core.call<{ accessToken: string; account: string }>("connections.token", { provider: "google" });
          return `token ${t.accessToken} for ${t.account}`;
        } catch (e: any) {
          return `no token: ${e?.message ?? e}`;
        }
      },
    });
    ctx.hooks.on("digest.compose", async (p) => ({ title: "Today", body: `09:00 Standup\n11:00 Lunch (${p.date} ${p.timezone})` }));
  },
};
