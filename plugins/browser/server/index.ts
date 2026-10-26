// Builtin browser plugin: Playwright Chromium with a persistent profile, agent tools, live view and user takeover.

import type { PluginContext, PluginModule } from "@openbot/plugin-sdk";
import { BrowserManager } from "./manager.ts";
import { registerTools } from "./tools.ts";

let manager: BrowserManager | null = null;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    // The browser itself starts lazily on the first tool call (or when the user opens it in the panel).
    const mgr = new BrowserManager(ctx);
    manager = mgr;
    // Outside Docker Playwright's Chromium may be missing: download it now in the background, so the first
    // browser call does not wait for all of it (calls during the install wait for it).
    mgr.installer.check();
    registerTools(ctx, mgr);
    ctx.ui.onMessage((m) => mgr.onUiMessage(m));
    ctx.onSettingsChange((s) => mgr.updateSettings(s));
  },
  async deactivate() {
    await manager?.dispose();
    manager = null;
  },
};

export default plugin;
