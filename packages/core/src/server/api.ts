// The authenticated hub API, shared by the web UI (cookie sessions, port 8080) and the phones (device port, bearer
// tokens). The caller adds its own auth hook first; everything here assumes the request comes from the owner.

import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AgentDef, TaskStatus } from "@owlbot/shared";
import { formatBrainRef, LOCALES, parseBrainRef, type Locale } from "@owlbot/shared";
import { hubLocale, localizePluginValue, requestLocale, tFor } from "../i18n.ts";
import type { Hub } from "../app.ts";
import { toUiEvent } from "../bus.ts";
import { agentFromMarkdown, localizedAgent, patchAgent } from "../agents.ts";
import { draftPatch } from "../agent-drafts.ts";
import { HttpError, safeFile, sendFile } from "./http.ts";

export interface ApiOptions {
  kind: "web" | "device";
  /** Extra fields for /api/bootstrap: the web UI's CSRF token, the phone's own device. */
  bootstrap(req: FastifyRequest): Record<string, unknown>;
  /** May this request open the realtime socket (the web UI checks Origin). */
  wsAllowed(req: FastifyRequest): boolean;
  /** Every realtime socket as it opens (the device port closes a revoked phone's sockets). */
  onSocket?(socket: WebSocket, req: FastifyRequest): void;
}

export async function registerApi(api: FastifyInstance, hub: Hub, opts: ApiOptions): Promise<void> {
  const cfg = hub.config;

  api.get("/api/bootstrap", async (req) => {
    const s = hub.settings.get();
    return {
      ...opts.bootstrap(req),
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
    return hub.runner.userMessage((req.params as any).id, text, { channel: opts.kind === "device" ? "app" : "web" });
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
    // The editor showed the name and description in the reader's language: edits to a translated
    // agent go into that translation, so the other languages keep theirs.
    const base = hub.agents.get(id) ?? agentFromMarkdown(id, "", "user");
    const agent: AgentDef = b.markdown ? agentFromMarkdown(id, b.markdown, "user") : { ...patchAgent(base, b, requestLocale(req)), id, source: "user" };
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

  // ----- first-run setup: the setup card in the chat -----
  const setupAgent = (req: FastifyRequest) => {
    const id = String((req.query as any)?.agent ?? (req.body as any)?.agent ?? "");
    return hub.agents.get(id) ? id : undefined;
  };
  api.get("/api/setup", async (req) => hub.setup.state(setupAgent(req)));
  api.post("/api/setup/refresh", async (req) => {
    await hub.refreshBrains();
    return hub.setup.state(setupAgent(req));
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

  // ----- phones: the web UI pairs, renames and revokes them and opens the device port; a phone manages only itself -----
  if (opts.kind === "web") {
    api.get("/api/devices", async () => ({ devices: hub.devices.list(), network: hub.deviceNetwork() }));
    api.put("/api/devices/network", async (req) => {
      hub.updateSettings({ devicesLan: (req.body as { enabled?: unknown } | undefined)?.enabled === true }, "user");
      return hub.syncDeviceServer();
    });
    api.post("/api/devices/pairing", async () => hub.devicePairing());
    api.patch("/api/devices/:id", async (req) => hub.devices.rename((req.params as any).id, String((req.body as any)?.name ?? "")));
    api.delete("/api/devices/:id", async (req) => {
      hub.devices.revoke((req.params as any).id, "user");
      return { ok: true };
    });
  }

  // ----- UI plugin assets: plugin UI modules run in the web UI's page and in the phone's chat page -----
  api.get("/plugins-ui/:id/*", async (req, reply) => {
    const dir = hub.plugins.uiDir((req.params as any).id);
    const file = dir ? safeFile(dir, (req.params as any)["*"]) : undefined;
    if (!file) throw new HttpError(404, "not found");
    return sendFile(reply, file);
  });

  // ----- realtime -----
  api.get("/api/ws", { websocket: true }, (socket, req) => {
    if (!opts.wsAllowed(req)) {
      socket.close(4403, "origin");
      return;
    }
    const send = (ev: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(ev));
    };
    opts.onSocket?.(socket as unknown as WebSocket, req);
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
}
