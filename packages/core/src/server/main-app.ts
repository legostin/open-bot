// Main web app (port 8080): sign-in, the hub API (server/api.ts) behind cookie sessions, MCP endpoint for brains,
// node daemon endpoints, plugin webhooks and the SPA.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { LOCALES, localeFromEnv } from "@owlbot/shared";
import { errorText, hubLocale, LocalizedError, requestLocale } from "../i18n.ts";
import type { Hub } from "../app.ts";
import { AuthError, type AuthSession } from "../auth.ts";
import { clientIp, hostAllowed, HttpError, originAllowed, originsFor, sendFile } from "./http.ts";
import { registerApi } from "./api.ts";
import { registerSpa } from "./spa.ts";

const COOKIE = "owlbot_session";

declare module "fastify" {
  interface FastifyRequest {
    authSession?: AuthSession;
  }
}

export async function buildMainApp(hub: Hub): Promise<FastifyInstance> {
  const cfg = hub.config;
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: process.env.OWLBOT_TRUST_PROXY === "1" });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  const secure = cfg.publicUrl.startsWith("https://");
  const origins = originsFor(cfg.publicUrl, cfg.allowedHosts, cfg.port);
  if (process.env.OWLBOT_DEV_ORIGIN) origins.push(process.env.OWLBOT_DEV_ORIGIN);

  // Keep raw text for non-JSON bodies (webhooks).
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req, cfg.allowedHosts)) {
      reply.code(421).send({ error: "Host not allowed. Add it to OWLBOT_ALLOWED_HOSTS." });
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
    // The first user's browser language becomes the hub language unless OWLBOT_LANG pins it.
    if (!localeFromEnv({ OWLBOT_LANG: process.env.OWLBOT_LANG })) hub.settings.update({ language: requestLocale(req) });
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  // The desktop app's own window: a one-time ticket the app gave the hub over its stdin (desktop-login.ts).
  app.post("/api/auth/desktop", async (req, reply) => {
    if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
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

  // Single-file machine daemon (public code, no secrets): `node owlbot-node.mjs pair <hub> <code>`.
  app.get("/download/owlbot-node.mjs", async (_req, reply) => {
    const file = join(cfg.appRoot, "packages", "node", "dist", "owlbot-node.mjs");
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
    await registerApi(api, hub, {
      kind: "web",
      bootstrap: (req) => ({ csrf: req.authSession!.csrf }),
      wsAllowed: (req) => originAllowed(req, origins),
      authenticate: guard,
    });
  });

  // ---------- SPA ----------

  registerSpa(app, cfg.webDist, () => true);

  return app;
}
