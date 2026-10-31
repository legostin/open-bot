// Resolves the hub's own workspace packages (@piomio/*) to their folders in an installed app. npm links them into
// node_modules, but the installers carry no links: on Windows they would be junctions, which processes under Windows'
// redirection guard (anything Inno Setup starts, for one) refuse to follow. Imported first by launch.mjs and, through
// NODE_OPTIONS, by every Node process the hub starts (plugins).

import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `@piomio/<name>` → its folder and `exports`, from packages/*, plugins/* and integrations/*. */
export function workspaces(root = APP_ROOT) {
  const out = new Map();
  for (const group of ["packages", "plugins", "integrations"]) {
    let dirs = [];
    try {
      dirs = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const d of dirs) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, group, d, "package.json"), "utf8"));
        if (typeof pkg.name === "string" && pkg.name.startsWith("@piomio/")) out.set(pkg.name, { dir: join(root, group, d), exports: pkg.exports ?? pkg.main });
      } catch {
        /* not a package */
      }
    }
  }
  return out;
}

/** The file URL for `@piomio/<name>[/<sub>]` through the package's (string-valued) exports, or undefined. */
export function resolveWorkspace(specifier, table) {
  const m = /^(@piomio\/[^/]+)(\/.+)?$/.exec(specifier);
  const ws = m && table.get(m[1]);
  if (!ws?.exports) return undefined;
  const sub = "." + (m[2] ?? "");
  const target = typeof ws.exports === "string" ? (sub === "." ? ws.exports : undefined) : ws.exports[sub];
  return typeof target === "string" ? pathToFileURL(join(ws.dir, target)).href : undefined;
}

const table = workspaces();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@piomio/")) {
      const url = resolveWorkspace(specifier, table);
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
