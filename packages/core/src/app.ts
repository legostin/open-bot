// Hub composition root: builds every core service, wires them together, starts/stops servers.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, ConnectionAccount, CoreMethod, DeviceNetwork, DevicePairing } from "@owlbot/shared";
import { DEFAULT_LOCALE, catalogLookup, formatBrainRef, localizeValue, normalizeLocale, parseBrainRef } from "@owlbot/shared";
import type { Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { Settings, type CoreSettings } from "./settings.ts";
import { VaultService } from "./vault/service.ts";
import { AuditLog } from "./audit.ts";
import { RuleStore } from "./policy/rules.ts";
import { ApprovalService } from "./approvals.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { HookRegistry } from "./hooks.ts";
import { ToolGateway } from "./tools/gateway.ts";
import { AgentRegistry, agentFromMarkdown, agentName } from "./agents.ts";
import { SkillIndex } from "./skills.ts";
import { PluginHost } from "./plugins/host.ts";
import { EgressProxy } from "./egress.ts";
import { BrainRegistry } from "./brains.ts";
import { ChannelRegistry } from "./channels.ts";
import { Notifier } from "./notifier.ts";
import { SessionRunner } from "./runner.ts";
import { Team } from "./team.ts";
import { registerCoreTools } from "./tools/core-tools.ts";
import { McpEndpoint } from "./mcp/server.ts";
import { McpClientManager } from "./mcp/client.ts";
import { AuthService } from "./auth.ts";
import { DesktopTickets } from "./desktop-login.ts";
import { MachineHub } from "./machines.ts";
import { MachineActivityFeed } from "./activity.ts";
import { DeviceRegistry } from "./devices.ts";
import { deviceTls, type DeviceTls } from "./devices-tls.ts";
import { deviceUrls, hubName, pairingLink, qrSvg } from "./pairing.ts";
import { createCoreCall } from "./core-call.ts";
import { configureHubLocale, coreCatalog, hubLocale, localizePluginValue, LocalizedError, t } from "./i18n.ts";
import { registerHubTools, slug } from "./tools/hub-tools.ts";
import { SecretIntake } from "./secrets.ts";
import { AgentDrafts } from "./agent-drafts.ts";
import { BrainLogins } from "./brain-login.ts";
import { CliTools } from "./cli-tools.ts";
import { UserPath } from "./user-path.ts";
import { SetupGuide } from "./setup.ts";
import { MediaService } from "./media.ts";
import { Connections } from "./connections.ts";
import { cleanTranscription, Transcriber } from "./transcribe.ts";
import { RemoteAccess } from "./remote.ts";
import { buildMainApp } from "./server/main-app.ts";
import { buildConsoleApp } from "./server/console-app.ts";
import { buildDeviceApp } from "./server/device-app.ts";
import type { FastifyInstance } from "fastify";

export class Hub {
  config: Config;
  db: Db;
  bus = new EventBus();
  store: Store;
  settings: Settings;
  vault: VaultService;
  audit: AuditLog;
  rules: RuleStore;
  approvals: ApprovalService;
  tools = new ToolRegistry();
  hooks = new HookRegistry();
  gateway: ToolGateway;
  agents: AgentRegistry;
  skills = new SkillIndex();
  egress = new EgressProxy();
  brains = new BrainRegistry();
  channels: ChannelRegistry;
  notifier: Notifier;
  runner: SessionRunner;
  team: Team;
  plugins: PluginHost;
  mcp: McpEndpoint;
  mcpClients: McpClientManager;
  auth: AuthService;
  /** One-time sign-in tickets from the desktop app (see desktop-login.ts). */
  desktopTickets = new DesktopTickets();
  machines: MachineHub;
  /** What every machine is doing now, for the machines block (activity.ts). */
  activity: MachineActivityFeed;
  /** Phones paired with the hub (the Owlbot app) and the device port they talk to. */
  devices: DeviceRegistry;
  deviceApp?: FastifyInstance;
  private deviceError?: string;
  private deviceSync: Promise<unknown> = Promise.resolve();
  secrets: SecretIntake;
  agentDrafts: AgentDrafts;
  brainLogins: BrainLogins;
  cliTools: CliTools;
  /** Where the user's own CLIs live (their shell or account PATH): read on desktop installs, which start with a short PATH. */
  userPath = new UserPath();
  setup: SetupGuide;
  /** External images and OpenStreetMap tiles the web UI shows, fetched and cached by the hub. */
  media: MediaService;
  connections: Connections;
  transcriber: Transcriber;
  /** Access from anywhere: the hub's Tailscale node and its link (remote.ts). */
  remote: RemoteAccess;
  /** The link's gateways on loopback: the web UI and the phones, behind the node. */
  private remoteGateways?: { web: FastifyInstance; device: FastifyInstance; ports: { web: number; device: number } };
  mainApp?: FastifyInstance;
  consoleApp?: FastifyInstance;
  private timers: NodeJS.Timeout[] = [];

  constructor(config: Config) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = openDb(join(config.dataDir, "owlbot.db"));
    this.store = new Store(this.db, this.bus);
    this.settings = new Settings(this.db, config.timezone);
    configureHubLocale(() => normalizeLocale(this.settings.get().language) ?? DEFAULT_LOCALE);
    this.vault = new VaultService(join(config.dataDir, "vault.db"), {
      onState: (state) => this.bus.emit("vault.state", { state }),
      onAccess: (e) => this.audit.append(e.actor, e.allowed ? "vault.access" : "vault.denied", e.itemId, e.reason ? { reason: e.reason } : undefined),
    });
    this.audit = new AuditLog(this.db, this.vault.redactor);
    this.egress.audit = this.audit;
    this.egress.extraBrainAllow = () => this.settings.get().brainEgressAllow;
    this.egress.privateAllow = () => this.settings.get().egressPrivateAllow;
    this.rules = new RuleStore(this.db);
    this.approvals = new ApprovalService(this.db, this.bus, this.audit, this.rules);
    this.agents = new AgentRegistry(config.builtinAgentsDir, join(config.dataDir, "agents"));
    this.channels = new ChannelRegistry(this.vault.redactor);
    this.notifier = new Notifier({
      db: this.db,
      bus: this.bus,
      settings: this.settings,
      channels: this.channels,
      hooks: this.hooks,
      store: this.store,
      sign: (p) => this.approvals.sign(p),
      publicUrl: config.publicUrl,
      hasAgent: (id) => !!this.agents.get(id),
    });
    this.gateway = new ToolGateway({
      store: this.store,
      registry: this.tools,
      hooks: this.hooks,
      rules: this.rules,
      approvals: this.approvals,
      audit: this.audit,
      redactor: this.vault.redactor,
      settings: this.settings,
      agents: this.agents,
      workspaceFor: (s) => this.runner.workspacePath(s),
      // "%key%" approval summaries resolve against the owner's messages in the hub language.
      localize: (owner, text) =>
        owner === "core" ? localizeValue(text, catalogLookup(coreCatalog, hubLocale())) : localizePluginValue(this.plugins.get(owner)?.layout, text, hubLocale()),
    });
    this.machines = new MachineHub({ db: this.db, bus: this.bus, brains: this.brains, audit: this.audit });
    this.activity = new MachineActivityFeed(this.bus, this.machines);
    this.devices = new DeviceRegistry({ db: this.db, bus: this.bus, audit: this.audit });
    this.secrets = new SecretIntake({ db: this.db, bus: this.bus, audit: this.audit, vault: this.vault, plugins: () => this.plugins });
    this.agentDrafts = new AgentDrafts({ db: this.db, bus: this.bus });
    this.cliTools = new CliTools(config.dataDir, config.installClis);
    this.brainLogins = new BrainLogins({ brains: this.brains, bus: this.bus, egress: this.egress, audit: this.audit, egressPort: () => this.config.egressPort, tools: this.cliTools });
    // The vault holds the keys; a sealed vault means no speech-to-text until it is unlocked.
    this.transcriber = new Transcriber({
      settings: () => this.settings.get().transcription,
      hasSecret: (id) => this.vault.state() === "unlocked" && !!this.vault.getMeta(id),
      secret: (ref) => this.vault.access(ref, { actor: "core:transcription" }).value ?? "",
    });
    this.runner = new SessionRunner({
      config,
      store: this.store,
      settings: this.settings,
      agents: this.agents,
      brains: this.brains,
      skills: this.skills,
      hooks: this.hooks,
      notifier: this.notifier,
      channels: this.channels,
      audit: this.audit,
      bus: this.bus,
      redactor: this.vault.redactor,
      gateway: this.gateway,
      approvals: this.approvals,
      egress: this.egress,
      claudePluginDirs: () => this.plugins.enabledLayouts().filter((l) => l.formats.includes("claude") && !l.manifest.builtin).map((l) => l.dir),
      machineName: (id) => this.machines.name(id),
      machines: () => this.machines.list(),
      activity: this.activity,
      secrets: this.secrets,
      transcriber: this.transcriber,
    });
    this.setup = new SetupGuide({
      brains: this.brains,
      agents: this.agents,
      settings: this.settings,
      store: this.store,
      vault: this.vault,
      channels: this.channels,
      machines: this.machines,
      cliTools: this.cliTools,
      bus: this.bus,
      resume: (id, prompt, opts) => this.runner.resume(id, prompt, opts),
      tellAgent: (id, note) => this.runner.tellAgent(id, note),
    });
    this.runner.d.setup = this.setup;
    this.team = new Team({
      store: this.store,
      agents: this.agents,
      bus: this.bus,
      isRunning: (id) => this.runner.isRunning(id),
      floor: (id) => this.runner.floor(id),
    });
    this.mcpClients = new McpClientManager({ config, registry: this.tools, vault: this.vault, audit: this.audit, egress: this.egress });
    this.plugins = new PluginHost({
      config,
      db: this.db,
      bus: this.bus,
      tools: this.tools,
      hooks: this.hooks,
      vault: this.vault,
      audit: this.audit,
      egress: this.egress,
      brains: this.brains,
      channels: this.channels,
      coreCall: createCoreCall(this),
      onLayoutsChanged: () => this.reindex(),
      // The user's own CLIs first, then the ones the hub installed: a CLI the user installed wins.
      cliBinDirs: () => [...this.userPath.dirs(), ...this.cliTools.binDirs()],
    });
    this.mcp = new McpEndpoint(this.gateway, this.store, config.version);
    this.media = new MediaService({ dataDir: config.dataDir, version: config.version, resolve: (host) => this.egress.resolveTarget(host) });
    this.connections = new Connections({
      google: config.google,
      vault: this.vault,
      settings: this.settings,
      bus: this.bus,
      audit: this.audit,
      redirectUri: () => `${this.config.internalUrl}/oauth/callback`,
    });
    const rpId = new URL(config.publicUrl).hostname;
    this.auth = new AuthService(this.db, this.audit, {
      rpId,
      origins: [new URL(config.publicUrl).origin, new URL(config.consoleUrl).origin],
      setupToken: process.env.OWLBOT_SETUP_TOKEN,
    });
    this.auth.onRemotePause = () => {
      void this.notifier.notify({ level: "notify", title: t("remote.pausedTitle"), body: t("remote.pausedBody") }).catch(() => {});
    };
    this.remote = new RemoteAccess({
      config,
      settings: this.settings,
      bus: this.bus,
      deviceTls: () => this.deviceTls(),
      gateways: { start: () => this.startRemoteGateways(), stop: () => this.stopRemoteGateways() },
      hasPassword: () => this.auth.hasPassword(),
    });
    // The link is one of the phones' addresses: the Devices page follows it.
    this.bus.on("remote.updated", () => this.bus.emit("devices.network", this.deviceNetwork()));
    registerCoreTools({
      registry: this.tools,
      skills: this.skills,
      vault: this.vault,
      store: this.store,
      notifier: this.notifier,
      agents: this.agents,
      createTask: (t) => this.runner.createTask(t),
      tasks: {
        place: (agentId, machine) => this.runner.placeTask(agentId, machine),
        ask: (taskId, question) => this.runner.askStarter(taskId, question),
        message: (taskId, text, from) => this.runner.messageTask(taskId, text, from),
        cancel: (taskId, from) => this.runner.cancelTaskFrom(taskId, from),
        computers: () => this.runner.computers(),
        teammate: (to, text, from) => this.runner.messageTeammate(to, text, from),
      },
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
      workspacesRoot: join(config.dataDir, "workspaces"),
      transcriber: this.transcriber,
    });
    this.machines.registerTools(this.tools);
    registerHubTools(this);
    // A brain signed in from a card the assistant showed: the assistant hears it and carries on.
    this.brainLogins.onSignedIn = (s, label, conversationId) =>
      this.runner.tellAgent(conversationId, `[System] The user signed ${label} (${s.ref}) in from the chat card; it is ready now. Carry on with what it was needed for.`);
    this.brains.onChange = () => this.bus.emit("brains.updated", {});
    // A key or token saved from the chat may sign a brain in: check again now, not in five minutes.
    this.bus.on("vault.updated", () => {
      this.brains.invalidateAll();
      this.bus.emit("brains.updated", {});
    });
    this.wireChannelsForApprovals();
  }

  /** A Google account was connected: the agent whose chat showed the card hears it and carries on. */
  connectionDone(account: ConnectionAccount, origin?: { integration?: string; conversationId?: string }): void {
    if (!origin?.conversationId || !this.store.getConversation(origin.conversationId)) return;
    const what = origin.integration ? ` (${origin.integration})` : "";
    this.runner.tellAgent(origin.conversationId, `[System] The user connected Google as ${account.account}${what}; it works now. Carry on with what it was needed for.`);
  }

  /** Every settings change (web UI or the assistant's hub tools): validation, audit, language broadcast, live UI refresh. */
  updateSettings(patch: Record<string, unknown>, actor: string): CoreSettings {
    const p = { ...patch };
    if ("language" in p) {
      const l = normalizeLocale(p.language);
      if (!l) throw new LocalizedError("settings.badLanguage", { value: String(p.language) }, 400);
      p.language = l;
    }
    if ("defaultAgent" in p && !this.agents.get(String(p.defaultAgent))) throw new LocalizedError("agent.notFound", undefined, 400);
    if ("transcription" in p) {
      const t = cleanTranscription(p.transcription);
      if (typeof t === "string") throw new LocalizedError("settings.badTranscription", { reason: t }, 400);
      p.transcription = t;
    }
    const before = this.settings.get().language;
    this.audit.append(actor, "settings.update", undefined, { keys: Object.keys(p) });
    const next = this.settings.update(p as Partial<CoreSettings>);
    if (next.language !== before) {
      this.plugins.broadcastLocale(next.language);
      this.machines.broadcastLocale(next.language);
      this.brains.invalidateAll();
    }
    this.bus.emit("settings.updated", { keys: Object.keys(p) });
    return next;
  }

  /** The device port's identity (made on first use) and state, for the web UI and the pairing QR. */
  deviceTls(): DeviceTls {
    return deviceTls(this.config.dataDir);
  }

  deviceNetwork(): DeviceNetwork {
    return {
      enabled: !this.config.devicesOff,
      listening: !!this.deviceApp,
      port: this.config.devicePort,
      urls: deviceUrls(this.config.devicePort, this.config.deviceUrls, undefined, this.remote.deviceLink()),
      ...(this.deviceError ? { error: this.deviceError } : {}),
    };
  }

  /** Start the device port unless OWLBOT_DEVICES=0 closed it; calls are serialized. */
  syncDeviceServer(): Promise<DeviceNetwork> {
    const run = async () => {
      const want = !this.config.devicesOff;
      if (want && !this.deviceApp) {
        this.deviceError = undefined;
        const app = await buildDeviceApp(this, this.deviceTls());
        try {
          await app.listen({ host: this.config.deviceHost, port: this.config.devicePort });
          this.deviceApp = app;
          console.log(`[owlbot] devices: https://${this.config.deviceHost}:${this.config.devicePort}`);
        } catch (e: any) {
          this.deviceError = e?.code === "EADDRINUSE" ? t("device.portInUse", { port: this.config.devicePort }) : String(e?.message ?? e);
          await app.close().catch(() => {});
        }
      } else if (!want && this.deviceApp) {
        const app = this.deviceApp;
        this.deviceApp = undefined;
        await app.close();
      }
      const state = this.deviceNetwork();
      this.bus.emit("devices.network", state);
      return state;
    };
    const next = this.deviceSync.then(run, run);
    this.deviceSync = next.catch(() => {});
    return next;
  }

  /** Where a phone can reach the hub now: the device port's addresses while it listens, and the link while it is up. */
  phoneUrls(): string[] {
    const link = this.remote.deviceLink();
    if (this.deviceApp) return deviceUrls(this.config.devicePort, this.config.deviceUrls, undefined, link);
    return link ? [link] : [];
  }

  /** A one-time code and the QR for a phone; the device port or the link must be up. */
  devicePairing(): DevicePairing {
    const network = this.deviceNetwork();
    if (!network.listening && !this.remote.deviceLink()) throw new LocalizedError("device.networkOff", undefined, 409);
    const urls = this.phoneUrls();
    if (!urls.length) throw new LocalizedError("device.noAddress", undefined, 409);
    const { fingerprint } = this.deviceTls();
    const { code, expiresAt } = this.devices.createPairingCode();
    const link = pairingLink({ code, hubName: hubName(), fingerprint, urls });
    return { code, expiresAt, link, qrSvg: qrSvg(link), urls, fingerprint };
  }

  /** The link's gateways (remote.ts): the web UI and the phones' API on loopback ports only the node is told. */
  private async startRemoteGateways(): Promise<{ web: number; device: number }> {
    if (this.remoteGateways) return this.remoteGateways.ports;
    const web = await buildMainApp(this, { remote: { host: () => this.remote.linkHost() } });
    const device = await buildDeviceApp(this, this.deviceTls(), { remote: true });
    try {
      await web.listen({ host: "127.0.0.1", port: 0 });
      await device.listen({ host: "127.0.0.1", port: 0 });
    } catch (e) {
      await web.close().catch(() => {});
      await device.close().catch(() => {});
      throw e;
    }
    const port = (app: FastifyInstance) => (app.server.address() as { port: number }).port;
    this.remoteGateways = { web, device, ports: { web: port(web), device: port(device) } };
    return this.remoteGateways.ports;
  }

  private async stopRemoteGateways(): Promise<void> {
    const g = this.remoteGateways;
    this.remoteGateways = undefined;
    await g?.web.close();
    await g?.device.close();
  }

  /** Where "unlock automatically after restarts" keeps the vault passphrase (hub-only file, like a Docker secret). */
  rememberedPassphraseFile(): string {
    return join(this.config.dataDir, "vault.passphrase");
  }

  /** Remember the passphrase for automatic unlock, or forget it (undefined). */
  rememberVaultPassphrase(passphrase: string | undefined): void {
    const file = this.rememberedPassphraseFile();
    if (passphrase === undefined) rmSync(file, { force: true });
    else writeFileSync(file, passphrase, { mode: 0o600 });
  }

  /** "Check again" on the setup card: look for the user's CLIs again (restarting the brain hosts when they moved) and re-probe. */
  async refreshBrains(): Promise<void> {
    if (this.config.installClis && (await this.userPath.refresh())) {
      for (const r of this.plugins.list()) {
        if (r.enabled && r.source === "builtin" && r.layout?.manifest.contributes.brains.length) await this.plugins.restart(r.id).catch(() => {});
      }
    }
    this.brains.invalidateAll();
    this.bus.emit("brains.updated", {});
  }

  saveAgent(agent: AgentDef, actor: string): AgentDef {
    const refs = (a: AgentDef | undefined) => a?.brains.map((b) => formatBrainRef(parseBrainRef(b))).join("\n");
    const before = this.agents.get(agent.id);
    const saved = this.agents.save(agent);
    if (before && refs(before) !== refs(saved)) this.runner.brainsChanged(saved.id);
    this.audit.append(actor, "agent.save", saved.id);
    this.bus.emit("agents.updated", {});
    return saved;
  }

  /** A draft from the chat joins the team under a fresh id derived from its name; it never replaces an existing agent. */
  createAgentFromDraft(draftId: string, actor: string): AgentDef {
    const d = this.agentDrafts.open(draftId);
    const base = slug(d.name);
    let id = base;
    for (let n = 2; this.agents.get(id); n++) id = `${base.slice(0, 36)}-${n}`;
    const saved = this.saveAgent(
      {
        ...agentFromMarkdown(id, "", "user"),
        id,
        name: d.name,
        description: d.description,
        prompt: d.prompt,
        avatar: d.avatar,
        brains: d.brains,
        ...(d.initiative !== undefined ? { initiative: d.initiative } : {}),
        source: "user",
      },
      actor,
    );
    this.agentDrafts.markCreated(d.id, saved.id);
    return saved;
  }

  /** The agent leaves the team (and the sidebar); its dialog and messages stay in the database. */
  removeAgent(id: string, actor: string): void {
    if (id === "assistant" && this.agents.get(id)?.source !== "user") throw new LocalizedError("agent.builtinCannotDelete", undefined, 400);
    this.agents.remove(id);
    this.audit.append(actor, "agent.remove", id);
    // Channels and "/" need a default agent that exists; the built-in assistant always does.
    if (this.settings.get().defaultAgent === id && !this.agents.get(id)) this.updateSettings({ defaultAgent: "assistant" }, "core");
    this.bus.emit("agents.updated", {});
  }

  /** Skills, commands, agents and MCP servers come from enabled plugin layouts + data dir. */
  reindex(): void {
    const layouts = this.plugins?.enabledLayouts() ?? [];
    this.skills.setRoots([
      { source: "user", skillsDir: join(this.config.dataDir, "skills"), commandsDir: join(this.config.dataDir, "commands") },
      ...layouts.map((l) => ({ source: l.manifest.id, skillsDir: l.skillsDir, commandsDir: l.commandsDir })),
    ]);
    this.agents.pluginDirs = layouts.filter((l) => l.agentsDir).map((l) => ({ pluginId: l.manifest.id, dir: l.agentsDir! }));
    this.agents.reload();
    if (this.started) {
      void this.mcpClients.sync(this.pluginMcpFiles());
    }
  }

  private pluginMcpFiles() {
    return (this.plugins?.list() ?? [])
      .filter((r) => r.enabled && r.layout?.mcpFile)
      .map((r) => ({ pluginId: r.id, file: r.layout!.mcpFile!, dir: r.dir, network: r.granted.network }));
  }

  /** Approval cards also go to channels (Telegram) with signed buttons. */
  private wireChannelsForApprovals(): void {
    this.bus.on("approval.created", (a) => {
      const s = this.settings.get();
      const agent = this.agents.get(a.agentId);
      const name = agent ? agentName(agent, hubLocale()) : a.agentId;
      const text = s.channelApprovalDetails
        ? `${t("approval.channelAsk", { agent: name, summary: a.summary })}${a.tainted ? `\n\n${t("approval.taintedNote")}` : ""}`
        : `${t("approval.channelAskTool", { agent: name, tool: a.tool })}${a.tainted ? `\n${t("approval.taintedNote")}` : ""}`;
      void this.channels.broadcast({
        kind: "approval",
        text,
        link: `${this.config.consoleUrl}/#/approvals/${a.id}`,
        approval: { id: a.id, summary: a.summary, approveToken: this.approvals.token(a.id, "approve"), denyToken: this.approvals.token(a.id, "deny") },
      });
    });
  }

  private started = false;

  async start(opts: { listen?: boolean } = {}): Promise<void> {
    const cfg = this.config;
    if (cfg.isolation.users) process.umask(0o002);
    for (const d of ["workspaces", "skills", "commands", "agents", "plugins", "plugins-data", "home"]) mkdirSync(join(cfg.dataDir, d), { recursive: true });
    const passphraseFile = cfg.vaultPassphraseFile ?? (existsSync(this.rememberedPassphraseFile()) ? this.rememberedPassphraseFile() : undefined);
    if (passphraseFile) this.vault.unlockFromFile(passphraseFile);
    this.audit.append("core", "hub.start", cfg.version);

    await this.egress.listen(cfg.egressPort);
    this.plugins.discover();
    this.started = true;
    this.store.agentConversation(this.settings.get().defaultAgent);

    if (opts.listen !== false) {
      this.mainApp = await buildMainApp(this);
      this.consoleApp = await buildConsoleApp(this);
      await this.mainApp.listen({ host: cfg.host, port: cfg.port });
      await this.consoleApp.listen({ host: cfg.host, port: cfg.consolePort });
      await this.syncDeviceServer();
      await this.remote.start();
    }

    // Desktop installs run from launchd or a tray app; a terminal's `npm start` already has the user's PATH.
    if (cfg.installClis) await this.userPath.refresh();
    if (cfg.plugins !== "none") await this.plugins.startAll(cfg.plugins);
    await this.mcpClients.sync(this.pluginMcpFiles());
    this.mcpClients.onChange = () => this.bus.emit("plugins.updated", {});
    this.runner.start();
    this.setup.start();
    this.notifier.startDigestTimer();
    const sweep = setInterval(() => this.auth.sweep(), 3600_000);
    sweep.unref();
    this.timers.push(sweep);
    const prune = setInterval(() => this.media.prune(), 24 * 3600_000);
    prune.unref();
    this.timers.push(prune);

    if (this.auth.setupToken) {
      const line = "═".repeat(64);
      console.log(`\n${line}\n  ${t("cli.firstRun", { url: cfg.publicUrl, code: this.auth.setupToken })}\n${line}\n`);
    } else {
      console.log(`[owlbot] ready: ${cfg.publicUrl} (console: ${cfg.consoleUrl})`);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.notifier.stop();
    this.setup.stop();
    await this.runner.stop();
    this.machines.closeAll();
    this.activity.close();
    await this.plugins.stopAll();
    await this.mcpClients.closeAll();
    await this.remote.stop();
    await this.mainApp?.close();
    await this.consoleApp?.close();
    await this.deviceSync;
    await this.deviceApp?.close();
    await this.egress.close();
    this.audit.append("core", "hub.stop");
    this.db.close();
    this.vault.db.close();
  }
}

export type { CoreMethod };
