// The official Blender MCP server (Blender Lab, projects.blender.org/lab/blender_mcp), from one pinned release: its
// source is fetched once into the plugin's data folder, and it runs on uv when the machine has it, otherwise in a
// virtual environment of Blender's own Python. The add-on is built from the same source, so the two always match.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pythonOf, type Blender } from "./blender.ts";

export const RELEASE = { tag: "v1.0.3", commit: "2cea8d566dde07fbac28a61d698909d69724e853" };
// The repository's API serves the archive; the web page's own archive link sits behind a browser check.
const ARCHIVE = `https://projects.blender.org/api/v1/repos/lab/blender_mcp/archive/${RELEASE.commit}.tar.gz`;

const run = (bin: string, args: string[], timeout: number) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}\n${stderr}` }),
    ),
  );

export interface Source {
  /** The server's Python package (mcp/). */
  server: string;
  /** The add-on's folder, with its blender_manifest.toml. */
  addon: string;
}

/** The release's source in `data`, fetched the first time (BLENDER_MCP_SOURCE points at a checkout instead). */
export async function source(data: string, env: NodeJS.ProcessEnv = process.env): Promise<Source> {
  const root = env.BLENDER_MCP_SOURCE ?? join(data, `blender_mcp-${RELEASE.tag}`);
  const at = (r: string) => ({ server: join(r, "mcp"), addon: join(r, "addon", "blender_mcp_addon") });
  if (existsSync(join(at(root).server, "pyproject.toml"))) return at(root);
  if (env.BLENDER_MCP_SOURCE) throw new Error(`BLENDER_MCP_SOURCE (${root}) holds no mcp/pyproject.toml.`);
  mkdirSync(data, { recursive: true });
  const tmp = mkdtempSync(join(data, ".fetch-"));
  try {
    const res = await fetch(ARCHIVE);
    if (!res.ok) throw new Error(`Fetching the official Blender MCP server ${RELEASE.tag} failed: HTTP ${res.status} from ${ARCHIVE}`);
    const archive = join(tmp, "src.tar.gz");
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const x = await run("tar", ["-xzf", archive, "-C", tmp], 60_000);
    const top = readdirSync(tmp).find((n) => existsSync(join(tmp, n, "mcp", "pyproject.toml")));
    if (!top) throw new Error(`The Blender MCP archive did not unpack as expected:\n${x.out.slice(-800)}`);
    renameSync(join(tmp, top), root);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return at(root);
}

/** uv on PATH or where its installer puts it. */
export function findUv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = platform() === "win32" ? "uv.exe" : "uv";
  const home = homedir();
  const dirs = [...(env.PATH ?? "").split(platform() === "win32" ? ";" : ":"), join(home, ".local", "bin"), join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return dirs.filter(Boolean).map((d) => join(d, exe)).find((p) => existsSync(p));
}

/** How to start the server: [command, ...args]. BLENDER_MCP_SERVER (a JSON array) replaces it, for tests. */
export async function serverCommand(src: Source, blender: Blender, data: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (env.BLENDER_MCP_SERVER) return JSON.parse(env.BLENDER_MCP_SERVER) as string[];
  const py = pythonOf(blender);
  const uv = findUv(env);
  // uv on Blender's Python: no interpreter of its own to download.
  if (uv) return [uv, "tool", "run", ...(py ? ["--python", py] : []), "--from", src.server, "blender-mcp"];
  if (!py) throw new Error(`Neither uv nor Blender's own Python (in ${blender.bin}) was found to run the Blender MCP server.`);
  const venv = join(data, `venv-${RELEASE.tag}`);
  const bin = platform() === "win32" ? join(venv, "Scripts", "blender-mcp.exe") : join(venv, "bin", "blender-mcp");
  if (!existsSync(bin)) {
    const made = await run(py, ["-m", "venv", venv], 120_000);
    const vpy = platform() === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
    if (!existsSync(vpy)) throw new Error(`Making a Python environment for the Blender MCP server failed:\n${made.out.slice(-800)}`);
    const pip = await run(vpy, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", src.server], 600_000);
    if (!existsSync(bin)) {
      rmSync(venv, { recursive: true, force: true });
      throw new Error(`Installing the Blender MCP server failed:\n${pip.out.slice(-800)}`);
    }
  }
  return [bin];
}
