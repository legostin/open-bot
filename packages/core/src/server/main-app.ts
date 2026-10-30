// Main web app (port 8080): sign-in, the hub API (server/api.ts) behind cookie sessions, MCP endpoint for brains,
// node daemon endpoints, plugin webhooks and the SPA. The same app in remote mode is the link's gateway (remote.ts):
// on loopback behind the hub's Tailscale node, the link's host only, no first-run setup, desktop sign-in, passkeys,
// Google's return page or webhooks.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { LOCALES, localeFromEnv } from "@owlbot/shared";
import { errorText, hubLocale, LocalizedError, requestLocale, t, tFor } from "../i18n.ts";
import type { Hub } from "../app.ts";
import { AuthError, type AuthSession } from "../auth.ts";
import { clientIp, FailureBudget, hostAllowed, HttpError, originAllowed, originsFor, sendFile } from "./http.ts";
import { registerJoinPage } from "./join-page.ts";
import { registerApi } from "./api.ts";
import { registerSpa } from "./spa.ts";
import { registerPages } from "./pages.ts";

const COOKIE = "owlbot_session";

declare module "fastify" {
  interface FastifyRequest {
    authSession?: AuthSession;
  }
}

export interface MainAppOptions {
  /** The link's gateway: `host` is the link's host while the node serves it. */
  remote?: { host: () => string | undefined };
}

export async function buildMainApp(hub: Hub, opts: MainAppOptions = {}): Promise<FastifyInstance> {
  const cfg = hub.config;
  const remote = opts.remote;
  // The gateway trusts the node's X-Forwarded-For (it sets it, dropping the client's own): clientIp() is the real one.
  const trustProxy = remote ? "127.0.0.1" : process.env.OWLBOT_TRUST_PROXY === "1";
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  const secure = !!remote || cfg.publicUrl.startsWith("https://");
  const localOrigins = originsFor(cfg.publicUrl, cfg.allowedHosts, cfg.port);
  if (process.env.OWLBOT_DEV_ORIGIN) localOrigins.push(process.env.OWLBOT_DEV_ORIGIN);
  /** Where state-changing requests may come from: the link itself on the gateway. */
  const origins = (): string[] => {
    if (!remote) return localOrigins;
    const host = remote.host();
    return host ? [`https://${host}`] : [];
  };
  const hosts = (): string[] => {
    if (!remote) return cfg.allowedHosts;
    const host = remote.host();
    return host ? [host.split(":")[0].toLowerCase()] : [];
  };

  // Keep raw text for non-JSON bodies (webhooks).
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req, hosts())) {
      reply.code(421).send({ error: "Host not allowed. Add it to OWLBOT_ALLOWED_HOSTS." });
      return reply;
    }
    // A standby replica shows what it has (it is seconds behind) but takes no changes: they go to the leader.
    const leader = hub.cluster.leaderTarget();
    if (leader && req.method !== "GET" && req.method !== "HEAD" && req.url.startsWith("/api/") && !req.url.startsWith("/api/auth/")) {
      reply.code(503).send({ error: t("cluster.standby", { leader: leader.name }) });
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
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
    }
    req.authSession = s;
  };

  // ---------- public: auth ----------

  app.get("/api/auth/state", async (req) => ({
    hasPassword: hub.auth.hasPassword(),
    authenticated: !!hub.auth.session(req.cookies[COOKIE], "main"),
    // Passkeys belong to the computer's address: through the link it is the password.
    passkeys: remote ? 0 : hub.auth.listPasskeys().length,
    version: cfg.version,
    language: hubLocale(),
    locales: LOCALES,
  }));

  if (!remote) {
    app.post("/api/auth/setup", async (req, reply) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      const b = req.body as { token?: string; password?: string };
      hub.auth.setup(String(b?.token ?? ""), String(b?.password ?? ""), clientIp(req));
      // The first user's browser language becomes the hub language unless OWLBOT_LANG pins it.
      if (!localeFromEnv({ OWLBOT_LANG: process.env.OWLBOT_LANG })) hub.settings.update({ language: requestLocale(req) });
      const { token } = hub.auth.createSession("main");
      setCookie(reply, token);
      return { ok: true };
    });

    // The desktop app's own window: a one-time ticket the app gave the hub over its stdin (desktop-login.ts).
    app.post("/api/auth/desktop", async (req, reply) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      if (!hub.auth.hasPassword()) throw new AuthError(409, "auth.noPassword");
      const ticket = String((req.body as { ticket?: string })?.ticket ?? "");
      if (!hub.desktopTickets.consume(ticket)) {
        hub.audit.append("user", "auth.failure", "desktop", { ip: clientIp(req) });
        throw new AuthError(401, "auth.badDesktopTicket");
      }
      const { token } = hub.auth.createSession("main");
      hub.audit.append("user", "auth.desktop");
      setCookie(reply, token);
      return { ok: true };
    });
  }

  app.post("/api/auth/login", async (req, reply) => {
    if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
    const b = req.body as { password?: string };
    hub.auth.verifyPassword(String(b?.password ?? ""), clientIp(req), { remote: !!remote });
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  if (!remote) {
    app.post("/api/auth/passkey/options", async (req) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      return hub.auth.passkeyLoginOptions();
    });

    app.post("/api/auth/passkey/verify", async (req, reply) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      await hub.auth.passkeyLogin((req.body as any)?.response, clientIp(req));
      const { token } = hub.auth.createSession("main");
      setCookie(reply, token);
      return { ok: true };
    });
  }

  app.post("/api/auth/logout", async (req, reply) => {
    hub.auth.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---------- public: MCP for brains (a session's bearer token; machines paired through the link use it too) ----------

  app.post("/mcp", async (req, reply) => {
    const session = hub.mcp.authenticate(req.headers.authorization);
    if (!session) {
      reply.code(401).header("www-authenticate", 'Bearer realm="owlbot"');
      return { jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid session token" } };
    }
    const out = await hub.mcp.handle(session, req.body);
    if (out === undefined) return reply.code(202).send();
    return out;
  });
  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send());
  app.delete("/mcp", async () => ({}));

  // ---------- public: machine nodes ----------

  // Wrong invite codes, from a machine pairing or the invite page: 10 per address in 15 minutes.
  const pairBudget = new FailureBudget(10, 15 * 60_000);
  app.post("/api/node/pair", async (req) => {
    if (pairBudget.exhausted(req)) throw new HttpError(429, "auth.tooManyAttempts");
    try {
      const b = req.body as any;
      const m = hub.machines.pair({ code: String(b?.code ?? ""), publicKey: String(b?.publicKey ?? ""), name: b?.name, info: b?.info });
      return { machineId: m.id, name: m.name };
    } catch (e: any) {
      pairBudget.fail(req);
      throw e instanceof LocalizedError ? new HttpError(400, e.key, e.params) : new HttpError(400, e.message);
    }
  });

  app.get("/node/ws", { websocket: true }, (socket, req) => {
    hub.machines.attach(socket as any, clientIp(req));
  });

  // The invite's page and the desktop installers (join-page.ts).
  registerJoinPage(app, hub, { remote: !!remote, budget: pairBudget });

  // Single-file machine daemon (public code, no secrets): `node owlbot-node.mjs pair <hub> <code>`.
  app.get("/download/owlbot-node.mjs", async (_req, reply) => {
    const file = join(cfg.appRoot, "packages", "node", "dist", "owlbot-node.mjs");
    if (!existsSync(file)) throw new HttpError(404, "build.daemonMissing");
    return sendFile(reply, file, { download: true });
  });

  // ---------- public: plugin webhooks ----------

  if (!remote) {
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

    // ---------- Google sends the browser back here after the sign-in (state is the proof, no session needed) ----------

    app.get("/oauth/callback", async (req, reply) => {
      const t = tFor(requestLocale(req));
      let ok = true;
      let detail = "";
      try {
        const r = await hub.connections.complete(new URLSearchParams((req.url.split("?")[1] ?? "")));
        hub.connectionDone(r.account, r.origin);
        detail = r.account.account;
      } catch (e) {
        ok = false;
        detail = errorText(e, requestLocale(req));
      }
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
      const title = t(ok ? "oauth.doneTitle" : "oauth.failedTitle");
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}h1{font-size:1.4rem}a{color:inherit}</style></head>
  <body><h1>${esc(title)}</h1><p>${esc(ok ? `${detail}. ${t("oauth.doneText")}` : detail)}</p><p><a href="${esc(cfg.publicUrl)}">${esc(t("oauth.back"))}</a></p></body></html>`;
      return reply.code(ok ? 200 : 400).header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").send(html);
    });
  }

  // The local-only routes do not exist on the link: say so instead of serving the page.
  if (remote) for (const path of ["/hooks/*", "/oauth/callback"]) app.all(path, async () => Promise.reject(new HttpError(404, "not found")));

  // ---------- authenticated API ----------

  await app.register(async (api) => {
    api.addHook("preHandler", guard);
    await registerApi(api, hub, {
      kind: "web",
      bootstrap: (req) => ({ csrf: req.authSession!.csrf }),
      wsAllowed: (req) => originAllowed(req, origins()),
      authenticate: guard,
    });
  });

  // ---------- pages agents make: their links are their capability, no session ----------

  await registerPages(app, hub);

  // ---------- SPA ----------

  registerSpa(app, cfg.webDist, () => true);

  return app;
}
