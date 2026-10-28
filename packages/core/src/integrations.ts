// The integrations library and the catalog: plugins whose manifest has an `integration` block, as cards with a live
// status. `google` ones depend on the hub's Google connection, `setup` ones on their setup card (secrets, channels),
// `none` ones only on being enabled. The core adds its own card first: access from anywhere (`remote`, remote.ts).
// The catalog groups the same cards by the situation in life they help with.

import type { CatalogView, IntegrationView, Locale } from "@owlbot/shared";
import type { Hub } from "./app.ts";
import { localizePluginValue, tFor } from "./i18n.ts";

/** The catalog's groups, in order: situations in life. "other" collects what fits none. */
export const SITUATIONS = ["everyday", "travel", "money", "work", "reading", "communication", "home", "other"] as const;
export type Situation = (typeof SITUATIONS)[number];

/** Categories of manifests written before the catalog, by the situation they belong to. */
const LEGACY_CATEGORY: Record<string, Situation> = {
  access: "communication",
  calendar: "work",
  mail: "communication",
  messaging: "communication",
  search: "reading",
  browser: "work",
  files: "work",
};

/** The catalog group of a manifest's category. */
export function situationOf(category: string): Situation {
  return (SITUATIONS as readonly string[]).includes(category) ? (category as Situation) : (LEGACY_CATEGORY[category] ?? "other");
}

/** The scopes every enabled Google integration needs: one sign-in covers them all. */
export function googleScopes(hub: Hub): string[] {
  const out = new Set<string>();
  for (const r of hub.plugins.list()) {
    const i = r.layout?.manifest.integration;
    if (i?.connect === "google" && r.enabled) for (const s of i.scopes) out.add(s);
  }
  return [...out];
}

export async function listIntegrations(hub: Hub, locale: Locale): Promise<IntegrationView[]> {
  const t = tFor(locale);
  const views: IntegrationView[] = [remoteIntegration(hub, locale)];
  for (const r of hub.plugins.list()) {
    const integ = r.layout?.manifest.integration;
    if (!integ || !r.layout) continue;
    const view: IntegrationView = {
      id: r.id,
      name: localizePluginValue(r.layout, r.layout.manifest.name, locale),
      summary: localizePluginValue(r.layout, integ.summary ?? r.layout.manifest.description, locale),
      category: situationOf(integ.category),
      icon: integ.icon,
      connect: integ.connect,
      status: "connected",
      ...(integ.example ? { example: localizePluginValue(r.layout, integ.example, locale) } : {}),
    };
    if (!r.enabled) view.status = "off";
    else if (integ.connect === "google") {
      const acc = hub.connections.get("google");
      if (!hub.connections.available("google")) Object.assign(view, { status: "unavailable", detail: t("connections.unavailable") });
      else if (!acc) view.status = "needs-setup";
      else if (acc.broken) Object.assign(view, { status: "broken", account: acc.account });
      // A sign-in from before this integration was added lacks its scopes: connect again to grant them.
      else if (!integ.scopes.every((s) => acc.scopes.includes(s))) Object.assign(view, { status: "needs-setup", account: acc.account });
      else view.account = acc.account;
    } else if (integ.connect === "setup") {
      const setup = hub.secrets.setupView(r.id, locale);
      const channels = await Promise.all(hub.channels.list().filter((c) => c.pluginId === r.id).map((c) => hub.channels.status(c.id)));
      const missing = setup.secrets.some((s) => s.required && !s.present);
      const down = channels.find((c) => !c.connected);
      if (missing || down) Object.assign(view, { status: "needs-setup", ...(down?.detail ? { detail: down.detail } : {}) });
      else if (channels[0]?.detail) view.account = channels[0].detail;
    }
    views.push(view);
  }
  const rank = (c: string) => SITUATIONS.indexOf(situationOf(c));
  return views.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, locale));
}

/** The catalog: every card, grouped by situation in life (empty groups left out), with the groups' titles. */
export async function listCatalog(hub: Hub, locale: Locale): Promise<CatalogView> {
  const t = tFor(locale);
  const views = await listIntegrations(hub, locale);
  const sections = SITUATIONS.map((id) => ({ id, title: t(`catalog.section.${id}`), items: views.filter((v) => situationOf(v.category) === id) }));
  return { sections: sections.filter((s) => s.items.length) };
}

/** The core's card: the hub's Tailscale node and its link. */
function remoteIntegration(hub: Hub, locale: Locale): IntegrationView {
  const t = tFor(locale);
  const r = hub.remote.view(locale);
  const view: IntegrationView = {
    id: "remote-access",
    name: t("remote.name"),
    summary: t("remote.summary"),
    category: "communication",
    icon: "globe",
    connect: "remote",
    status: "connected",
  };
  if (!r.available) return { ...view, status: "unavailable", ...(r.error ? { detail: r.error } : {}) };
  if (!r.enabled) return { ...view, status: "off" };
  if (r.state === "running") return { ...view, ...(r.url ? { account: r.url } : {}) };
  if (r.state === "error") return { ...view, status: "broken", ...(r.error ? { detail: r.error } : {}) };
  const step = r.state === "needs-login" ? t("remote.stepLogin") : r.state === "needs-funnel" ? t("remote.stepFunnel") : t("remote.starting");
  return { ...view, status: "needs-setup", detail: r.error ?? step };
}
