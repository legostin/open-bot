// The Composio integration: Slack, GitHub, Google, HubSpot, Dropbox, Box (the manifest's entries) and any other of
// Composio's apps the agent adds from the chat, each a catalog entry "composio:<app>" with Composio's badge. Composio
// is an outside service: it signs in with its own OAuth apps and keeps the accounts' tokens; the hub keeps only the
// Composio key (vault://composio).
//
// Sign-in: an auth config with Composio's own OAuth app (made once per app), a link the person opens, then the plugin
// polls the connected account until it works (nothing has to come back to the hub, so a phone can sign in too).
// A connected app's main tools become tools of their own (composio_slack_send_message…): a read only when Composio
// tags it readOnlyHint, every other one asks; composio_tools_search / composio_tool_run reach the rest.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import type { CatalogEntryState, ToolResult } from "@owlbot/shared";
import { ComposioError, composioApi, DEFAULT_API } from "./api.ts";
import { effectOf, resultText, specOf, toolName } from "./tools.ts";

interface Settings {
  /** Composio's API (tests point it at a fake). */
  apiUrl?: string;
  /** How often a sign-in in progress is checked, in ms. */
  pollMs?: number;
}

/** What the plugin keeps about one app. */
interface App {
  /** Composio's auth config with its own OAuth app, made at the first sign-in. */
  authConfigId?: string;
  /** The connected account that works (or last did), and its status at Composio. */
  accountId?: string;
  status?: string;
  /** A sign-in in progress: the account its link made. */
  pending?: string;
  /** An app added from the chat (not one of the manifest's): its name. */
  added?: { name: string };
}

/** Main tools one app gets as tools of its own, at most. */
const MAX_TOOLS = 30;
/** How long a sign-in link is waited for when Composio does not say. */
const LINK_MS = 10 * 60_000;
const PENDING = new Set(["INITIATED", "INITIALIZING"]);
const APP_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** The manifest's entries: the apps that are in the catalog from the start. */
function manifestApps(pluginDir: string): Array<{ id: string; name: string }> {
  const m = JSON.parse(readFileSync(join(pluginDir, ".owlbot-plugin", "plugin.json"), "utf8"));
  return (m?.integration?.entries ?? []).map((e: any) => ({ id: String(e.id), name: String(e.name) }));
}

const plugin: PluginModule & { stop?: () => void } = {
  async activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const known = manifestApps(ctx.pluginDir);
    const apps: Record<string, App> = (await ctx.storage.get<Record<string, App>>("apps")) ?? {};
    let userId = await ctx.storage.get<string>("userId");
    if (!userId) {
      // The hub is one person: one Composio user, whatever its machines.
      userId = `owlbot-${randomUUID()}`;
      await ctx.storage.set("userId", userId);
    }
    const user = userId;
    /** missing: no key in the vault; rejected: Composio refused the one there. */
    let keyState: "missing" | "ok" | "rejected" = "missing";
    const registered = new Map<string, string[]>();
    const polls = new Map<string, ReturnType<typeof setTimeout>>();

    const key = async () => {
      const item = await ctx.vault.get("vault://composio", { reason: "Composio" });
      return item.value ?? item.password ?? item.token ?? Object.values(item)[0] ?? "";
    };
    const hasKey = () => key().then((k) => !!k, () => false);
    const api = () => composioApi(settings.apiUrl || DEFAULT_API, key);
    const save = () => ctx.storage.set("apps", apps);
    const isKnown = (app: string) => known.some((e) => e.id === app);
    const nameOf = (app: string) => known.find((e) => e.id === app)?.name ?? apps[app]?.added?.name ?? app;
    const ids = () => [...known.map((e) => e.id), ...Object.keys(apps).filter((a) => apps[a]!.added && !isKnown(a))];
    const connected = () => ids().filter((a) => apps[a]?.accountId && apps[a]!.status === "ACTIVE");

    function stateOf(app: string): CatalogEntryState {
      const a = apps[app];
      const look = a?.added && !isKnown(app) ? { name: a.added.name, summary: "%entry.added%", category: "other", icon: "plug" } : {};
      const base = { id: app, ...look };
      if (keyState === "missing") return { ...base, status: "needs-setup", connect: "setup" };
      if (keyState === "rejected") return { ...base, status: "broken", connect: "setup", detail: "%detail.key%" };
      if (a?.accountId && a.status === "ACTIVE") return { ...base, status: "connected", connect: "signin" };
      if (a?.pending && polls.has(app)) return { ...base, status: "needs-setup", connect: "signin", detail: "%detail.waiting%" };
      if (a?.accountId && a.status && !PENDING.has(a.status)) return { ...base, status: "broken", connect: "signin", detail: "%detail.expired%" };
      return { ...base, status: "needs-setup", connect: "signin" };
    }
    const report = () => ctx.catalog.update(ids().map(stateOf));

    /** What the agent hears about a failed request; a refused key also turns every entry to its key step. */
    function failure(e: unknown): ToolResult {
      if (e instanceof ComposioError) {
        if (e.kind === "key") {
          keyState = "rejected";
          report();
          return text("Composio refused its API key (it may have been revoked): the user stores a new one on the card (hub_integration_connect id composio).", true);
        }
        if (e.kind === "limit") return text(`Composio's limit of calls is used up (${e.message}). Tell the user: it resets next month, or their Composio plan can be raised.`, true);
        if (e.kind === "down") return text(`Composio is unreachable right now (${e.message}); try again later.`, true);
        return text(`Composio: ${e.message}`, true);
      }
      return text(`Error: ${(e as Error)?.message ?? String(e)}`, true);
    }

    function unregisterTools(app: string) {
      for (const n of registered.get(app) ?? []) ctx.tools.unregister(n);
      registered.delete(app);
    }

    /** A connected app's main tools as tools of their own (its first ones when Composio marks none as main). */
    async function registerTools(app: string) {
      let list = await api().tools(app, { important: true, limit: MAX_TOOLS });
      if (!list.length) list = await api().tools(app, { limit: 20 });
      unregisterTools(app);
      const names: string[] = [];
      for (const tool of list.slice(0, MAX_TOOLS)) {
        const spec = specOf(tool, nameOf(app));
        ctx.tools.register({ ...spec, handler: (input) => run(app, tool.slug, tool.version, input) });
        names.push(spec.name);
      }
      registered.set(app, names);
    }

    async function run(app: string, slug: string, version: string | undefined, input: unknown): Promise<ToolResult> {
      const a = apps[app];
      if (!a?.accountId || a.status !== "ACTIVE") return text(`${nameOf(app)} is not connected: show its card with hub_integration_connect (id composio:${app}).`, true);
      try {
        const r = await api().execute(slug, { userId: user, accountId: a.accountId, args: (input ?? {}) as Record<string, unknown>, ...(version ? { version } : {}) });
        if (!r.ok) return text(`${nameOf(app)} did not do it: ${r.error ?? "the call failed"}${r.data ? `\n${resultText(r.data, 4000)}` : ""}`, true);
        return text(resultText(r.data));
      } catch (e) {
        return failure(e);
      }
    }

    /** Where every known account is at Composio, and their apps' tools. */
    async function sync() {
      if (!(await hasKey())) {
        keyState = "missing";
        report();
        return;
      }
      if (keyState === "missing") keyState = "ok";
      report();
      for (const app of Object.keys(apps)) {
        const a = apps[app]!;
        if (!a.accountId || keyState !== "ok") continue;
        try {
          a.status = (await api().account(a.accountId)).status;
          if (a.status === "ACTIVE") await registerTools(app);
          else unregisterTools(app);
        } catch (e) {
          if (e instanceof ComposioError && e.status === 404) {
            delete a.accountId;
            delete a.status;
            unregisterTools(app);
          } else if (e instanceof ComposioError && e.kind === "key") keyState = "rejected";
          else ctx.log.warn(`composio: could not check ${app}: ${(e as Error).message}`);
        }
      }
      await save();
      report();
    }

    /** Checks a sign-in in progress until its account works, fails, or its link runs out. */
    function poll(app: string, accountId: string, until: number) {
      const done = async () => {
        polls.delete(app);
        const a = apps[app];
        if (a?.pending === accountId) delete a.pending;
        await save();
        report();
      };
      const tick = async () => {
        const a = apps[app];
        if (!a || a.pending !== accountId) return;
        try {
          const acc = await api().account(accountId);
          if (acc.status === "ACTIVE") {
            const old = a.accountId;
            Object.assign(a, { accountId, status: "ACTIVE" });
            if (old && old !== accountId) void api().deleteAccount(old).catch(() => {});
            await registerTools(app).catch((e) => ctx.log.warn(`composio: ${app}'s tools: ${(e as Error).message}`));
            return done();
          }
          if (!PENDING.has(acc.status)) return done();
        } catch (e) {
          if (e instanceof ComposioError && e.kind === "key") {
            keyState = "rejected";
            return done();
          }
          ctx.log.warn(`composio: checking ${app}'s sign-in: ${(e as Error).message}`);
        }
        if (Date.now() > until) return done();
        polls.set(app, setTimeout(() => void tick(), settings.pollMs ?? 3000));
      };
      clearTimeout(polls.get(app));
      polls.set(app, setTimeout(() => void tick(), settings.pollMs ?? 3000));
    }
    plugin.stop = () => {
      for (const t of polls.values()) clearTimeout(t);
      polls.clear();
    };

    ctx.catalog.onSignIn(async (app) => {
      if (!ids().includes(app)) throw new Error(`Composio has no app "${app}" in the catalog`);
      if (!(await hasKey())) throw new Error(ctx.i18n.t("error.noKey"));
      try {
        const a = (apps[app] ??= {});
        if (!a.authConfigId) {
          const kit = await api().toolkit(app);
          if (!kit.managed) throw new Error(ctx.i18n.t("error.notManaged", { name: nameOf(app) }));
          a.authConfigId = await api().createAuthConfig(app);
          await save();
        }
        const link = await api().link(a.authConfigId, user);
        a.pending = link.accountId;
        if (keyState !== "ok") keyState = "ok";
        await save();
        const expires = link.expiresAt ? Date.parse(link.expiresAt) : NaN;
        poll(app, link.accountId, Number.isFinite(expires) ? expires : Date.now() + LINK_MS);
        report();
        return { url: link.url };
      } catch (e) {
        if (!(e instanceof ComposioError)) throw e;
        if (e.kind === "key") {
          keyState = "rejected";
          report();
          throw new Error(ctx.i18n.t("error.keyRejected"));
        }
        throw new Error(ctx.i18n.t("error.down", { message: e.message }));
      }
    });

    ctx.catalog.onSignOut(async (app) => {
      const a = apps[app];
      clearTimeout(polls.get(app));
      polls.delete(app);
      unregisterTools(app);
      if (a?.accountId) await api().deleteAccount(a.accountId);
      if (a) {
        delete a.accountId;
        delete a.status;
        delete a.pending;
        // An app added from the chat leaves the catalog with its sign-in.
        if (a.added && !isKnown(app)) delete apps[app];
      }
      await save();
      report();
    });

    // A key stored, changed or removed: try it.
    ctx.events.on("vault.updated", (p: { ids?: string[] }) => {
      if (Array.isArray(p?.ids) && !p.ids.some((id) => id.replace(/^vault:\/\//, "") === "composio")) return;
      keyState = "missing";
      void sync();
    });

    const needKey = () => text("Composio has no key yet: show its card (hub_integration_connect id composio) so the user stores one; the card says where to get it.", true);

    ctx.tools.register({
      name: "apps_search",
      effect: "read",
      source: true,
      description:
        "Find apps the user can connect through Composio, an outside service that signs in to them for the user (Slack, Trello, Notion, Salesforce, Jira… about a thousand). " +
        "Each line says whether Composio can sign in to it by itself and whether it is in the catalog already (composio:<slug>). " +
        "Prefer a native integration when the catalog has one (hub_integrations_list). To connect one: composio_app_add, then hub_integration_connect.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "The app's name or what it is for" } }, required: ["query"] },
      handler: async (input) => {
        if (!(await hasKey())) return needKey();
        try {
          const list = await api().toolkits(String(input.query ?? "").trim(), 10);
          if (!list.length) return text("Composio has no app like that.");
          return text(
            list
              .map((t) => {
                const where = ids().includes(t.slug) ? ` In the catalog as composio:${t.slug}${connected().includes(t.slug) ? ", connected" : ""}.` : "";
                return `${t.slug} — ${t.name}: ${t.description.slice(0, 160)} [${t.managed ? "Composio signs in by itself" : "needs its own OAuth client: cannot be added"}]${where}`;
              })
              .join("\n"),
          );
        } catch (e) {
          return failure(e);
        }
      },
    });

    ctx.tools.register({
      name: "app_add",
      effect: "local-write",
      description:
        "Add an app found with composio_apps_search to the catalog as composio:<slug>, with Composio's badge (it goes through an outside service). " +
        "Then show its card with hub_integration_connect (id composio:<slug>) so the user signs in.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "The app's slug from composio_apps_search, e.g. trello" } }, required: ["app"] },
      handler: async (input) => {
        const slug = String(input.app ?? "").trim().toLowerCase();
        if (!APP_RE.test(slug)) return text("app must be a slug from composio_apps_search, e.g. trello.", true);
        if (ids().includes(slug)) return text(`${nameOf(slug)} is in the catalog already as composio:${slug}: show its card with hub_integration_connect.`);
        if (!(await hasKey())) return needKey();
        try {
          const kit = await api().toolkit(slug);
          if (!kit.managed) return text(`Composio cannot sign in to ${kit.name} by itself (it needs its own OAuth client), so it cannot be added.`, true);
          apps[slug] = { added: { name: kit.name || slug } };
          await save();
          report();
          return text(`Added ${kit.name} to the catalog as composio:${slug}, with Composio's badge. Show its card with hub_integration_connect id composio:${slug} so the user signs in.`);
        } catch (e) {
          return failure(e);
        }
      },
    });

    ctx.tools.register({
      name: "tools_search",
      effect: "read",
      source: true,
      description:
        "Search a connected Composio app's other tools: its main ones are tools of their own already (composio_<app>_…). Run one found here with composio_tool_run.",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "The app, e.g. slack (as in composio:slack)" }, query: { type: "string", description: "What the tool should do" } },
        required: ["app", "query"],
      },
      handler: async (input) => {
        const app = String(input.app ?? "").trim().toLowerCase().replace(/^composio:/, "");
        if (!(await hasKey())) return needKey();
        try {
          const list = await api().tools(app, { query: String(input.query ?? "").trim(), limit: 10 });
          if (!list.length) return text(`${nameOf(app)} has no tool like that.`);
          const mine = new Set(registered.get(app) ?? []);
          const note = connected().includes(app) ? "" : `\n${nameOf(app)} is not connected yet: show its card with hub_integration_connect (id composio:${app}) first.`;
          return text(
            list
              .map((t) => {
                const own = mine.has(toolName(t.slug)) ? ` (already composio_${toolName(t.slug)})` : "";
                return `${t.slug} — ${t.name}${own} (${effectOf(t.tags) === "read" ? "reads" : "changes something: asks the user"}): ${t.description.slice(0, 200)}\n  input: ${JSON.stringify(t.inputSchema).slice(0, 600)}`;
              })
              .join("\n") + note,
          );
        } catch (e) {
          return failure(e);
        }
      },
    });

    ctx.tools.register({
      name: "tool_run",
      effect: "external",
      source: true,
      approvalSummary: "%approval.run%",
      description:
        "Run a tool of a connected Composio app found with composio_tools_search, by its slug (e.g. SLACK_LIST_REMINDERS), with its arguments, on the user's account. It always asks the user first.",
      inputSchema: {
        type: "object",
        properties: { tool: { type: "string", description: "The tool's slug, e.g. SLACK_LIST_REMINDERS" }, arguments: { type: "object", description: "Its input, as composio_tools_search showed it" } },
        required: ["tool"],
      },
      handler: async (input) => {
        const slug = String(input.tool ?? "").trim().toUpperCase();
        const app = connected()
          .sort((x, y) => y.length - x.length)
          .find((a) => slug.startsWith(`${a.toUpperCase()}_`));
        if (!app) return text(`No connected Composio app has ${slug || "that tool"}: connected ones are ${connected().map((a) => `composio:${a}`).join(", ") || "none"}.`, true);
        return run(app, slug, undefined, input.arguments ?? {});
      },
    });

    // The catalog first (no request to Composio needed), then where the accounts are.
    keyState = (await hasKey()) ? "ok" : "missing";
    report();
    void sync().catch((e) => ctx.log.warn(`composio: sync failed: ${(e as Error).message}`));
  },
  deactivate() {
    plugin.stop?.();
  },
};

export default plugin;
