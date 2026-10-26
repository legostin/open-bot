// Main web app (port 8080): REST API, realtime WebSocket, MCP endpoint for brains, node daemon endpoints,
// plugin HTTP routes, UI plugin assets and the SPA.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import type { AgentDef, TaskStatus } from "@openbot/shared";
import { formatBrainRef, LOCALES, localeFromEnv, normalizeLocale, parseBrainRef, type Locale } from "@openbot/shared";
import { errorText, hubLocale, localizePluginValue, LocalizedError, requestLocale, tFor } from "../i18n.ts";
import type { Hub } from "../app.ts";
import { toUiEvent } from "../bus.ts";
import { AuthError, type AuthSession } from "../auth.ts";
import { agentFromMarkdown, localizedAgent } from "../agents.ts";
import { draftPatch } from "../agent-drafts.ts";
import { clientIp, hostAllowed, HttpError, originAllowed, originsFor, safeFile, securityHeaders, sendFile } from "./http.ts";

const COOKIE = "ob_session";

declare module "fastify" {
  interface FastifyRequest {
    authSession?: AuthSession;
  }
}

export async function buildMainApp(hub: Hub): Promise<FastifyInstance> {
  const cfg = hub.config;
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: process.env.OPENBOT_TRUST_PROXY === "1" });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  const secure = cfg.publicUrl.startsWith("https://");
  const origins = originsFor(cfg.publicUrl, cfg.allowedHosts, cfg.port);
  if (process.env.OPENBOT_DEV_ORIGIN) origins.push(process.env.OPENBOT_DEV_ORIGIN);

  // Keep raw text for non-JSON bodies (webhooks).
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req, cfg.allowedHosts)) {
      reply.code(421).send({ error: "Host not allowed. Add it to OPENBOT_ALLOWED_HOSTS." });
      return reply;
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof LocalizedError && err.status ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) console.error("[http]", err);
    reply.code(status).send({ error: hub.vault.redactor.text(errorText(err, requestLocale(_req))) });
  });

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: 30 * 24 * 3600 });

  const authed = (req: FastifyRequest): AuthSession => {
    const s = hub.auth.session(req.cookies[COOKIE], "main");
    if (!s) throw new HttpError(401, "auth.required");
    return s;
  };

  /** Session + (for state-changing requests) CSRF token and same-origin check. */
  const guard = async (req: FastifyRequest) => {
    const s = authed(req);
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["x-csrf"] !== s.csrf) throw new HttpError(403, "CSRF token mismatch");
      if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
    }
    req.authSession = s;
  };

  // ---------- public: auth ----------

  app.get("/api/auth/state", async (req) => ({
    hasPassword: hub.auth.hasPassword(),
    authenticated: !!hub.auth.session(req.cookies[COOKIE], "main"),
    passkeys: hub.auth.listPasskeys().length,
    version: cfg.version,
    language: hubLocale(),
    locales: LOCALES,
  }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
    const b = req.body as { token?: string; password?: string };
    hub.auth.setup(String(b?.token ?? ""), String(b?.password ?? ""), clientIp(req));
    // The first user's browser language becomes the hub language unless OPENBOT_LANG pins it.
    if (!localeFromEnv({ OPENBOT_LANG: process.env.OPENBOT_LANG })) hub.settings.update({ language: requestLocale(req) });
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
    const b = req.body as { password?: string };
    hub.auth.verifyPassword(String(b?.password ?? ""), clientIp(req));
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  app.post("/api/auth/passkey/options", async (req) => {
    if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
    return hub.auth.passkeyLoginOptions();
  });

  app.post("/api/auth/passkey/verify", async (req, reply) => {
    if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
    await hub.auth.passkeyLogin((req.body as any)?.response, clientIp(req));
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    hub.auth.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---------- public: MCP for brains ----------

  app.post("/mcp", async (req, reply) => {
    const session = hub.mcp.authenticate(req.headers.authorization);
    if (!session) {
      reply.code(401).header("www-authenticate", 'Bearer realm="openbot"');
      return { jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid session token" } };
    }
    const out = await hub.mcp.handle(session, req.body);
    if (out === undefined) return reply.code(202).send();
    return out;
  });
  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send());
  app.delete("/mcp", async () => ({}));

  // ---------- public: machine nodes ----------

  const pairFailures = new Map<string, number[]>();
  app.post("/api/node/pair", async (req) => {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (pairFailures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) throw new HttpError(429, "auth.tooManyAttempts");
    try {
      const b = req.body as any;
      const m = hub.machines.pair({ code: String(b?.code ?? ""), publicKey: String(b?.publicKey ?? ""), name: b?.name, info: b?.info });
      return { machineId: m.id, name: m.name };
    } catch (e: any) {
      recent.push(now);
      pairFailures.set(ip, recent);
      throw e instanceof LocalizedError ? new HttpError(400, e.key, e.params) : new HttpError(400, e.message);
    }
  });

  app.get("/node/ws", { websocket: true }, (socket, req) => {
    hub.machines.attach(socket as any, clientIp(req));
  });

  // Single-file machine daemon (public code, no secrets): `node openbot-node.mjs pair <hub> <code>`.
  app.get("/download/openbot-node.mjs", async (_req, reply) => {
    const file = join(cfg.appRoot, "packages", "node", "dist", "openbot-node.mjs");
    if (!existsSync(file)) throw new HttpError(404, "build.daemonMissing");
    return sendFile(reply, file, { download: true });
  });

  // ---------- public: plugin webhooks ----------

  app.all("/hooks/:pluginId/*", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    if (!hub.plugins.hasHttp(pluginId)) throw new HttpError(404, "not found");
    const rest = (req.params as any)["*"] as string;
    const r = await hub.plugins.http(pluginId, {
      method: req.method,
      path: "/" + rest,
      query: req.query as Record<string, string>,
      headers: req.headers as Record<string, string>,
      body: req.body ?? null,
      public: true,
      locale: hubLocale(),
    });
    reply.code(r.status ?? 200);
    for (const [k, v] of Object.entries(r.headers ?? {})) if (!/^(set-cookie|content-security-policy)$/i.test(k)) reply.header(k, v);
    return reply.send(r.body ?? "");
  });

  // ---------- authenticated API ----------

  await app.register(async (api) => {
    api.addHook("preHandler", guard);

    api.get("/api/bootstrap", async (req) => {
      const s = hub.settings.get();
      return {
        csrf: req.authSession!.csrf,
        version: cfg.version,
        publicUrl: cfg.publicUrl,
        consoleUrl: cfg.consoleUrl,
        // The default agent's dialog: what "/" opens.
        mainConversationId: hub.store.agentConversation(s.defaultAgent).id,
        defaultAgent: s.defaultAgent,
        timezone: s.timezone,
        language: s.language,
        locales: LOCALES,
        vaultState: hub.vault.state(),
        pendingApprovals: hub.approvals.pendingCount(),
        uiPlugins: hub.plugins.uiPlugins(requestLocale(req)),
        channels: hub.channels.list(),
      };
    });

    // ----- conversations -----
    api.get("/api/conversations", async () => hub.store.listConversations(200));
    api.post("/api/conversations", async (req) => {
      const b = (req.body ?? {}) as { title?: string; agentId?: string };
      const agentId = b.agentId && hub.agents.get(b.agentId) ? b.agentId : hub.settings.get().defaultAgent;
      return hub.store.createConversation({ kind: "chat", title: String(b.title || tFor(requestLocale(req))("conversation.newTitle")), agentId });
    });
    api.patch("/api/conversations/:id", async (req) => {
      const b = (req.body ?? {}) as { title?: string; agentId?: string };
      if (b.agentId && !hub.agents.get(b.agentId)) throw new HttpError(400, "agent.notFound");
      const prev = hub.store.getConversation((req.params as any).id);
      if (!prev) throw new HttpError(404, "conversation.notFound");
      // An agent's dialog belongs to that agent.
      if (prev.kind === "main" && b.agentId !== undefined && b.agentId !== prev.agentId) throw new HttpError(400, "conversation.agentFixed");
      return hub.store.updateConversation(prev.id, b);
    });
    api.post("/api/conversations/:id/read", async (req) => {
      const id = (req.params as any).id as string;
      if (!hub.store.getConversation(id)) throw new HttpError(404, "conversation.notFound");
      const at = (req.body as { at?: unknown } | undefined)?.at;
      hub.team.markRead(id, typeof at === "string" ? at : undefined);
      return { ok: true };
    });
    api.get("/api/conversations/:id/messages", async (req) => {
      const q = req.query as { before?: string; limit?: string };
      return hub.store.listMessages((req.params as any).id, { before: q.before, limit: Math.min(Number(q.limit ?? 100), 500) });
    });
    api.post("/api/conversations/:id/messages", async (req) => {
      const b = (req.body ?? {}) as { text?: string };
      const text = String(b.text ?? "").trim();
      if (!text) throw new HttpError(400, "message.empty");
      return hub.runner.userMessage((req.params as any).id, text, { channel: "web" });
    });
    api.post("/api/conversations/:id/interrupt", async (req) => ({ interrupted: hub.runner.interrupt((req.params as any).id) }));

    // ----- team: every agent with its long-lived dialog (created on first listing) -----
    api.get("/api/team", async () => hub.team.list());

    // ----- tasks -----
    api.get("/api/tasks", async (req) => {
      const q = req.query as { status?: string; limit?: string };
      return hub.store.listTasks({ status: q.status ? (q.status.split(",") as TaskStatus[]) : undefined, limit: Math.min(Number(q.limit ?? 200), 1000) });
    });
    api.post("/api/tasks", async (req) => {
      const b = (req.body ?? {}) as { goal?: string; title?: string; agentId?: string; background?: boolean };
      const goal = String(b.goal ?? "").trim();
      if (!goal) throw new HttpError(400, "task.goalRequired");
      const agentId = b.agentId && hub.agents.get(b.agentId) ? b.agentId : hub.settings.get().defaultAgent;
      return hub.runner.createTask({ agentId, goal, title: String(b.title || goal.slice(0, 60)), background: b.background ?? false, createdBy: "user" });
    });
    api.get("/api/tasks/:id", async (req) => {
      const t = hub.store.getTask((req.params as any).id);
      if (!t) throw new HttpError(404, "task.notFound");
      return t;
    });
    api.post("/api/tasks/:id/cancel", async (req) => hub.runner.cancelTask((req.params as any).id) ?? { error: "not found" });
    api.post("/api/tasks/:id/retry", async (req) => hub.runner.retryTask((req.params as any).id) ?? { error: "not found" });

    // ----- agents -----
    api.get("/api/agents", async (req) => {
      const locale = requestLocale(req);
      return hub.agents.list().map((a) => localizedAgent(a, locale));
    });
    api.put("/api/agents/:id", async (req) => {
      const id = (req.params as any).id as string;
      const b = (req.body ?? {}) as Partial<AgentDef> & { markdown?: string };
      const prev = hub.agents.get(id);
      // The editor showed the name and description in the reader's language: edits to a translated
      // agent go into that translation, so the other languages keep theirs.
      const locale = requestLocale(req);
      const tr = prev?.i18n?.[locale];
      let patch: Partial<AgentDef> = b;
      if (tr && !b.markdown) {
        const { name, description, ...rest } = b;
        const edited = { ...tr, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
        patch = { ...rest, i18n: { ...prev!.i18n, [locale]: edited } };
      }
      const agent: AgentDef = b.markdown ? agentFromMarkdown(id, b.markdown, "user") : { ...(prev ?? agentFromMarkdown(id, "", "user")), ...patch, id, source: "user" };
      return hub.saveAgent(agent, "user");
    });
    api.delete("/api/agents/:id", async (req) => {
      hub.removeAgent((req.params as any).id as string, "user");
      return { ok: true };
    });

    // ----- new agents put together in the chat (the card) -----
    api.get("/api/agent-drafts/:id", async (req) => {
      const d = hub.agentDrafts.get((req.params as any).id);
      if (!d) throw new HttpError(404, "agentDraft.notFound");
      return d;
    });
    // In the card the user picks the look and the proactivity; everything else they say in words.
    api.patch("/api/agent-drafts/:id", async (req) => {
      const patch = draftPatch((req.body ?? {}) as Record<string, unknown>, ["avatar", "initiative"]);
      return hub.agentDrafts.update((req.params as any).id, patch);
    });
    api.post("/api/agent-drafts/:id/create", async (req) => {
      const agent = hub.createAgentFromDraft((req.params as any).id, "user");
      const draft = hub.agentDrafts.get((req.params as any).id)!;
      hub.runner.noteAndContinue(
        draft.conversationId,
        `[System] The user pressed Create in the card: agent “${agent.name}” (id ${agent.id}) is on the team now, with its own dialog in the sidebar. ` +
          "Say so in one short sentence; do not call hub_agent_draft for it again.",
      );
      return { draft, agent: localizedAgent(agent, requestLocale(req)) };
    });

    // ----- brains -----
    api.get("/api/brains", async (req) => {
      const fresh = (req.query as any).probe === "1";
      const listed = hub.brains.list();
      const refs = new Map<string, { ref: string; label: string; host?: string; login?: boolean }>();
      for (const b of listed) refs.set(b.ref, { ref: b.ref, label: b.label, host: b.host, login: b.login });
      for (const a of hub.agents.list()) for (const r of a.brains) {
        const key = formatBrainRef(parseBrainRef(r));
        if (!refs.has(key)) refs.set(key, { ref: key, label: key });
      }
      const limits = new Map((hub.db.prepare("select brain_ref, until, detail from brain_limits").all() as any[]).map((r) => [r.brain_ref, r]));
      return Promise.all(
        [...refs.values()].map(async (b) => {
          const connected = hub.brains.has(b.ref);
          const probe = connected ? await hub.brains.probe(b.ref, fresh ? 0 : 5 * 60_000) : undefined;
          const lim = limits.get(b.ref);
          return { ...b, connected, probe, limitedUntil: lim && Date.parse(lim.until) > Date.now() ? lim.until : undefined, limitDetail: lim?.detail };
        }),
      );
    });
    api.post("/api/brains/probe", async (req) => {
      const ref = String((req.body as any)?.ref ?? "");
      hub.brains.invalidate(ref);
      return hub.brains.probe(ref, 0);
    });
    api.delete("/api/brains/limits/:ref", async (req) => {
      hub.db.prepare("delete from brain_limits where brain_ref = ?").run(decodeURIComponent((req.params as any).ref));
      hub.bus.emit("brains.updated", {});
      return { ok: true };
    });

    // ----- signing CLI brains in from the chat: the sign-in card -----
    const loginRef = (req: FastifyRequest) => {
      const ref = String((req.query as any)?.ref ?? (req.body as any)?.ref ?? "");
      if (!/^[\w.:@-]{1,200}$/.test(ref)) throw new HttpError(400, "brain.refNotConnected", { ref: ref.slice(0, 80) });
      return ref;
    };
    api.get("/api/brains/login", async (req) => hub.brainLogins.view(loginRef(req)));
    api.post("/api/brains/login", async (req) => {
      const ref = loginRef(req);
      await hub.brainLogins.start(ref, { actor: "user" });
      return hub.brainLogins.view(ref);
    });
    api.post("/api/brains/login/code", async (req) => {
      const ref = loginRef(req);
      await hub.brainLogins.submitCode(ref, String((req.body as any)?.code ?? ""));
      return hub.brainLogins.view(ref);
    });
    api.post("/api/brains/login/cancel", async (req) => {
      const ref = loginRef(req);
      await hub.brainLogins.cancel(ref, "user");
      return hub.brainLogins.view(ref);
    });

    // ----- plugins -----
    const pluginView = (r: ReturnType<typeof hub.plugins.list>[number], locale: Locale) => ({
      id: r.id,
      name: localizePluginValue(r.layout, r.layout?.manifest.name ?? r.id, locale),
      version: r.layout?.manifest.version,
      description: localizePluginValue(r.layout, r.layout?.manifest.description, locale),
      source: r.source,
      enabled: r.enabled,
      status: r.status,
      lastError: r.lastError,
      formats: r.layout?.formats ?? [],
      permissions: r.granted,
      contributes: localizePluginValue(r.layout, r.layout?.manifest.contributes, locale),
      settings: r.settings,
      hasUi: !!r.layout?.uiEntry,
      hasServer: !!r.layout?.serverEntry,
      commitHash: r.commitHash,
    });
    api.get("/api/plugins", async (req) => hub.plugins.list().map((r) => pluginView(r, requestLocale(req))));
    api.get("/api/plugins/:id/logs", async (req) => hub.plugins.get((req.params as any).id)?.logs ?? []);
    api.post("/api/plugins/install", async (req) => hub.plugins.prepareInstall(String((req.body as any)?.source ?? ""), requestLocale(req)));
    api.post("/api/plugins/install/confirm", async (req) => pluginView(await hub.plugins.confirmInstall(String((req.body as any)?.stagingId ?? "")), requestLocale(req)));
    api.post("/api/plugins/:id/enabled", async (req) => {
      await hub.plugins.setEnabled((req.params as any).id, !!(req.body as any)?.enabled);
      return pluginView(hub.plugins.get((req.params as any).id)!, requestLocale(req));
    });
    api.put("/api/plugins/:id/settings", async (req) => {
      hub.plugins.setSettings((req.params as any).id, (req.body ?? {}) as Record<string, unknown>);
      return { ok: true };
    });
    api.post("/api/plugins/:id/restart", async (req) => {
      await hub.plugins.restart((req.params as any).id);
      return pluginView(hub.plugins.get((req.params as any).id)!, requestLocale(req));
    });
    api.delete("/api/plugins/:id", async (req) => {
      await hub.plugins.uninstall((req.params as any).id);
      return { ok: true };
    });
    api.all("/api/plugins/:id/http/*", async (req, reply) => {
      const id = (req.params as any).id as string;
      const r = await hub.plugins.http(id, {
        method: req.method,
        path: "/" + ((req.params as any)["*"] as string),
        query: req.query as Record<string, string>,
        headers: { "content-type": String(req.headers["content-type"] ?? "") },
        body: req.body ?? null,
        public: false,
        locale: requestLocale(req),
      });
      reply.code(r.status ?? 200);
      for (const [k, v] of Object.entries(r.headers ?? {})) if (/^(content-type|cache-control|content-disposition)$/i.test(k)) reply.header(k, v);
      return reply.send(r.body ?? "");
    });
    api.post("/api/plugins/:id/message", async (req) => {
      hub.plugins.uiMessage((req.params as any).id, req.body);
      return { ok: true };
    });

    // ----- tools, skills, commands, channels -----
    api.get("/api/tools", async () => hub.tools.list().map((t) => ({ name: t.name, description: t.description, effect: t.effect, owner: t.owner, source: !!t.source })));
    api.get("/api/skills", async () => hub.skills.list());
    api.get("/api/commands", async () => hub.skills.listCommands().map((c) => ({ name: c.name, description: c.description, source: c.source })));
    api.get("/api/channels", async () => Promise.all(hub.channels.list().map(async (c) => ({ ...c, ...(await hub.channels.status(c.id)) }))));

    // ----- machines -----
    api.get("/api/machines", async () => hub.machines.list());
    api.post("/api/machines/pairing-code", async (req) => ({ ...hub.machines.createPairingCode((req.body as any)?.name), hubUrl: cfg.publicUrl }));
    api.patch("/api/machines/:id", async (req) => hub.machines.rename((req.params as any).id, String((req.body as any)?.name ?? "")));
    api.delete("/api/machines/:id", async (req) => {
      hub.machines.revoke((req.params as any).id);
      return { ok: true };
    });

    // ----- the vault from the chat: create or unlock only (reading items, sealing, scopes stay in the security console) -----
    const unlockTries = { count: 0, since: Date.now() };
    const passphraseIn = (req: FastifyRequest) => {
      const b = (req.body ?? {}) as { passphrase?: unknown; remember?: unknown };
      return { passphrase: String(b.passphrase ?? ""), remember: b.remember === true };
    };
    api.post("/api/vault/init", async (req) => {
      const { passphrase, remember } = passphraseIn(req);
      hub.vault.init(passphrase);
      hub.rememberVaultPassphrase(remember ? passphrase : undefined);
      hub.audit.append("user", "vault.init", undefined, { via: "chat", remember });
      return { state: hub.vault.state() };
    });
    api.post("/api/vault/unlock", async (req) => {
      if (Date.now() - unlockTries.since > 10 * 60_000) Object.assign(unlockTries, { count: 0, since: Date.now() });
      if (unlockTries.count >= 10) throw new HttpError(429, "auth.tooManyAttempts");
      const { passphrase, remember } = passphraseIn(req);
      try {
        hub.vault.unlock(passphrase);
      } catch (e) {
        unlockTries.count++;
        throw e;
      }
      unlockTries.count = 0;
      hub.rememberVaultPassphrase(remember ? passphrase : undefined);
      hub.audit.append("user", "vault.unlock", undefined, { via: "chat", remember });
      return { state: hub.vault.state() };
    });

    // ----- secrets typed into the chat: write-only, nothing here ever returns a value -----
    api.get("/api/secret-requests/:id", async (req) => {
      const r = hub.secrets.get((req.params as any).id);
      if (!r) throw new HttpError(404, "secrets.requestNotFound");
      return { ...r, vaultState: hub.vault.state() };
    });
    api.post("/api/secret-requests/:id", async (req) => {
      const { request } = hub.secrets.fulfil((req.params as any).id, String((req.body as any)?.value ?? ""), "user");
      return { ...request, vaultState: hub.vault.state() };
    });
    api.post("/api/secret-requests/:id/cancel", async (req) => ({ ...hub.secrets.cancel((req.params as any).id, "user"), vaultState: hub.vault.state() }));
    api.get("/api/plugins/:id/setup", async (req) => hub.secrets.setupView((req.params as any).id, requestLocale(req)));
    api.post("/api/plugins/:id/secrets/:vault", async (req) => {
      const { id, vault } = req.params as { id: string; vault: string };
      const s = hub.secrets.setupSecret(id, vault);
      hub.secrets.store({ vaultId: s.vault, title: hub.secrets.secretTitle(id, s, hubLocale()), value: String((req.body as any)?.value ?? ""), pluginId: id, setting: s.setting, actor: "user" });
      return hub.secrets.setupView(id, requestLocale(req));
    });

    // ----- MCP servers -----
    api.get("/api/mcp-servers", async () => ({ servers: hub.mcpClients.list(), config: hub.mcpClients.readUserServers() }));
    api.put("/api/mcp-servers", async (req) => {
      const servers = ((req.body as any)?.servers ?? {}) as Record<string, any>;
      for (const [name, s] of Object.entries(servers)) {
        for (const [k, v] of Object.entries({ ...(s.env ?? {}), ...(s.headers ?? {}) })) {
          if (/key|token|secret|password/i.test(k) && typeof v === "string" && !v.startsWith("vault://") && v !== "•••") {
            throw new HttpError(400, "settings.secretInPlainText", { field: `${name}.${k}` });
          }
        }
      }
      // Keep masked values from the previous config.
      const prev = hub.mcpClients.readUserServers();
      for (const [name, s] of Object.entries(servers)) {
        for (const key of ["env", "headers"] as const) {
          if (!s[key]) continue;
          for (const [k, v] of Object.entries(s[key] as Record<string, string>)) if (v === "•••") s[key][k] = (prev[name] as any)?.[key]?.[k] ?? "";
        }
      }
      hub.mcpClients.writeUserServers(servers);
      hub.audit.append("user", "mcp.config", undefined, { servers: Object.keys(servers) });
      hub.reindex();
      return { ok: true };
    });
    api.post("/api/mcp-servers/:name/reconnect", async (req) => {
      await hub.mcpClients.reconnect((req.params as any).name);
      return hub.mcpClients.list();
    });

    // ----- settings -----
    api.get("/api/settings", async () => hub.settings.get());
    api.patch("/api/settings", async (req) => hub.updateSettings((req.body ?? {}) as Record<string, unknown>, "user"));

    // ----- notifications, approvals (count only; resolving happens in the console) -----
    api.get("/api/notifications", async (req) => hub.notifier.list(Math.min(Number((req.query as any).limit ?? 100), 500)));
    api.post("/api/notifications/:id/feedback", async (req) => hub.notifier.feedback((req.params as any).id, (req.body as any)?.value));
    api.post("/api/digest/flush", async () => ({ sent: await hub.notifier.flushDigest() }));
    api.get("/api/approvals/pending-count", async () => ({ count: hub.approvals.pendingCount() }));

    // ----- workspace files (artifacts) -----
    api.get("/api/files", async (req, reply) => {
      const p = String((req.query as any).path ?? "");
      const file = safeFile(join(cfg.dataDir, "workspaces"), p);
      if (!file) throw new HttpError(404, "file.notFound");
      return sendFile(reply, file, { download: (req.query as any).download === "1" });
    });

    // ----- UI plugin assets -----
    api.get("/plugins-ui/:id/*", async (req, reply) => {
      const dir = hub.plugins.uiDir((req.params as any).id);
      const file = dir ? safeFile(dir, (req.params as any)["*"]) : undefined;
      if (!file) throw new HttpError(404, "not found");
      return sendFile(reply, file);
    });

    // ----- realtime -----
    api.get("/api/ws", { websocket: true }, (socket, req) => {
      if (!originAllowed(req, origins)) {
        socket.close(4403, "origin");
        return;
      }
      const send = (ev: unknown) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(ev));
      };
      const unsub = hub.bus.onAny((name, payload) => {
        if (name === "approval.created" || name === "approval.resolved") {
          send({ type: "approval.pending", data: { count: hub.approvals.pendingCount() } });
          return;
        }
        const ev = toUiEvent(name, payload);
        if (ev) send(ev);
      });
      const ping = setInterval(() => socket.ping(), 25_000);
      socket.on("close", () => {
        unsub();
        clearInterval(ping);
      });
      socket.on("message", (raw) => {
        // Client → plugin backend messages: {pluginId, payload}
        try {
          const m = JSON.parse(String(raw));
          if (m?.type === "plugin.message" && typeof m.pluginId === "string") hub.plugins.uiMessage(m.pluginId, m.payload);
        } catch {
          /* ignore */
        }
      });
    });
  });

  // ---------- SPA ----------

  const indexFile = join(cfg.webDist, "index.html");
  const importMap = JSON.stringify({
    imports: {
      react: "/shared/react.js",
      "react/jsx-runtime": "/shared/react-jsx-runtime.js",
      "react-dom": "/shared/react-dom.js",
      "react-dom/client": "/shared/react-dom-client.js",
      "@openbot/ui": "/shared/openbot-ui.js",
    },
  });
  const sendIndex = (req: FastifyRequest, reply: FastifyReply) => {
    const host = String(req.headers.host ?? "localhost");
    const nonce = randomBytes(16).toString("base64");
    securityHeaders(
      reply,
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self' ws://${host} wss://${host}`,
        "media-src 'self' blob:",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
    if (!existsSync(indexFile)) {
      return reply
        .type("text/html; charset=utf-8")
        .send(`<!doctype html><meta charset="utf-8"><title>open-bot</title><body style="font-family:sans-serif;padding:2rem">${tFor(requestLocale(req))("build.webMissing")}</body>`);
    }
    const html = readFileSync(indexFile, "utf8").replace("<head>", `<head>\n<script type="importmap" nonce="${nonce}">${importMap}</script>`);
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(html);
  };

  app.get("/*", async (req, reply) => {
    const rel = decodeURIComponent((req.params as any)["*"] ?? "");
    if (rel.startsWith("api/")) throw new HttpError(404, "not found");
    if (rel && rel !== "index.html") {
      const file = safeFile(cfg.webDist, rel);
      if (file) {
        reply.header("x-content-type-options", "nosniff");
        return sendFile(reply, file, { cache: rel.startsWith("assets/") });
      }
      if (/\.[a-z0-9]{1,8}$/i.test(rel)) throw new HttpError(404, "not found");
    }
    return sendIndex(req, reply);
  });

  return app;
}
