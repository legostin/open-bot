import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The console is served by the hub on its own origin with a strict CSP:
// everything is bundled (no CDNs, no inline scripts), assets are loaded relative to index.html.
// For `npm run dev`, start the hub with OWLBOT_CONSOLE_DEV_ORIGIN=http://localhost:5174.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Never inline assets as data: URIs into JS; keep everything as same-origin files.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/console-api": { target: "http://127.0.0.1:8081", ws: true },
    },
  },
});
