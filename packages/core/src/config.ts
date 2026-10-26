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
  /**
   * HOME of the brain CLIs (claude, codex), where their logins live: <data>/home/agent, or OWLBOT_BRAIN_HOME. The
   * desktop app sets that to the user's own home, so a CLI they already signed in to works as is, and Claude Code on
   * macOS finds the login keychain (it looks for it through HOME). Never under user isolation.
   */
  brainHome: string;
  vaultPassphraseFile?: string;
  timezone: string;
  version: string;
  /** For tests: skip starting builtin plugins. */
  plugins: "all" | "none" | string[];
}

const here = fileURLToPath(new URL(".", import.meta.url));
export const APP_ROOT = resolve(here, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const host = env.OWLBOT_HOST ?? "127.0.0.1";
  const port = Number(env.OWLBOT_PORT ?? 8080);
  const consolePort = Number(env.OWLBOT_CONSOLE_PORT ?? port + 1);
  const egressPort = Number(env.OWLBOT_EGRESS_PORT ?? 8089);
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const publicUrl = (env.OWLBOT_PUBLIC_URL ?? `http://${displayHost}:${port}`).replace(/\/$/, "");
  const consoleUrl = (env.OWLBOT_CONSOLE_URL ?? `http://${new URL(publicUrl).hostname}:${consolePort}`).replace(/\/$/, "");
  const extraHosts = (env.OWLBOT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = Array.from(
    new Set(["localhost", "127.0.0.1", "[::1]", displayHost.toLowerCase(), new URL(publicUrl).hostname, new URL(consoleUrl).hostname, ...extraHosts]),
  );
  const appRoot = env.OWLBOT_APP_ROOT ?? APP_ROOT;
  const cfg: Config = {
    dataDir: resolve(env.OWLBOT_DATA_DIR ?? join(appRoot, ".data")),
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
      users: env.OWLBOT_ISOLATION === "users",
      hubUser: env.OWLBOT_HUB_USER ?? "owlbot",
      agentUser: env.OWLBOT_AGENT_USER ?? "agent",
      pluginUser: env.OWLBOT_PLUGIN_USER ?? "plugin",
    },
    egressEnforced: env.OWLBOT_EGRESS_ENFORCED === "iptables" ? "iptables" : "proxy",
    installClis: env.OWLBOT_INSTALL_CLIS === "1" && env.OWLBOT_ISOLATION !== "users",
    brainHome: "",
    vaultPassphraseFile: env.OWLBOT_VAULT_PASSPHRASE_FILE && existsSync(env.OWLBOT_VAULT_PASSPHRASE_FILE) ? env.OWLBOT_VAULT_PASSPHRASE_FILE : undefined,
    timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    version: "0.1.0",
    plugins: (env.OWLBOT_PLUGINS ?? "all") === "all" ? "all" : env.OWLBOT_PLUGINS === "none" ? "none" : (env.OWLBOT_PLUGINS ?? "").split(","),
  };
  const merged = { ...cfg, ...overrides };
  if (!overrides.brainHome) {
    merged.brainHome = env.OWLBOT_BRAIN_HOME && env.OWLBOT_ISOLATION !== "users" ? resolve(env.OWLBOT_BRAIN_HOME) : join(merged.dataDir, "home", "agent");
  }
  return merged;
}

export function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
