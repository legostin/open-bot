// open-bot desktop launcher: what the Windows tray app and the macOS LaunchAgent run in an installed app.
//   node launch.mjs        run the hub (data in the user's profile, ports from <data>/desktop.json)
//   node launch.mjs url    wait for the hub and print the address to open (with the setup code until the first run is done)
// A "stop" line on stdin stops the hub cleanly: a windowless child on Windows gets no SIGTERM.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where a desktop install keeps its data: the user's profile, never the app folder. */
export function defaultDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "open-bot");
  if (platform === "darwin") return join(home, "Library", "Application Support", "open-bot");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "open-bot");
}

/** `<data>/desktop.json`: `{ "port": 8080 }` (console port+1, egress proxy port+9 unless given). */
export function desktopPorts(dataDir) {
  let s = {};
  try {
    s = JSON.parse(readFileSync(join(dataDir, "desktop.json"), "utf8"));
  } catch {
    /* defaults */
  }
  const port = Number(s.port) || 8080;
  return { port, consolePort: Number(s.consolePort) || port + 1, egressPort: Number(s.egressPort) || port + 9 };
}

/** The setup code the browser gets in the address fragment; kept until it is used so restarts don't change it. */
export function setupCode(dataDir) {
  const file = join(dataDir, "setup-code");
  try {
    const code = readFileSync(file, "utf8").trim();
    if (/^[\w-]{12,64}$/.test(code)) return code;
  } catch {
    /* first start */
  }
  const code = randomBytes(12).toString("base64url");
  writeFileSync(file, code + "\n", { mode: 0o600 });
  return code;
}

/** The hook that finds @openbot/* without node_modules links (resolve.mjs), for this process's Node children. */
export const RESOLVE_HOOK = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "resolve.mjs")).href;

/** The environment the hub runs with; what the caller already set wins. */
export function hubEnv(env, dataDir) {
  const { port, consolePort, egressPort } = desktopPorts(dataDir);
  const nodeOptions = env.NODE_OPTIONS ?? "";
  return {
    OPENBOT_APP_ROOT: APP_ROOT,
    OPENBOT_PORT: String(port),
    OPENBOT_CONSOLE_PORT: String(consolePort),
    OPENBOT_EGRESS_PORT: String(egressPort),
    // Passkeys need a host name, not 127.0.0.1.
    OPENBOT_PUBLIC_URL: `http://localhost:${port}`,
    OPENBOT_INSTALL_CLIS: "1",
    NODE_ENV: "production",
    // The hub installs the brain CLIs; they must not try to update themselves in its folder.
    DISABLE_AUTOUPDATER: "1",
    ...env,
    // Plugins are Node processes too: they load the same hook.
    NODE_OPTIONS: nodeOptions.includes(RESOLVE_HOOK) ? nodeOptions : `${nodeOptions} --import=${RESOLVE_HOOK}`.trim(),
    OPENBOT_DATA_DIR: dataDir,
    OPENBOT_SETUP_TOKEN: env.OPENBOT_SETUP_TOKEN || setupCode(dataDir),
  };
}

async function run() {
  const dataDir = process.env.OPENBOT_DATA_DIR || defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  await import("./resolve.mjs");
  Object.assign(process.env, hubEnv(process.env, dataDir));
  if (!process.stdin.isTTY) {
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line.trim() === "stop") process.emit("SIGTERM", "SIGTERM");
    });
  }
  const cli = join(APP_ROOT, "packages", "core", "src", "cli.ts");
  process.argv = [process.argv[0], cli, "start"];
  await import(pathToFileURL(cli).href);
}

/** The address to open once the hub answers; the setup code rides in the fragment until someone has set up. */
export async function openUrl(dataDir, { timeoutMs = 90_000, fetchImpl = fetch } = {}) {
  const { port } = desktopPorts(dataDir);
  const base = `http://localhost:${port}/`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/api/auth/state`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const state = await r.json();
        let code = "";
        try {
          code = readFileSync(join(dataDir, "setup-code"), "utf8").trim();
        } catch {
          /* none */
        }
        return { ready: true, url: !state.hasPassword && code ? `${base}#setup=${code}` : base };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ready: false, url: base };
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "url") {
    const r = await openUrl(process.env.OPENBOT_DATA_DIR || defaultDataDir());
    process.stdout.write(r.url + "\n");
    process.exitCode = r.ready ? 0 : 3;
  } else if (cmd === "run") {
    await run();
  } else {
    process.stderr.write("usage: launch.mjs [run|url]\n");
    process.exitCode = 1;
  }
}
