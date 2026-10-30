// The integrations library and the catalog: plugins whose manifest has an `integration` block, as cards with a live
// status. `google` ones depend on the hub's Google connection, `setup` ones on their setup card (secrets, channels),
// `none` ones only on being enabled. The core adds its own card first: access from anywhere (`remote`, remote.ts).
// The catalog groups the same cards by the situation in life they help with; the Plugins panel's catalog (`all`) has
// every plugin in it, those without an `integration` block as plain entries (a brain, or "other").

import type { CatalogView, IntegrationInfo, IntegrationView, Locale, OwlbotManifest } from "@owlbot/shared";
import type { Hub } from "./app.ts";
import { localizePluginValue, tFor } from "./i18n.ts";

/** The catalog's groups, in order: situations in life, the assistant's own abilities, brains. "other" collects the rest. */
export const SITUATIONS = ["everyday", "travel", "money", "work", "reading", "communication", "home", "assistant", "brains", "other"] as const;
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

/** How a plugin without an `integration` block shows in the catalog: as a brain, or as something else. */
function plainIntegration(m: OwlbotManifest): IntegrationInfo {
  const brain = m.contributes.brains.length > 0;
  return { category: brain ? "brains" : "other", icon: brain ? "brain" : "puzzle", connect: m.contributes.setup?.secrets.length ? "setup" : "none", scopes: [] };
}

/** The library's cards; with `all`, every plugin (the Plugins panel's catalog), not only those with an `integration` block. */
export async function listIntegrations(hub: Hub, locale: Locale, opts: { all?: boolean } = {}): Promise<IntegrationView[]> {
  const t = tFor(locale);
  const views: IntegrationView[] = [remoteIntegration(hub, locale)];
  for (const r of hub.plugins.list()) {
    if (!r.layout) continue;
    const integ = r.layout.manifest.integration ?? (opts.all ? plainIntegration(r.layout.manifest) : undefined);
    if (!integ) continue;
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
    // Its MCP servers: one that failed to start says why; a sign-in is connected once every server of the plugin is.
    const servers = r.enabled ? hub.mcpClients.list().filter((s) => s.source === r.id) : [];
    const failed = servers.find((s) => s.status === "error");
    if (failed && view.status !== "unavailable") Object.assign(view, { status: "broken", ...(failed.error ? { detail: failed.error } : {}) });
    else if (integ.connect === "signin" && r.enabled && (!servers.length || servers.some((s) => s.status !== "connected"))) view.status = "needs-setup";
    // Its process fell over: broken, whatever its connection says.
    if (r.enabled && (r.status === "crashed" || r.status === "error") && view.status !== "unavailable")
      Object.assign(view, { status: "broken", ...(r.lastError ? { detail: r.lastError } : {}) });
    views.push(view);
  }
  const rank = (c: string) => SITUATIONS.indexOf(situationOf(c));
  return views.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, locale));
}

const POPULAR_MAX = 6;
const POPULAR_DAYS = 30;

/**
 * The catalog's popular entries, most popular first: those whose tools the agents called most in the last 30 days,
 * then the built-in plugins' own picks (`integration.popular`). An installed plugin cannot name itself popular.
 */
export function popularIds(hub: Hub, views: IntegrationView[], now = new Date()): string[] {
  const since = new Date(now.getTime() - POPULAR_DAYS * 86_400_000).toISOString();
  const owners = new Map(hub.tools.list().map((d) => [d.name, d.owner]));
  // A plugin that is off has no tools registered: its earlier calls are matched by its tool prefix.
  const prefixes = hub.plugins
    .list()
    .flatMap((r) => (r.layout ? [{ id: r.id, prefix: `${r.layout.manifest.toolPrefix ?? r.id.replace(/-/g, "_")}_` }] : []))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const uses = new Map<string, number>();
  for (const [tool, n] of hub.audit.countByTarget("policy.decision", since)) {
    const id = owners.get(tool) ?? prefixes.find((p) => tool.startsWith(p.prefix))?.id;
    if (id) uses.set(id, (uses.get(id) ?? 0) + n);
  }
  const pick = (id: string) => {
    const r = hub.plugins.get(id);
    return (r?.source === "builtin" ? r.layout?.manifest.integration?.popular : undefined) ?? Infinity;
  };
  return views
    .filter((v) => v.status !== "unavailable" && ((uses.get(v.id) ?? 0) > 0 || pick(v.id) < Infinity))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || pick(a.id) - pick(b.id))
    .slice(0, POPULAR_MAX)
    .map((v) => v.id);
}

/** The catalog: every card, grouped by situation in life (empty groups left out), with the groups' titles. */
export async function listCatalog(hub: Hub, locale: Locale, opts: { all?: boolean } = {}): Promise<CatalogView> {
  const t = tFor(locale);
  const views = await listIntegrations(hub, locale, opts);
  const sections = SITUATIONS.map((id) => ({ id, title: t(`catalog.section.${id}`), items: views.filter((v) => situationOf(v.category) === id) }));
  return { popular: popularIds(hub, views), sections: sections.filter((s) => s.items.length) };
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
