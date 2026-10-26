// Build UI modules of builtin plugins: plugins/<id>/ui/src/index.tsx → plugins/<id>/ui/dist/index.js
// React, ReactDOM and @openbot/ui stay external: the host provides them through the import map.
// Usage: node scripts/build-ui-plugins.mjs [pluginDir ...]   (default: every plugins/* with ui/src)

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dirs = process.argv.length > 2 ? process.argv.slice(2).map((d) => resolve(d)) : readdirSync(join(root, "plugins")).map((d) => join(root, "plugins", d));

const EXTERNAL = ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@openbot/ui"];
let built = 0;
for (const dir of dirs) {
  const entry = ["index.tsx", "index.ts", "index.jsx", "index.js"].map((f) => join(dir, "ui", "src", f)).find(existsSync);
  if (!entry) continue;
  await build({
    entryPoints: [entry],
    outfile: join(dir, "ui", "dist", "index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: EXTERNAL,
    minify: true,
    sourcemap: false,
    logLevel: "warning",
    loader: { ".svg": "text", ".png": "dataurl" },
  });
  built++;
  console.log(`ui plugin built: ${dir}`);
}
console.log(`${built} UI plugin(s) built`);
