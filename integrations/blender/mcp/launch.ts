// Piomio's launcher for the official Blender MCP server, started by the hub as this plugin's MCP server (.mcp.json).
// It finds Blender, prepares the server from its pinned release, and relays MCP to it; the first tool that needs Blender
// installs the official add-on when missing and opens Blender. What goes wrong while starting is said on stderr, whose
// last line the hub shows.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_PORT, ensureAddon, findBlender, isOpen, listening, open, waitListening } from "./blender.ts";
import { relay } from "./relay.ts";
import { serverCommand, source } from "./server.ts";

// These read the documentation bundled with the server, or a .blend file through a background Blender of their own.
const WITHOUT_BLENDER = new Set(["get_python_api_docs", "search_api_docs", "search_manual_docs"]);
const needsBlender = (tool: string) => !WITHOUT_BLENDER.has(tool) && !tool.endsWith("_for_cli");

async function main(): Promise<void> {
  const data = process.env.BLENDER_MCP_DATA || join(tmpdir(), "piomio-blender-mcp");
  const port = Number(process.env.BLENDER_MCP_PORT || DEFAULT_PORT);
  const blender = await findBlender();
  if ("missing" in blender) throw new Error(blender.missing);
  const src = await source(data);
  const [cmd, ...args] = await serverCommand(src, blender, data);

  const server = spawn(cmd!, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, BLENDER_PATH: blender.bin, BLENDER_MCP_PORT: String(port) } });
  server.on("error", (e) => fail(`The Blender MCP server could not start (${cmd}): ${e.message}`));
  server.on("exit", (code) => process.exit(code ?? 1));
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (server.kill(), process.exit(0)));
  // Whole lines only: the relay writes its own answers to the hub between the server's.
  createInterface({ input: server.stdout!, crlfDelay: Infinity }).on("line", (line) => process.stdout.write(line + "\n"));

  let opening: Promise<void> | undefined;
  const openBlender = async () => {
    if (await listening(port)) return;
    if (await isOpen(blender))
      throw new Error(
        `Blender is open, but its MCP add-on is not listening on port ${port}. Ask the person to start it in Blender (Edit > Preferences > Add-ons > MCP, with Allow Online Access on), ` +
          "or to save their work and close Blender: the next Blender tool call opens it with the add-on running (and installs the add-on if it is missing).",
      );
    const state = await ensureAddon(blender, src.addon);
    if (state.port && state.port !== port)
      throw new Error(`The MCP add-on in Blender is set to port ${state.port}, and Piomio talks to ${port}: ask the person to set it back to ${port} in Edit > Preferences > Add-ons > MCP.`);
    open(blender, state, port);
    if (!(await waitListening(port, 120_000)))
      throw new Error(`Blender ${blender.version} was opened, but its MCP add-on did not start listening on port ${port} within two minutes. Ask the person to look at Edit > Preferences > Add-ons > MCP in Blender.`);
  };

  relay({
    from: process.stdin,
    to: server.stdin!,
    back: process.stdout,
    needsBlender,
    ready: () => (opening ??= openBlender().finally(() => (opening = undefined))),
  });
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((e) => fail(e?.message ?? String(e)));
