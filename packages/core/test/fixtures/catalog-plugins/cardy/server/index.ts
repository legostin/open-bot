// A catalog plugin for the tests: its tool shows a declared card, an undeclared one and a too-big one.
import type { PluginContext } from "@owlbot/plugin-sdk";

export default {
  async activate(ctx: PluginContext) {
    ctx.tools.register({
      name: "show",
      description: "Shows cards",
      effect: "read",
      inputSchema: { type: "object", properties: { n: { type: "number" } } },
      handler: async (input, call) => {
        ctx.widgets.show(call, "card", { n: input.n, token: "vault-secret-value" });
        ctx.widgets.show(call, "sneaky", { n: input.n });
        ctx.widgets.show(call, "card", { big: "x".repeat(70_000) });
        return "A card is shown.";
      },
    });
  },
};
