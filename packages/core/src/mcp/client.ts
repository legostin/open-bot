// External MCP servers (user's mcp.json and plugins' .mcp.json). Their tools are registered in the ToolRegistry
// as `<server>_<tool>` and therefore go through the same policy/approval/audit path as everything else.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "@openbot/shared";
import type { Config } from "../config.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { sanitizeToolName } from "../tools/registry.ts";
import type { VaultService } from "../vault/service.ts";
import type { AuditLog } from "../audit.ts";
import type { EgressProxy } from "../egress.ts";
import { passEnv, scrubEnv, sudoSpawn } from "../plugins/host.ts";
import { t } from "../i18n.ts";

export interface McpServerConfig {
  type?: "stdio" | "http" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Hosts the server may reach (stdio servers). Default for user servers: any. */
  network?: string[];
}

export interface McpServerStatus {
  name: string;
  source: string; // "user" or plugin id
  status: "connecting" | "connected" | "error" | "disabled";
  error?: string;
  tools: string[];
  config: McpServerConfig;
}

interface Conn {
  name: string;
  source: string;
  config: McpServerConfig;
  client?: Client;
  status: McpServerStatus["status"];
  error?: string;
  tools: string[];
}

const TOOL_TIMEOUT = 10 * 60_000;

export class McpClientManager {
  private conns = new Map<string, Conn>();
  config: Config;
  registry: ToolRegistry;
  vault: VaultService;
  audit: AuditLog;
  egress: EgressProxy;
  onChange?: () => void;

  constructor(d: { config: Config; registry: ToolRegistry; vault: VaultService; audit: AuditLog; egress: EgressProxy }) {
    this.config = d.config;
    this.registry = d.registry;
    this.vault = d.vault;
    this.audit = d.audit;
    this.egress = d.egress;
  }

  get userFile(): string {
    return join(this.config.dataDir, "mcp.json");
  }

  readUserServers(): Record<string, McpServerConfig> {
    if (!existsSync(this.userFile)) return {};
    try {
      const j = JSON.parse(readFileSync(this.userFile, "utf8"));
      return (j.mcpServers ?? j) as Record<string, McpServerConfig>;
    } catch (e) {
      console.error("[mcp] cannot parse mcp.json:", (e as Error).message);
      return {};
    }
  }

  writeUserServers(servers: Record<string, McpServerConfig>): void {
    writeFileSync(this.userFile, JSON.stringify({ mcpServers: servers }, null, 2));
  }

  /** Reconcile running connections with the desired set. */
  async sync(pluginMcpFiles: Array<{ pluginId: string; file: string; dir: string; network: string[] }>): Promise<void> {
    const desired = new Map<string, { source: string; config: McpServerConfig }>();
    for (const [name, cfg] of Object.entries(this.readUserServers())) desired.set(sanitizeToolName(name), { source: "user", config: cfg });
    for (const p of pluginMcpFiles) {
      try {
        const j = JSON.parse(readFileSync(p.file, "utf8"));
        for (const [name, cfg] of Object.entries((j.mcpServers ?? j) as Record<string, McpServerConfig>)) {
          const expanded = expandPluginRoot(cfg, p.dir);
          expanded.network = expanded.network ?? p.network;
          desired.set(sanitizeToolName(`${p.pluginId}-${name}`), { source: p.pluginId, config: expanded });
        }
      } catch (e) {
        console.error(`[mcp] cannot read ${p.file}:`, (e as Error).message);
      }
    }
    for (const [name, c] of this.conns) {
      const want = desired.get(name);
      if (!want || JSON.stringify(want.config) !== JSON.stringify(c.config)) await this.disconnect(name);
    }
    await Promise.all(
      [...desired].filter(([name]) => !this.conns.has(name)).map(([name, d]) => this.connect(name, d.source, d.config)),
    );
    this.onChange?.();
  }

  list(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({ name: c.name, source: c.source, status: c.status, error: c.error, tools: c.tools, config: redactConfig(c.config) }));
  }

  /** Replace vault://id references in env/headers with secret values (scoped to tool owner mcp:<name>). */
  private resolveSecrets(name: string, values: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) {
      const m = /^vault:\/\/([\w.-]+)(?:#(\w+))?$/.exec(v);
      if (!m) {
        out[k] = v;
        continue;
      }
      const fields = this.vault.access(m[1], { actor: `mcp:${name}`, tool: `mcp:${name}` });
      out[k] = fields[m[2] ?? "value"] ?? fields.password ?? Object.values(fields)[0] ?? "";
    }
    return out;
  }

  private async connect(name: string, source: string, config: McpServerConfig): Promise<void> {
    const conn: Conn = { name, source, config, status: config.disabled ? "disabled" : "connecting", tools: [] };
    this.conns.set(name, conn);
    if (config.disabled) return;
    try {
      const client = new Client({ name: "openbot-hub", version: this.config.version });
      const type = config.type ?? (config.url ? "http" : "stdio");
      if (type === "stdio") {
        if (!config.command) throw new Error("command is required");
        const proxyToken = this.egress.issueToken(`mcp:${name}`, config.network ?? (source === "user" ? ["*"] : []));
        const proxy = `http://${proxyToken}:x@127.0.0.1:${this.config.egressPort}`;
        const env = {
          ...this.resolveSecrets(name, config.env),
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NO_PROXY: "127.0.0.1,localhost,::1",
          NODE_USE_ENV_PROXY: "1",
        };
        let command = config.command;
        let args = config.args ?? [];
        let childEnv: Record<string, string>;
        if (this.config.isolation.users) {
          const s = sudoSpawn(this.config.isolation.pluginUser, { ...passEnv(), ...env, HOME: join(this.config.dataDir, "home", "plugin") }, command, args);
          command = s.command;
          args = s.args;
          childEnv = s.env;
        } else {
          childEnv = { ...scrubEnv(process.env), ...env };
        }
        await client.connect(new StdioClientTransport({ command, args, env: childEnv, cwd: config.cwd, stderr: "pipe" }));
      } else {
        if (!config.url) throw new Error("url is required");
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: this.resolveSecrets(name, config.headers) } }));
      }
      conn.client = client;
      const { tools } = await client.listTools();
      for (const t of tools) {
        const full = sanitizeToolName(`${name}_${t.name}`).slice(0, 64);
        const readOnly = !!t.annotations?.readOnlyHint;
        this.registry.register(
          {
            name: full,
            description: `[MCP ${name}] ${t.description ?? ""}`.trim(),
            inputSchema: (t.inputSchema as any) ?? { type: "object" },
            effect: readOnly ? "read" : "external",
            source: true,
            owner: `mcp:${name}`,
          },
          async (input) => {
            const r = await client.callTool({ name: t.name, arguments: input ?? {} }, undefined, { timeout: TOOL_TIMEOUT });
            return normalizeResult(r);
          },
        );
        conn.tools.push(full);
      }
      conn.status = "connected";
      client.onclose = () => {
        if (this.conns.get(name) === conn) {
          conn.status = "error";
          conn.error = t("mcp.connectionClosed");
          this.registry.unregisterOwner(`mcp:${name}`);
          conn.tools = [];
          this.onChange?.();
        }
      };
      this.audit.append("core", "mcp.connect", name, { source, tools: conn.tools.length });
    } catch (e: any) {
      conn.status = "error";
      conn.error = e?.message ?? String(e);
      console.error(`[mcp] ${name}: ${conn.error}`);
    }
  }

  private async disconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    this.conns.delete(name);
    this.registry.unregisterOwner(`mcp:${name}`);
    this.egress.revokeOwner(`mcp:${name}`);
    await c?.client?.close().catch(() => {});
  }

  async reconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    await this.disconnect(name);
    await this.connect(name, c.source, c.config);
    this.onChange?.();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)));
  }
}

function normalizeResult(r: any): ToolResult {
  const content = Array.isArray(r?.content)
    ? r.content.map((c: any) =>
        c.type === "text"
          ? { type: "text" as const, text: String(c.text) }
          : c.type === "image"
            ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
            : { type: "text" as const, text: JSON.stringify(c).slice(0, 20_000) },
      )
    : [{ type: "text" as const, text: JSON.stringify(r?.structuredContent ?? r ?? null).slice(0, 20_000) }];
  return { content, isError: !!r?.isError };
}

function expandPluginRoot(cfg: McpServerConfig, dir: string): McpServerConfig {
  const sub = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", dir).replaceAll("${PLUGIN_ROOT}", dir).replaceAll("${OPENBOT_PLUGIN_ROOT}", dir);
  return {
    ...cfg,
    command: cfg.command ? sub(cfg.command) : undefined,
    args: cfg.args?.map(sub),
    cwd: cfg.cwd ? sub(cfg.cwd) : cfg.command ? dir : undefined,
    env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, sub(v)])) : undefined,
  };
}

function redactConfig(c: McpServerConfig): McpServerConfig {
  const mask = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.startsWith("vault://") ? v : "•••"])) : undefined);
  return { ...c, env: mask(c.env), headers: mask(c.headers) };
}
