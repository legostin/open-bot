// Blender on this machine: which one (any install of 5.1 or newer), the official MCP add-on in it (Blender Lab's,
// installed from the same release as the server when missing), and opening it so the add-on listens for the server.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export const MIN_VERSION = [5, 1];
export const DEFAULT_PORT = 9876;

export interface Blender {
  bin: string;
  version: string;
  /** The macOS bundle the binary belongs to, opened with `open -a` so Blender outlives the hub. */
  app?: string;
}

export interface AddonState {
  online: boolean;
  /** The official add-on's module (bl_ext.<repo>.mcp), when installed. */
  module?: string;
  version?: string;
  enabled?: boolean;
  port?: number;
  autostart?: boolean;
}

const run = (bin: string, args: string[], timeout: number, env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(bin, args, { timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}\n${stderr}` }),
    ),
  );

const entries = (dir: string, re: RegExp) => {
  try {
    return readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return [];
  }
};

/** Where Blender is usually installed, newest first among what exists; BLENDER_PATH alone when it is set. */
export function candidates(env: NodeJS.ProcessEnv = process.env, os: string = platform()): string[] {
  if (env.BLENDER_PATH) return [env.BLENDER_PATH];
  const home = homedir();
  const out: string[] = [];
  if (os === "darwin") {
    for (const dir of ["/Applications", join(home, "Applications")]) out.push(...entries(dir, /^blender.*\.app$/i).map((n) => join(dir, n, "Contents", "MacOS", "Blender")));
    out.push(join(home, "Library", "Application Support", "Steam", "steamapps", "common", "Blender", "Blender.app", "Contents", "MacOS", "Blender"));
  } else if (os === "win32") {
    for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!pf) continue;
      const foundation = join(pf, "Blender Foundation");
      out.push(...entries(foundation, /^blender/i).map((n) => join(foundation, n, "blender.exe")));
      out.push(join(pf, "Steam", "steamapps", "common", "Blender", "blender.exe"));
    }
  } else {
    out.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender");
    for (const dir of ["/opt", join(home, ".local", "opt"), join(home, "Applications")]) out.push(...entries(dir, /^blender/i).map((n) => join(dir, n, "blender")));
    out.push(join(home, ".local", "share", "Steam", "steamapps", "common", "Blender", "blender"));
  }
  const exe = os === "win32" ? "blender.exe" : "blender";
  for (const dir of (env.PATH ?? "").split(os === "win32" ? ";" : ":")) if (dir) out.push(join(dir, exe));
  return [...new Set(out)].filter((p) => existsSync(p));
}

export function parseVersion(text: string): number[] | undefined {
  const m = /Blender (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/** The newest Blender of 5.1 or later found here, or why there is none. */
export async function findBlender(env: NodeJS.ProcessEnv = process.env): Promise<Blender | { missing: string }> {
  const found = await Promise.all(
    candidates(env).map(async (bin) => {
      const { out } = await run(bin, ["--version"], 30_000);
      return { bin, version: parseVersion(out) };
    }),
  );
  const usable = found.filter((f) => f.version && !newer(MIN_VERSION, f.version)).sort((a, b) => (newer(a.version!, b.version!) ? -1 : 1));
  const best = usable[0];
  if (!best) {
    const old = found.find((f) => f.version);
    return {
      missing: old
        ? `Blender ${old.version!.join(".")} is too old for the official MCP add-on: it needs Blender ${MIN_VERSION.join(".")} or newer (blender.org/download).`
        : `Blender ${MIN_VERSION.join(".")} or newer was not found on this computer. Install it from blender.org/download, or set BLENDER_PATH to its executable.`,
    };
  }
  const app = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(best.bin)?.[1];
  return { bin: best.bin, version: best.version!.join("."), ...(app ? { app } : {}) };
}

/** Blender's own Python (every build ships one): the official server can run on it. */
export function pythonOf(b: Blender): string | undefined {
  const series = b.version.split(".").slice(0, 2).join(".");
  const root = b.app ? join(b.app, "Contents", "Resources", series) : join(b.bin, "..", series);
  const bin = join(root, "python", "bin");
  const exe = entries(bin, /^python(3(\.\d+)?)?(\.exe)?$/).sort((a, b) => b.length - a.length)[0];
  return exe ? join(bin, exe) : undefined;
}

const MARK = "__OWLBOT_BLENDER__";

// Run inside `blender --background`: the official add-on (maintainer "Blender Lab", id "mcp", in any repository).
const CHECK = `
import bpy, addon_utils, json, os, re
r = {"online": bool(bpy.app.online_access)}
for m in addon_utils.modules():
    n = m.__name__
    if not (n.startswith("bl_ext.") and n.endswith(".mcp")):
        continue
    f = os.path.join(os.path.dirname(m.__file__), "blender_manifest.toml")
    t = open(f, encoding="utf-8").read() if os.path.exists(f) else ""
    field = lambda k: (re.search(r'^' + k + r'\\s*=\\s*"([^"]*)"', t, re.M) or [None, ""])[1]
    if field("maintainer") != "Blender Lab":
        continue
    r.update(module=n, version=field("version"), enabled=n in bpy.context.preferences.addons)
    if r["enabled"]:
        p = bpy.context.preferences.addons[n].preferences
        r.update(port=int(getattr(p, "port", ${DEFAULT_PORT})), autostart=bool(getattr(p, "use_autostart", True)))
    break
print("${MARK}" + json.dumps(r))
`;

async function python(b: Blender, code: string): Promise<string> {
  const { out } = await run(b.bin, ["--background", "--python-expr", code], 120_000, blenderEnv());
  return out;
}

export async function addonState(b: Blender): Promise<AddonState> {
  const out = await python(b, CHECK);
  const line = out.split("\n").find((l) => l.startsWith(MARK));
  if (!line) throw new Error(`Blender did not answer the add-on check:\n${out.slice(-1500)}`);
  return JSON.parse(line.slice(MARK.length)) as AddonState;
}

/** The official add-on, enabled: built from the release's own source and installed into the user repository when missing. */
export async function ensureAddon(b: Blender, addonSource: string): Promise<AddonState> {
  let state = await addonState(b);
  if (state.module && !state.enabled) {
    await python(b, `import addon_utils, bpy\naddon_utils.enable(${JSON.stringify(state.module)}, default_set=True, persistent=True)\nbpy.ops.wm.save_userpref()`);
    state = await addonState(b);
  }
  if (!state.module) {
    const tmp = mkdtempSync(join(tmpdir(), "owlbot-blender-addon-"));
    try {
      const zip = join(tmp, "mcp.zip");
      const built = await run(b.bin, ["--background", "--command", "extension", "build", "--source-dir", addonSource, "--output-filepath", zip], 120_000, blenderEnv());
      if (!existsSync(zip)) throw new Error(`Building the official MCP add-on failed:\n${built.out.slice(-1500)}`);
      const installed = await run(b.bin, ["--background", "--command", "extension", "install-file", "--repo", "user_default", "--enable", zip], 120_000, blenderEnv());
      state = await addonState(b);
      if (!state.module) throw new Error(`Installing the official MCP add-on into Blender failed:\n${installed.out.slice(-1500)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (!state.enabled) throw new Error(`The official MCP add-on (${state.module}) is installed in Blender but could not be enabled.`);
  return state;
}

/** Blender's own environment: none of the hub's proxy settings, which belong to this server alone. */
export function blenderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^(https?|all|no)_proxy$/i.test(k) || k === "NODE_USE_ENV_PROXY") delete out[k];
  return out;
}

export function listening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host });
    s.setTimeout(1000);
    // Closed politely: the add-on sees an empty request, not a reset.
    s.once("connect", () => (s.end(), resolve(true)));
    s.once("timeout", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(false));
  });
}

/** Is this Blender already open (as a window, not one of our background runs)? */
export async function isOpen(b: Blender): Promise<boolean> {
  if (platform() === "win32") {
    const { out } = await run("tasklist", ["/fo", "csv", "/nh"], 10_000);
    return /"blender\.exe"/i.test(out);
  }
  const { out } = await run("ps", ["-axo", "command="], 10_000);
  return out.split("\n").some((l) => l.startsWith(b.bin) && !/\s(-b|--background)(\s|$)/.test(l));
}

const hasDisplay = () => platform() !== "linux" || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * Open Blender so the official add-on listens on `port`: as a window the person sees (it outlives the hub), or, on a
 * machine without a screen, in the background for as long as this server runs.
 */
export function open(b: Blender, state: AddonState, port: number): void {
  // Online access lets the add-on open its socket; a server it does not start by itself is started here.
  const args = ["--online-mode"];
  if (state.autostart === false) args.push("--python-expr", "import bpy\nbpy.app.timers.register(lambda: (bpy.ops.blmcp.server_start(), None)[1], first_interval=2.0)");
  if (!hasDisplay()) {
    const child = spawn(b.bin, ["--background", "--online-mode", "--command", "blender_mcp", "--port", String(port)], { stdio: "ignore", env: blenderEnv() });
    process.once("exit", () => child.kill());
    return;
  }
  const [cmd, argv] = b.app && platform() === "darwin" ? ["open", ["-a", b.app, "--args", ...args]] : [b.bin, args];
  spawn(cmd as string, argv as string[], { detached: true, stdio: "ignore", env: blenderEnv() }).unref();
}

export async function waitListening(port: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) if (await listening(port)) return true;
  return false;
}
