// Registers the "codex" brain (OpenAI Codex CLI on the user's ChatGPT subscription or an API key).

import type { PluginContext, PluginModule } from "@openbot/plugin-sdk";
import { createCodexProvider } from "@openbot/brains-cli";

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings = ctx.settings;
    ctx.onSettingsChange((s) => (settings = s));

    const authEnv = async (): Promise<Record<string, string>> => {
      if (!settings.apiKeyRef) return {};
      try {
        const f = await ctx.vault.get(String(settings.apiKeyRef), { reason: "Codex authentication" });
        const key = f.value ?? Object.values(f)[0];
        return key ? { OPENAI_API_KEY: key.trim() } : {};
      } catch {
        return {};
      }
    };

    ctx.brains.register(
      createCodexProvider({
        command: () => String(settings.command || "codex"),
        authEnv,
        sandbox: () => settings.sandbox || "danger-full-access",
        stateDir: ctx.dataDir,
        log: (m) => ctx.log.info(m),
      }),
    );
  },
};

export default plugin;
