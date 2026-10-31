import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// What the build learned (scripts/build.mjs writes it before Vite runs): release links, stars, the base path.
const dataFile = resolve(import.meta.dirname, ".build/data.json");
const data = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : { base: "/", release: { page: "https://github.com/legostin/piomio/releases" } };

export default defineConfig({
  base: process.env.SITE_BASE || data.base || "/",
  plugins: [react(), tailwindcss()],
  define: { __SITE_DATA__: JSON.stringify(data) },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { port: 5197, strictPort: true },
});
