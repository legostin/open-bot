// The real Codex brain on the fake CLI (packages/brains-cli/test/fixtures/fake-codex.mjs): sign-in from the chat.
import { join } from "node:path";
import type { PluginContext } from "@piomio/plugin-sdk";
import { createCodexProvider } from "@piomio/brains-cli";

export default {
  activate(ctx: PluginContext) {
    ctx.brains.register(
      createCodexProvider({
        command: () => join(ctx.appRoot, "packages", "brains-cli", "test", "fixtures", "fake-codex.mjs"),
        stateDir: ctx.dataDir,
        locale: () => ctx.i18n.locale(),
      }),
    );
  },
};
