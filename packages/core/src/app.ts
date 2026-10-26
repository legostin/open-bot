// Hub composition root: builds every core service, wires them together, starts/stops servers.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, CoreMethod } from "@openbot/shared";
import { DEFAULT_LOCALE, catalogLookup, localizeValue, normalizeLocale } from "@openbot/shared";
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
import { MachineHub } from "./machines.ts";
import { createCoreCall } from "./core-call.ts";
import { configureHubLocale, coreCatalog, hubLocale, localizePluginValue, LocalizedError, t } from "./i18n.ts";
import { registerHubTools, slug } from "./tools/hub-tools.ts";
import { SecretIntake } from "./secrets.ts";
import { AgentDrafts } from "./agent-drafts.ts";
import { buildMainApp } from "./server/main-app.ts";
import { buildConsoleApp } from "./server/console-app.ts";
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
  machines: MachineHub;
  secrets: SecretIntake;
  agentDrafts: AgentDrafts;
  mainApp?: FastifyInstance;
  consoleApp?: FastifyInstance;
  private timers: NodeJS.Timeout[] = [];

  constructor(config: Config) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = openDb(join(config.dataDir, "openbot.db"));
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
    this.secrets = new SecretIntake({ db: this.db, bus: this.bus, audit: this.audit, vault: this.vault, plugins: () => this.plugins });
    this.agentDrafts = new AgentDrafts({ db: this.db, bus: this.bus });
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
      secrets: this.secrets,
    });
    this.team = new Team({ store: this.store, agents: this.agents, bus: this.bus, isRunning: (id) => this.runner.isRunning(id) });
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
    });
    this.mcp = new McpEndpoint(this.gateway, this.store, config.version);
    const rpId = new URL(config.publicUrl).hostname;
    this.auth = new AuthService(this.db, this.audit, {
      rpId,
      origins: [new URL(config.publicUrl).origin, new URL(config.consoleUrl).origin],
      setupToken: process.env.OPENBOT_SETUP_TOKEN,
    });
    registerCoreTools({
      registry: this.tools,
      skills: this.skills,
      vault: this.vault,
      store: this.store,
      notifier: this.notifier,
      agents: this.agents,
      createTask: (t) => this.runner.createTask(t),
    });
    this.machines.registerTools(this.tools);
    registerHubTools(this);
    this.brains.onChange = () => this.bus.emit("brains.updated", {});
    // A key or token saved from the chat may sign a brain in: check again now, not in five minutes.
    this.bus.on("vault.updated", () => {
      this.brains.invalidateAll();
      this.bus.emit("brains.updated", {});
    });
    this.wireChannelsForApprovals();
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

  saveAgent(agent: AgentDef, actor: string): AgentDef {
    const saved = this.agents.save(agent);
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
    }

    if (cfg.plugins !== "none") await this.plugins.startAll(cfg.plugins);
    await this.mcpClients.sync(this.pluginMcpFiles());
    this.mcpClients.onChange = () => this.bus.emit("plugins.updated", {});
    this.runner.start();
    this.notifier.startDigestTimer();
    const sweep = setInterval(() => this.auth.sweep(), 3600_000);
    sweep.unref();
    this.timers.push(sweep);

    if (this.auth.setupToken) {
      const line = "═".repeat(64);
      console.log(`\n${line}\n  ${t("cli.firstRun", { url: cfg.publicUrl, code: this.auth.setupToken })}\n${line}\n`);
    } else {
      console.log(`[openbot] ready: ${cfg.publicUrl} (console: ${cfg.consoleUrl})`);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.notifier.stop();
    await this.runner.stop();
    this.machines.closeAll();
    await this.plugins.stopAll();
    await this.mcpClients.closeAll();
    await this.mainApp?.close();
    await this.consoleApp?.close();
    await this.egress.close();
    this.audit.append("core", "hub.stop");
    this.db.close();
    this.vault.db.close();
  }
}

export type { CoreMethod };
