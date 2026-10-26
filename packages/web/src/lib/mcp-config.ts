// Client-side validation of the user's MCP servers config (mirrors the hub's checks).

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
    return { error: `Неверный JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "Ожидается объект { \"имя\": { ... } }" };
  const obj = j as Record<string, unknown>;
  const servers = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : obj) as Record<string, unknown>;
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return { error: `${name}: конфигурация сервера должна быть объектом` };
    const cfg = s as Record<string, unknown>;
    if (!cfg.command && !cfg.url) return { error: `${name}: нужен "command" (stdio) или "url" (http)` };
    for (const key of ["env", "headers"] as const) {
      const v = cfg[key];
      if (v === undefined) continue;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `${name}.${key}: ожидается объект` };
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k) && typeof val === "string" && !val.startsWith("vault://") && val !== "•••") {
          return { error: `${name}.${k}: храните секреты в vault и указывайте ссылку vault://<id>` };
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
