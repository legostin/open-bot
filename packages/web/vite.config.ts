import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HUB = "http://127.0.0.1:8080";

// Same import map the hub injects into index.html in production (see packages/core/src/server/main-app.ts).
// In dev Vite serves index.html itself, so we add it here (dev only; the production build keeps `<head>` untouched).
const IMPORT_MAP = {
  imports: {
    react: "/shared/react.js",
    "react/jsx-runtime": "/shared/react-jsx-runtime.js",
    "react-dom": "/shared/react-dom.js",
    "react-dom/client": "/shared/react-dom-client.js",
    "@openbot/ui": "/shared/openbot-ui.js",
  },
};

function devImportMap(): Plugin {
  return {
    name: "openbot-dev-import-map",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "script", attrs: { type: "importmap" }, children: JSON.stringify(IMPORT_MAP), injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), devImportMap()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: HUB, ws: true },
      "/mcp": { target: HUB },
      "/plugins-ui": { target: HUB },
      "/shared": { target: HUB },
    },
  },
});
