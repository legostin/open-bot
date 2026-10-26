// Plugin process entry: `node runner.ts <absolute path to plugin server entry>`.
// Talks JSON-RPC (NDJSON) with the core over stdin/stdout; console output goes to stderr.

import { pathToFileURL } from "node:url";
import { createRpcPeer, ndjsonTransport, DEFAULT_LOCALE, isLocale, translator } from "@openbot/shared";
import type { ToolCallContext, ToolResult, BrainSessionOptions, BrainTurn, OutboundMessage, Catalog, Locale, Translate } from "@openbot/shared";
import type {
  BrainProviderImpl,
  BrainSessionImpl,
  ChannelImpl,
  PluginContext,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginModule,
  ToolHandler,
} from "./types.ts";

// Keep stdout clean for RPC.
const toStderr = (...args: unknown[]) => process.stderr.write(args.map(fmt).join(" ") + "\n");
function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

const entry = process.argv[2];
if (!entry) {
  toStderr("usage: runner.ts <plugin entry>");
  process.exit(2);
}

const peer = createRpcPeer(ndjsonTransport(process.stdin, process.stdout));
peer.onClose(() => process.exit(0));

const toolHandlers = new Map<string, ToolHandler>();
const brains = new Map<string, BrainProviderImpl>();
const brainSessions = new Map<string, BrainSessionImpl>();
const channels = new Map<string, ChannelImpl>();
const hookHandlers = new Map<string, (p: any) => any>();
const eventHandlers = new Map<string, Array<(p: any) => void>>();
const settingsCbs: Array<(s: Record<string, any>) => void> = [];
const uiMessageCbs: Array<(p: any) => void> = [];
const localeCbs: Array<(l: Locale) => void> = [];
let hubLocale: Locale = DEFAULT_LOCALE;
let messages: Catalog = {};
const translators = new Map<Locale, Translate>();
const translate = (locale: Locale): Translate => {
  let t = translators.get(locale);
  if (!t) translators.set(locale, (t = translator(messages, locale)));
  return t;
};
let httpHandler: ((req: PluginHttpRequest) => Promise<PluginHttpResponse> | PluginHttpResponse) | undefined;
let mod: PluginModule | undefined;

peer.handle("plugin.activate", async (p: { pluginId: string; dataDir: string; pluginDir: string; hubUrl: string; appRoot: string; settings: any; locale?: string; messages?: Catalog }) => {
  hubLocale = isLocale(p.locale) ? p.locale : DEFAULT_LOCALE;
  messages = p.messages ?? {};
  translators.clear();
  const imported = await import(pathToFileURL(entry).href);
  mod = (imported.default ?? imported) as PluginModule;
  if (typeof mod.activate !== "function") throw new Error("plugin module must export activate(ctx)");
  const log = (level: string) => (...args: unknown[]) => peer.notify("log", { level, msg: args.map(fmt).join(" ") });
  const ctx: PluginContext = {
    pluginId: p.pluginId,
    pluginDir: p.pluginDir,
    dataDir: p.dataDir,
    hubUrl: p.hubUrl,
    appRoot: p.appRoot,
    settings: p.settings ?? {},
    onSettingsChange: (cb) => settingsCbs.push(cb),
    i18n: {
      locale: () => hubLocale,
      t: (key, params, locale) => translate(locale && isLocale(locale) ? locale : hubLocale)(key, params),
      onChange: (cb) => localeCbs.push(cb),
    },
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    tools: {
      register(tool) {
        const { handler, ...spec } = tool;
        toolHandlers.set(spec.name, handler);
        void peer.request("register.tool", { spec });
      },
    },
    brains: {
      register(provider) {
        brains.set(provider.id, provider);
        void peer.request("register.brain", { id: provider.id, label: provider.label, variants: provider.variants });
      },
    },
    channels: {
      register(channel) {
        channels.set(channel.id, channel);
        void peer.request("register.channel", { id: channel.id, label: channel.label });
      },
    },
    events: {
      on(name, cb) {
        const list = eventHandlers.get(name) ?? [];
        list.push(cb);
        eventHandlers.set(name, list);
        void peer.request("events.subscribe", { names: [name] });
      },
    },
    hooks: {
      on(hook, handler) {
        hookHandlers.set(hook, handler as (p: any) => any);
        void peer.request("register.hook", { hook });
      },
    },
    http: {
      handle(handler) {
        httpHandler = handler;
        void peer.request("register.http", {});
      },
    },
    ui: {
      emit(channel, payload) {
        void peer.request("core.call", { method: "ui.emit", params: { channel, payload } }).catch(() => {});
      },
      onMessage(cb) {
        uiMessageCbs.push(cb);
      },
    },
    vault: {
      get: (ref, opts) => peer.request("vault.get", { ref, ...opts }),
    },
    storage: {
      get: (key) => peer.request("storage.get", { key }),
      set: async (key, value) => {
        await peer.request("storage.set", { key, value });
      },
      delete: async (key) => {
        await peer.request("storage.delete", { key });
      },
      list: (prefix) => peer.request("storage.list", { prefix }),
    },
    core: {
      call: (method, params) => peer.request("core.call", { method, params }),
    },
  };
  ctx.settings = p.settings ?? {};
  await mod.activate(ctx);
  // Registration requests above are fire-and-forget; flush them before reporting ready.
  await peer.request("plugin.ready", {});
  return {};
});

peer.handle("plugin.deactivate", async () => {
  try {
    await mod?.deactivate?.();
  } finally {
    setTimeout(() => process.exit(0), 50);
  }
  return {};
});

peer.onNotification("settings.changed", (p: { settings: Record<string, any> }) => {
  for (const cb of settingsCbs) cb(p.settings);
});

peer.onNotification("locale.changed", (p: { locale: Locale }) => {
  if (!isLocale(p.locale)) return;
  hubLocale = p.locale;
  for (const cb of localeCbs) cb(p.locale);
});

peer.onNotification("event", (p: { name: string; payload: unknown }) => {
  for (const cb of eventHandlers.get(p.name) ?? []) {
    try {
      cb(p.payload);
    } catch (e) {
      toStderr("event handler error", e);
    }
  }
});

peer.onNotification("ui.message", (p: { payload: unknown }) => {
  for (const cb of uiMessageCbs) cb(p.payload);
});

peer.handle("tool.invoke", async (p: { name: string; input: unknown; context: ToolCallContext }): Promise<ToolResult> => {
  const h = toolHandlers.get(p.name);
  if (!h) throw new Error(`unknown tool ${p.name}`);
  try {
    const r = await h(p.input ?? {}, p.context);
    return typeof r === "string" ? { content: [{ type: "text", text: r }] } : r;
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
  }
});

peer.handle("hook.run", async (p: { hook: string; payload: unknown }) => {
  const h = hookHandlers.get(p.hook);
  return h ? ((await h(p.payload)) ?? null) : null;
});

peer.handle("http.request", async (req: PluginHttpRequest) => {
  if (!httpHandler) return { status: 404, body: { error: "no http handler" } };
  return (await httpHandler(req)) ?? { status: 204 };
});

peer.handle("channel.send", async (p: { channelId: string; message: OutboundMessage }) => {
  const ch = channels.get(p.channelId);
  if (!ch) throw new Error(`unknown channel ${p.channelId}`);
  return (await ch.send(p.message)) ?? {};
});

peer.handle("channel.status", async (p: { channelId: string }) => {
  const ch = channels.get(p.channelId);
  if (!ch) throw new Error(`unknown channel ${p.channelId}`);
  return ch.status ? await ch.status() : { connected: true };
});

peer.handle("brain.probe", async (p: { brainId: string; variant?: string }) => {
  const b = brains.get(p.brainId);
  if (!b) throw new Error(`unknown brain ${p.brainId}`);
  return b.probe(p.variant);
});

peer.handle("brain.create", async (p: { brainId: string; opts: BrainSessionOptions }) => {
  const b = brains.get(p.brainId);
  if (!b) throw new Error(`unknown brain ${p.brainId}`);
  const s = await b.createSession(p.opts);
  brainSessions.set(p.opts.sessionId, s);
  return {};
});

peer.handle("brain.send", async (p: { sessionId: string; turn: BrainTurn }) => {
  const s = brainSessions.get(p.sessionId);
  if (!s) throw new Error(`unknown brain session ${p.sessionId}`);
  try {
    for await (const event of s.send(p.turn)) {
      peer.notify("brain.event", { sessionId: p.sessionId, event });
    }
  } catch (e: any) {
    peer.notify("brain.event", { sessionId: p.sessionId, event: { type: "error", message: e?.message ?? String(e), fatal: true } });
  }
  return {};
});

peer.handle("brain.interrupt", async (p: { sessionId: string }) => {
  await brainSessions.get(p.sessionId)?.interrupt();
  return {};
});

peer.handle("brain.close", async (p: { sessionId: string }) => {
  const s = brainSessions.get(p.sessionId);
  brainSessions.delete(p.sessionId);
  await s?.close();
  return {};
});

process.on("uncaughtException", (e) => toStderr("uncaught", e));
process.on("unhandledRejection", (e) => toStderr("unhandled rejection", e));
