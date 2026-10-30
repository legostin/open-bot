// UI of the browser plugin: the browser's live view (with takeover) for the host's floating live-view window, and a
// compact renderer for browser_* calls. The backend's "activity" event tells the host when an agent drives the
// browser, so the window opens on its own.
// React and @owlbot/ui come from the host (import map); lucide icons are bundled by scripts/build-ui-plugins.mjs.
// Texts come from .owlbot-plugin/locales (ui.* keys) through ui.i18n.t.

import { definePluginUI } from "@owlbot/ui";
import type { LiveViewActivity } from "@owlbot/ui";
import { BrowserCall } from "./call.tsx";
import { hostOf, send, setHost, t, type Activity } from "./host.ts";
import { BrowserView } from "./view.tsx";

/** What the host shows in the live view's title bar and how it decides when to open the window. */
function toLiveActivity(a: Activity): LiveViewActivity {
  const status = a.attention ? t("ui.activity.captcha") : a.control === "user" ? t("ui.activity.user") : hostOf(a.url);
  return { active: !!a.busy, attention: a.attention, userControl: a.control === "user", agentId: a.agentId ?? undefined, status };
}

export default definePluginUI((ui) => {
  setHost(ui);
  const view = ui.liveView.register({ id: "browser", title: t("ui.view.title"), icon: "globe", component: BrowserView });
  const offs = [
    () => view.dispose(),
    ui.plugin.on("activity", (a: Activity) => view.update(toLiveActivity(a))),
    ui.slots.register("chat.toolResult", { id: "browser-call", match: { tool: ["browser_*", "*__browser_*"] }, component: BrowserCall }),
  ];
  // An agent may already be working in the browser when the page loads.
  send({ type: "activity" });
  return () => offs.forEach((off) => off());
});
