// Hub composition root: builds every core service, wires them together, starts/stops servers.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CoreMethod } from "@openbot/shared";
import type { Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { Settings } from "./settings.ts";
import { VaultService } from "./vault/service.ts";
import { AuditLog } from "./audit.ts";
import { RuleStore } from "./policy/rules.ts";
import { ApprovalService } from "./approvals.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { HookRegistry } from "./hooks.ts";
import { ToolGateway } from "./tools/gateway.ts";
import { AgentRegistry } from "./agents.ts";
import { SkillIndex } from "./skills.ts";
import { PluginHost } from "./plugins/host.ts";
import { EgressProxy } from "./egress.ts";
import { BrainRegistry } from "./brains.ts";
import { ChannelRegistry } from "./channels.ts";
import { Notifier } from "./notifier.ts";
import { SessionRunner } from "./runner.ts";
import { registerCoreTools } from "./tools/core-tools.ts";
import { McpEndpoint } from "./mcp/server.ts";
import { McpClientManager } from "./mcp/client.ts";
import { AuthService } from "./auth.ts";
import { MachineHub } from "./machines.ts";
import { createCoreCall } from "./core-call.ts";
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
  plugins: PluginHost;
  mcp: McpEndpoint;
  mcpClients: McpClientManager;
  auth: AuthService;
  machines: MachineHub;
  mainApp?: FastifyInstance;
  consoleApp?: FastifyInstance;
  private timers: NodeJS.Timeout[] = [];

  constructor(config: Config) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = openDb(join(config.dataDir, "openbot.db"));
    this.store = new Store(this.db, this.bus);
    this.settings = new Settings(this.db, config.timezone);
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
    });
    this.machines = new MachineHub({ db: this.db, bus: this.bus, brains: this.brains, audit: this.audit });
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
    this.brains.onChange = () => this.bus.emit("brains.updated", {});
    this.wireChannelsForApprovals();
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
      const text = s.channelApprovalDetails
        ? `🔐 ${agent?.name ?? a.agentId} просит подтвердить:\n${a.summary}${a.tainted ? "\n\n⚠️ Сессия читала внешний контент" : ""}`
        : `🔐 ${agent?.name ?? a.agentId} просит подтвердить действие (${a.tool}).${a.tainted ? "\n⚠️ Сессия читала внешний контент" : ""}`;
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
    if (cfg.vaultPassphraseFile) this.vault.unlockFromFile(cfg.vaultPassphraseFile);
    this.audit.append("core", "hub.start", cfg.version);

    await this.egress.listen(cfg.egressPort);
    this.plugins.discover();
    this.started = true;
    this.store.mainConversation(this.settings.get().defaultAgent);

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
    const t = setInterval(() => this.auth.sweep(), 3600_000);
    t.unref();
    this.timers.push(t);

    if (this.auth.setupToken) {
      const line = "═".repeat(64);
      console.log(`\n${line}\n  open-bot: первый запуск. Откройте ${cfg.publicUrl}\n  и введите код установки: ${this.auth.setupToken}\n${line}\n`);
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
