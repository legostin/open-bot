// Remote MCP servers that ask the person to sign in (OAuth 2.1 with discovery, dynamic client registration and PKCE),
// as Granola's does. The MCP SDK runs the protocol through this provider; the hub keeps what it must remember: the
// registered client and the tokens in the vault (one item per server, so a sign-in survives restarts), and a sign-in
// in progress (its verifier and the address to open) in memory. The person signs in in their own browser, which comes
// back to /oauth/mcp on the hub's own computer, or pastes that address in the chat from another device.

import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { LocalizedError } from "../i18n.ts";
import type { VaultService } from "../vault/service.ts";

interface Stored {
  client?: OAuthClientInformationMixed;
  /** The address the client was registered with: a hub on another port registers again. */
  redirect?: string;
  tokens?: OAuthTokens;
}

/** The vault item that holds a server's sign-in. */
export function oauthVaultId(server: string): string {
  return `mcp_oauth_${server.replace(/[^\w.-]/g, "_")}`.slice(0, 128);
}

export class McpOAuth implements OAuthClientProvider {
  /** Where to send the person's browser, once the server asked for a sign-in. */
  authUrl?: URL;
  /** Ties the browser's way back to this sign-in. */
  stateValue = randomBytes(24).toString("base64url");
  private verifier?: string;
  /** What the vault cannot hold yet (it is locked): the registered client. */
  private memory: Stored = {};
  private d: { server: string; vault: VaultService; redirectUri: string };

  constructor(d: { server: string; vault: VaultService; redirectUri: string }) {
    this.d = d;
  }

  /** A new connection: a fresh state for the way back, no address to open yet (the registered client stays). */
  begin(): void {
    this.authUrl = undefined;
    this.stateValue = randomBytes(24).toString("base64url");
  }

  get redirectUrl(): string {
    return this.d.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Owlbot",
      redirect_uris: [this.d.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const s = this.read();
    return s.client && s.redirect === this.d.redirectUri ? s.client : undefined;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ client, redirect: this.d.redirectUri }, false);
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens }, true);
  }

  redirectToAuthorization(url: URL): void {
    this.authUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new LocalizedError("mcp.signinExpired", undefined, 400);
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") this.verifier = undefined;
    if (scope === "verifier" || scope === "discovery") return;
    if (scope !== "tokens") this.memory = {};
    const s: Stored = scope === "all" ? {} : this.read();
    if (scope === "client") {
      delete s.client;
      delete s.redirect;
    }
    if (scope === "tokens") delete s.tokens;
    this.persist(s);
  }

  /** Whether the person signed in (tokens are kept). */
  signedIn(): boolean {
    return !!this.read().tokens;
  }

  private read(): Stored {
    const id = oauthVaultId(this.d.server);
    if (this.d.vault.state() !== "unlocked" || !this.d.vault.getMeta(id)) return { ...this.memory };
    try {
      return { ...this.memory, ...JSON.parse(this.d.vault.access(`vault://${id}`, { actor: "core:mcp" }).value ?? "{}") };
    } catch {
      return { ...this.memory };
    }
  }

  /** Tokens need the vault; the registered client waits in memory while it is locked. */
  private write(patch: Stored, secret: boolean): void {
    if (this.d.vault.state() !== "unlocked") {
      if (secret) throw new LocalizedError("connections.vaultLocked", undefined, 409);
      this.memory = { ...this.memory, ...patch };
      return;
    }
    this.persist({ ...this.read(), ...patch });
  }

  private persist(s: Stored): void {
    if (this.d.vault.state() !== "unlocked") return;
    const id = oauthVaultId(this.d.server);
    if (!s.client && !s.tokens) {
      if (this.d.vault.getMeta(id)) this.d.vault.remove(id);
      return;
    }
    this.d.vault.upsert({ id, type: "secret", name: `MCP sign-in: ${this.d.server}`, fields: { value: JSON.stringify(s) } });
  }
}
