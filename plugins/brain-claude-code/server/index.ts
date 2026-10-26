// Registers the "claude-code" brain (headless Claude Code on the user's subscription).

import type { PluginContext, PluginModule } from "@openbot/plugin-sdk";
import { createClaudeCodeProvider, DEFAULT_CLAUDE_TOOLS } from "@openbot/brains-cli";

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings = ctx.settings;
    ctx.onSettingsChange((s) => (settings = s));
    let cached: { at: number; env: Record<string, string> } | undefined;

    const authEnv = async (): Promise<Record<string, string>> => {
      if (cached && Date.now() - cached.at < 60_000) return cached.env;
      const ref = String(settings.tokenRef || "vault://claude_code_token");
      let env: Record<string, string> = {};
      try {
        const f = await ctx.vault.get(ref, { reason: "Claude Code authentication" });
        const token = f.value ?? f.token ?? f.password ?? Object.values(f)[0];
        if (token) env = { CLAUDE_CODE_OAUTH_TOKEN: token.trim() };
      } catch {
        // No token in the vault (or vault sealed): fall back to the CLI's own login in HOME.
      }
      cached = { at: Date.now(), env };
      return env;
    };

    ctx.brains.register(
      createClaudeCodeProvider({
        command: () => String(settings.command || "claude"),
        authEnv,
        allowedTools: () => (Array.isArray(settings.allowedTools) && settings.allowedTools.length ? settings.allowedTools : DEFAULT_CLAUDE_TOOLS),
        stateDir: ctx.dataDir,
        log: (m) => ctx.log.info(m),
        locale: () => ctx.i18n.locale(),
      }),
    );
  },
};

export default plugin;
