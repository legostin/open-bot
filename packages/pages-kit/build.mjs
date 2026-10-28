// Builds what the hub serves to pages (core/src/pages.ts) into dist/: kit.js (React, shadcn/ui, lucide icons,
// Owlbot's blocks and the page runtime as one classic script), kit.css (Leaflet's and the blocks' styles),
// tailwind.js (Tailwind's browser runtime, which styles a page from its classes) and theme.css (shadcn's tokens).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const require = createRequire(import.meta.url);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { kit: join(here, "src", "kit.tsx") },
  outdir: out,
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  jsx: "automatic",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
copyFileSync(require.resolve("@tailwindcss/browser"), join(out, "tailwind.js"));
copyFileSync(join(here, "src", "theme.css"), join(out, "theme.css"));
