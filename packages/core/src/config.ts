import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { BUILTIN_GOOGLE_CLIENT, GOOGLE_ENDPOINTS, type GoogleClientConfig } from "./connections.ts";

export interface Config {
  dataDir: string;
  /** Google sign-in (connections.ts): Owlbot's client unless OWLBOT_GOOGLE_* says otherwise. */
  google: GoogleClientConfig;
  host: string;
  port: number;
  consolePort: number;
  egressPort: number;
  /** The phones' HTTPS port (default port + 2), see server/device-app.ts. */
  devicePort: number;
  /** Where the device port listens: every interface by default, so phones reach it over Wi-Fi and Tailscale. */
  deviceHost: string;
  /** OWLBOT_DEVICES=0 closes the device port: phones then reach the hub only through the link. */
  devicesOff: boolean;
  /** OWLBOT_DEVICE_URLS: addresses for the pairing QR ahead of the detected ones (Docker, reverse proxies). */
  deviceUrls: string[];
  /** URL users and nodes use to reach the main UI / API. */
  publicUrl: string;
  /** The hub's Tailscale node (remote.ts): OWLBOT_TAILNET_BIN, else packages/tailnet/bin/<platform>-<arch>/ in the app. */
  tailnetBin: string;
  /** The node's name in the tailnet, the link's first label (OWLBOT_TAILNET_HOSTNAME, default "owlbot"). */
  tailnetHostname: string;
  /** The OSRM servers show_map asks for routes along roads (routing.ts): OWLBOT_ROUTER_URL, else OpenStreetMap Germany's. */
  routerUrl: string;
  /** URL of the isolated security console. */
  consoleUrl: string;
  /** URL that local child processes (plugins, brains) use to reach the hub. */
  internalUrl: string;
  allowedHosts: string[];
  appRoot: string;
  builtinPluginsDir: string;
  builtinAgentsDir: string;
  webDist: string;
  /** The pages kit's build (packages/pages-kit/dist), which pages run on. */
  pagesKitDir: string;
  consoleDist: string;
  isolation: { users: boolean; hubUser: string; agentUser: string; pluginUser: string };
  egressEnforced: "iptables" | "proxy";
  /** Install missing Claude Code / Codex CLIs into <data>/tools on sign-in (desktop installers; never under isolation). */
  installClis: boolean;
  /**
   * Keep local CLI brains' own tools in their sandbox (macOS Seatbelt; BrainSessionOptions.confine). On by default on
   * macOS, where the brains run as the person; OWLBOT_SANDBOX_BRAINS=0 turns it off. A hub isolated by unix users
   * has its own walls.
   */
  sandboxBrains: boolean;
  /**
   * HOME of the brain CLIs (claude, codex), where their logins live: <data>/home/agent, or OWLBOT_BRAIN_HOME. The
   * desktop app sets that to the user's own home, so a CLI they already signed in to works as is, and Claude Code on
   * macOS finds the login keychain (it looks for it through HOME). Never under user isolation.
   */
  brainHome: string;
  vaultPassphraseFile?: string;
  timezone: string;
  version: string;
  /** GitHub repository whose releases carry the desktop installers (`/download/desktop/<os>`). */
  releasesRepo: string;
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
  const devicePort = Number(env.OWLBOT_DEVICE_PORT ?? port + 2);
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
    devicePort,
    deviceHost: env.OWLBOT_DEVICE_HOST ?? "0.0.0.0",
    devicesOff: env.OWLBOT_DEVICES === "0",
    deviceUrls: (env.OWLBOT_DEVICE_URLS ?? "")
      .split(",")
      .map((u) => u.trim().replace(/\/$/, ""))
      .filter(Boolean),
    publicUrl,
    consoleUrl,
    tailnetBin:
      env.OWLBOT_TAILNET_BIN ?? join(appRoot, "packages", "tailnet", "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "owlbot-tailnet.exe" : "owlbot-tailnet"),
    tailnetHostname: env.OWLBOT_TAILNET_HOSTNAME?.trim() || "owlbot",
    routerUrl: (env.OWLBOT_ROUTER_URL ?? "https://routing.openstreetmap.de").replace(/\/$/, ""),
    internalUrl: `http://127.0.0.1:${port}`,
    google: {
      clientId: env.OWLBOT_GOOGLE_CLIENT_ID ?? BUILTIN_GOOGLE_CLIENT.clientId,
      clientSecret: env.OWLBOT_GOOGLE_CLIENT_SECRET ?? BUILTIN_GOOGLE_CLIENT.clientSecret,
      authUrl: env.OWLBOT_GOOGLE_AUTH_URL ?? GOOGLE_ENDPOINTS.authUrl,
      tokenUrl: env.OWLBOT_GOOGLE_TOKEN_URL ?? GOOGLE_ENDPOINTS.tokenUrl,
      revokeUrl: env.OWLBOT_GOOGLE_REVOKE_URL ?? GOOGLE_ENDPOINTS.revokeUrl,
      userinfoUrl: env.OWLBOT_GOOGLE_USERINFO_URL ?? GOOGLE_ENDPOINTS.userinfoUrl,
    },
    allowedHosts,
    appRoot,
    builtinPluginsDir: join(appRoot, "plugins"),
    builtinAgentsDir: join(appRoot, "agents"),
    webDist: join(appRoot, "packages", "web", "dist"),
    pagesKitDir: join(appRoot, "packages", "pages-kit", "dist"),
    consoleDist: join(appRoot, "packages", "console", "dist"),
    isolation: {
      users: env.OWLBOT_ISOLATION === "users",
      hubUser: env.OWLBOT_HUB_USER ?? "owlbot",
      agentUser: env.OWLBOT_AGENT_USER ?? "agent",
      pluginUser: env.OWLBOT_PLUGIN_USER ?? "plugin",
    },
    egressEnforced: env.OWLBOT_EGRESS_ENFORCED === "iptables" ? "iptables" : "proxy",
    installClis: env.OWLBOT_INSTALL_CLIS === "1" && env.OWLBOT_ISOLATION !== "users",
    sandboxBrains: env.OWLBOT_SANDBOX_BRAINS !== "0" && env.OWLBOT_ISOLATION !== "users" && process.platform === "darwin",
    brainHome: "",
    vaultPassphraseFile: env.OWLBOT_VAULT_PASSPHRASE_FILE && existsSync(env.OWLBOT_VAULT_PASSPHRASE_FILE) ? env.OWLBOT_VAULT_PASSPHRASE_FILE : undefined,
    timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    version: appVersion(),
    releasesRepo: env.OWLBOT_RELEASES_REPO || "legostin/open-bot",
    plugins: (env.OWLBOT_PLUGINS ?? "all") === "all" ? "all" : env.OWLBOT_PLUGINS === "none" ? "none" : (env.OWLBOT_PLUGINS ?? "").split(","),
  };
  const merged = { ...cfg, ...overrides };
  if (!overrides.brainHome) {
    merged.brainHome = env.OWLBOT_BRAIN_HOME && env.OWLBOT_ISOLATION !== "users" ? resolve(env.OWLBOT_BRAIN_HOME) : join(merged.dataDir, "home", "agent");
  }
  return merged;
}

/** The root package.json's version: the desktop installers on GitHub are released under it. */
function appVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version || "0.1.0");
  } catch {
    return "0.1.0";
  }
}

export function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
