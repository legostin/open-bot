// An integration whose MCP server has its own sign-in (as Granola's does), against a fake OAuth server: it waits for
// the person, signs in through discovery, client registration and PKCE, comes back to /oauth/mcp, keeps its tokens in
// the vault across reconnects, renews an expired token by itself, and signs out.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hub, loadConfig } from "../src/index.ts";
import { listIntegrations } from "../src/integrations.ts";
import { oauthVaultId } from "../src/mcp/oauth.ts";

const fixtures = join(import.meta.dirname, "fixtures");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });

/** A notes service with an MCP server behind OAuth 2.1: metadata, registration, authorize, token, /mcp. */
function fakeService() {
  const seen = { registrations: [] as any[], challenge: "", refreshes: 0, valid: new Set<string>() };
  let base = "";
  const server: Server = createHttpServer(async (req, res) => {
    const u = new URL(req.url!, base);
    const json = (status: number, v: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(v));
    if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (u.pathname === "/register") {
      const meta = JSON.parse(await body(req));
      seen.registrations.push(meta);
      return json(201, { ...meta, client_id: `client-${seen.registrations.length}`, client_id_issued_at: 1 });
    }
    if (u.pathname === "/authorize") {
      // The person signs in and allows: back to the client with a code.
      seen.challenge = u.searchParams.get("code_challenge") ?? "";
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({ code: "code-1", state: u.searchParams.get("state") ?? "" }).toString();
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (u.pathname === "/token") {
      const p = new URLSearchParams(await body(req));
      if (p.get("grant_type") === "authorization_code") {
        const verified = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") === seen.challenge;
        if (p.get("code") !== "code-1" || !verified) return json(400, { error: "invalid_grant" });
        seen.valid.add("at-1");
        return json(200, { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1" });
      }
      if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "rt-1") {
        seen.refreshes++;
        seen.valid.add("at-2");
        return json(200, { access_token: "at-2", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1" });
      }
      return json(400, { error: "invalid_grant" });
    }
    if (u.pathname === "/mcp") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!seen.valid.has(token)) return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const mcp = new McpServer({ name: "fake-notes", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "list_meetings", description: "List meetings", inputSchema: { type: "object", properties: {} } },
          { name: "switch_workspace", description: "Switch the workspace", inputSchema: { type: "object", properties: {} } },
          // Named after the service, as Notion's notion-search is.
          { name: "notes-search", description: "Search the notes", inputSchema: { type: "object", properties: {} } },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: r.params.name === "list_meetings" ? "Standup, 2026-10-29" : "ok" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      const raw = req.method === "POST" ? await body(req) : "";
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    }
    res.writeHead(404).end();
  });
  return {
    server,
    seen,
    start: () =>
      new Promise<void>((r) =>
        server.listen(0, "127.0.0.1", () => {
          base = `http://127.0.0.1:${(server.address() as any).port}`;
          r();
        }),
      ),
    url: () => base,
  };
}

describe("an integration with its own sign-in", () => {
  const svc = fakeService();
  let hub: Hub;
  let port: number;

  const notes = async () => (await listIntegrations(hub, "en")).find((i) => i.id === "notes")!;
  const server = () => hub.mcpClients.list().find((s) => s.name === "notes")!;

  beforeAll(async () => {
    await svc.start();
    // A built-in integration that is only an .mcp.json, like integrations/granola.
    const builtin = mkdtempSync(join(tmpdir(), "owl-signin-builtin-"));
    const dir = join(builtin, "notes");
    mkdirSync(join(dir, ".owlbot-plugin"), { recursive: true });
    writeFileSync(join(dir, ".owlbot-plugin", "plugin.json"), JSON.stringify({ id: "notes", name: "Notes", builtin: true, integration: { category: "work", connect: "signin", summary: "Meeting notes" } }));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { notes: { type: "http", url: `${svc.url()}/mcp`, readTools: ["list_meetings"] } } }));
    let consolePort: number, egressPort: number;
    [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { OWLBOT_PORT: String(port), OWLBOT_DEVICES: "0", OWLBOT_CONSOLE_PORT: String(consolePort), OWLBOT_EGRESS_PORT: String(egressPort), OWLBOT_LANG: "en", TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-signin-")), builtinPluginsDirs: [builtin], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
    svc.server.close();
  });

  it("waits for the person, and asks for the vault first", async () => {
    expect(server()).toMatchObject({ status: "signin", tools: [] });
    expect(await notes()).toMatchObject({ connect: "signin", status: "needs-setup" });
    await expect(hub.mcpClients.signIn("notes")).rejects.toMatchObject({ status: 409 });
  });

  it("signs in through the browser and the hub's /oauth/mcp, and the tools arrive", async () => {
    hub.vault.init("signin-test-passphrase");
    const url = new URL(await hub.mcpClients.signIn("notes"));
    expect(url.origin + url.pathname).toBe(`${svc.url()}/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/oauth/mcp`);
    expect(svc.seen.registrations.at(-1)).toMatchObject({ client_name: "Owlbot", redirect_uris: [`http://localhost:${port}/oauth/mcp`], token_endpoint_auth_method: "none" });

    // The browser: Granola's page, then back to the hub.
    const back = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    const page = await fetch(back.replace("//localhost:", "//127.0.0.1:"), { headers: { host: `localhost:${port}` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Notes");

    expect(server().status).toBe("connected");
    expect(await notes()).toMatchObject({ status: "connected" });
    expect(hub.vault.getMeta(oauthVaultId("notes"))).toBeDefined();
    // What the integration vouches for only reads; anything else asks the person.
    expect(hub.tools.get("notes_list_meetings")!.descriptor).toMatchObject({ effect: "read", source: true });
    expect(hub.tools.get("notes_switch_workspace")!.descriptor.effect).toBe("external");
    // Its own name is not prefixed twice.
    expect(hub.tools.get("notes_search")).toBeDefined();
    expect(hub.tools.get("notes_notes-search")).toBeUndefined();
    const r = await hub.tools.get("notes_list_meetings")!.invoke({}, {} as any);
    expect(r.content).toEqual([{ type: "text", text: "Standup, 2026-10-29" }]);
  });

  it("keeps the sign-in across reconnects and renews an expired token", async () => {
    await hub.mcpClients.reconnect("notes");
    expect(server().status).toBe("connected");
    expect(svc.seen.registrations).toHaveLength(1);
    svc.seen.valid.delete("at-1");
    const r = await hub.tools.get("notes_list_meetings")!.invoke({}, {} as any);
    expect(r.isError).toBeFalsy();
    expect(svc.seen.refreshes).toBe(1);
  });

  it("refuses an address that is not its sign-in, and signs out", async () => {
    await expect(hub.mcpClients.completeSignIn(new URLSearchParams({ code: "x", state: "not-ours" }))).rejects.toMatchObject({ key: "mcp.signinExpired" });
    await hub.mcpClients.signOut("notes");
    // The tokens are gone; the registered client stays for the next sign-in.
    const kept = JSON.parse(hub.vault.access(`vault://${oauthVaultId("notes")}`, { actor: "test" }).value!);
    expect(kept.tokens).toBeUndefined();
    expect(kept.client.client_id).toBe("client-1");
    expect(server()).toMatchObject({ status: "signin", tools: [] });
    expect(hub.tools.get("notes_list_meetings")).toBeUndefined();
  });
});
