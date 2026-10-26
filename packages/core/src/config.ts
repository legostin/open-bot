import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  consolePort: number;
  egressPort: number;
  /** URL users and nodes use to reach the main UI / API. */
  publicUrl: string;
  /** URL of the isolated security console. */
  consoleUrl: string;
  /** URL that local child processes (plugins, brains) use to reach the hub. */
  internalUrl: string;
  allowedHosts: string[];
  appRoot: string;
  builtinPluginsDir: string;
  builtinAgentsDir: string;
  webDist: string;
  consoleDist: string;
  isolation: { users: boolean; hubUser: string; agentUser: string; pluginUser: string };
  egressEnforced: "iptables" | "proxy";
  /** Install missing Claude Code / Codex CLIs into <data>/tools on sign-in (desktop installers; never under isolation). */
  installClis: boolean;
  vaultPassphraseFile?: string;
  timezone: string;
  version: string;
  /** For tests: skip starting builtin plugins. */
  plugins: "all" | "none" | string[];
}

const here = fileURLToPath(new URL(".", import.meta.url));
export const APP_ROOT = resolve(here, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const host = env.OPENBOT_HOST ?? "127.0.0.1";
  const port = Number(env.OPENBOT_PORT ?? 8080);
  const consolePort = Number(env.OPENBOT_CONSOLE_PORT ?? port + 1);
  const egressPort = Number(env.OPENBOT_EGRESS_PORT ?? 8089);
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const publicUrl = (env.OPENBOT_PUBLIC_URL ?? `http://${displayHost}:${port}`).replace(/\/$/, "");
  const consoleUrl = (env.OPENBOT_CONSOLE_URL ?? `http://${new URL(publicUrl).hostname}:${consolePort}`).replace(/\/$/, "");
  const extraHosts = (env.OPENBOT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = Array.from(
    new Set(["localhost", "127.0.0.1", "[::1]", displayHost.toLowerCase(), new URL(publicUrl).hostname, new URL(consoleUrl).hostname, ...extraHosts]),
  );
  const appRoot = env.OPENBOT_APP_ROOT ?? APP_ROOT;
  const cfg: Config = {
    dataDir: resolve(env.OPENBOT_DATA_DIR ?? join(appRoot, ".data")),
    host,
    port,
    consolePort,
    egressPort,
    publicUrl,
    consoleUrl,
    internalUrl: `http://127.0.0.1:${port}`,
    allowedHosts,
    appRoot,
    builtinPluginsDir: join(appRoot, "plugins"),
    builtinAgentsDir: join(appRoot, "agents"),
    webDist: join(appRoot, "packages", "web", "dist"),
    consoleDist: join(appRoot, "packages", "console", "dist"),
    isolation: {
      users: env.OPENBOT_ISOLATION === "users",
      hubUser: env.OPENBOT_HUB_USER ?? "openbot",
      agentUser: env.OPENBOT_AGENT_USER ?? "agent",
      pluginUser: env.OPENBOT_PLUGIN_USER ?? "plugin",
    },
    egressEnforced: env.OPENBOT_EGRESS_ENFORCED === "iptables" ? "iptables" : "proxy",
    installClis: env.OPENBOT_INSTALL_CLIS === "1" && env.OPENBOT_ISOLATION !== "users",
    vaultPassphraseFile: env.OPENBOT_VAULT_PASSPHRASE_FILE && existsSync(env.OPENBOT_VAULT_PASSPHRASE_FILE) ? env.OPENBOT_VAULT_PASSPHRASE_FILE : undefined,
    timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    version: "0.1.0",
    plugins: (env.OPENBOT_PLUGINS ?? "all") === "all" ? "all" : env.OPENBOT_PLUGINS === "none" ? "none" : (env.OPENBOT_PLUGINS ?? "").split(","),
  };
  return { ...cfg, ...overrides };
}

export function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
