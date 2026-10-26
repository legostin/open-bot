// Client-side validation of the user's MCP servers config (mirrors the hub's checks).

import { t } from "../i18n";

export interface McpParse {
  servers?: Record<string, Record<string, unknown>>;
  error?: string;
}

const SECRET_KEY = /key|token|secret|password/i;

/** Accepts `{ "mcpServers": {...} }` (.mcp.json format) or a bare `{ name: config }` map. */
export function parseMcpConfig(text: string): McpParse {
  let j: unknown;
  try {
    j = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    return { error: t("mcp.error.json", { error: e instanceof Error ? e.message : String(e) }) };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: t("mcp.error.notObject", { example: '{ "name": { ... } }' }) };
  const obj = j as Record<string, unknown>;
  const servers = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : obj) as Record<string, unknown>;
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return { error: t("mcp.error.serverNotObject", { name }) };
    const cfg = s as Record<string, unknown>;
    if (!cfg.command && !cfg.url) return { error: t("mcp.error.needCommand", { name }) };
    for (const key of ["env", "headers"] as const) {
      const v = cfg[key];
      if (v === undefined) continue;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: t("mcp.error.fieldNotObject", { field: `${name}.${key}` }) };
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k) && typeof val === "string" && !val.startsWith("vault://") && val !== "•••") {
          return { error: t("mcp.error.secret", { field: `${name}.${k}` }) };
        }
      }
    }
  }
  return { servers: servers as Record<string, Record<string, unknown>> };
}

export const MCP_EXAMPLE = `{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "vault://github_token" }
  },
  "docs": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "vault://docs_token" }
  }
}`;
