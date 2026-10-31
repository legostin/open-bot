// Telegram channel plugin: chat with the assistant, notifications and approvals from the phone.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { TelegramBot } from "./bot.ts";

let bot: TelegramBot | undefined;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const b = new TelegramBot(ctx);
    bot = b;
    ctx.channels.register({
      id: "telegram",
      label: "Telegram",
      send: (message) => b.send(message),
      status: async () => b.channelStatus(),
    });
    ctx.http.handle((req) => b.http(req));
    ctx.events.on("vault.state", (p) => b.onVaultState(p));
    ctx.events.on("vault.updated", (p) => b.onVaultUpdated(p));
    ctx.onSettingsChange((s) => b.updateSettings(s));
    ctx.i18n.onChange(() => b.onLocaleChange());
    await b.start();
  },
  async deactivate() {
    await bot?.stop();
  },
};

export default plugin;
