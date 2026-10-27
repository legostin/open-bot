// Accounts the hub signs in to for the user (Google for now): OAuth 2.0 authorization code with PKCE. The refresh
// token lives in the vault, access tokens in memory; plugins get access tokens through connections.token and never
// see the refresh token. One account per provider.

import { createHash, randomBytes } from "node:crypto";
import type { ConnectionAccount } from "@owlbot/shared";
import { LocalizedError } from "./i18n.ts";
import type { EventBus } from "./bus.ts";
import type { AuditLog } from "./audit.ts";
import type { Settings } from "./settings.ts";
import type { VaultService } from "./vault/service.ts";

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  userinfoUrl: string;
}

/**
 * Owlbot's own Google client (type "Desktop app"): Google treats an installed app's secret as public. Empty until the
 * project's client exists; OWLBOT_GOOGLE_CLIENT_ID / OWLBOT_GOOGLE_CLIENT_SECRET override it.
 */
export const BUILTIN_GOOGLE_CLIENT = { clientId: "", clientSecret: "" };

export const GOOGLE_ENDPOINTS = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
};

export const GOOGLE_REFRESH_VAULT_ID = "google_refresh_token";
const SETTINGS_KEY = "connections";
const STATE_TTL_MS = 10 * 60_000;
/** Refresh this long before Google's expiry. */
const EARLY_MS = 60_000;
const IDENTITY_SCOPES = ["openid", "email"];

export type Provider = "google";

interface Pending {
  verifier: string;
  scopes: string[];
  redirectUri: string;
  at: number;
  /** Who asked (the integration and the chat its card was in): told once the account is connected. */
  origin?: { integration?: string; conversationId?: string };
}

export interface ConnectionsDeps {
  google: GoogleClientConfig;
  vault: VaultService;
  settings: Settings;
  bus: EventBus;
  audit: AuditLog;
  /** Where Google sends the browser back: the hub's loopback address (a Desktop client accepts any port). */
  redirectUri: () => string;
}

/** PKCE: a random verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The query of what the user pasted: a whole callback address, its query string, or the parameters alone. */
export function callbackParams(input: string): URLSearchParams {
  const s = input.trim();
  const q = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s;
  return new URLSearchParams(q.split("#")[0]);
}

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

export class Connections {
  private d: ConnectionsDeps;
  private pending = new Map<string, Pending>();
  private cache = new Map<Provider, { accessToken: string; expiresAt: number }>();
  private refreshing = new Map<Provider, Promise<{ accessToken: string; expiresAt: number }>>();

  constructor(d: ConnectionsDeps) {
    this.d = d;
  }

  /** Whether this build can sign in to the provider at all (a client is configured). */
  available(_p: Provider): boolean {
    return !!this.d.google.clientId;
  }

  list(): ConnectionAccount[] {
    return Object.values(this.d.settings.getKey<Record<string, ConnectionAccount>>(SETTINGS_KEY, {}));
  }

  get(p: Provider): ConnectionAccount | undefined {
    return this.d.settings.getKey<Record<string, ConnectionAccount>>(SETTINGS_KEY, {})[p];
  }

  private save(p: Provider, account: ConnectionAccount | undefined): void {
    const all = { ...this.d.settings.getKey<Record<string, ConnectionAccount>>(SETTINGS_KEY, {}) };
    if (account) all[p] = account;
    else delete all[p];
    this.d.settings.setKey(SETTINGS_KEY, all);
    this.d.bus.emit("connections.updated", { provider: p });
  }

  /** The address to send the user's browser to. */
  start(p: Provider, scopes: string[], origin?: Pending["origin"]): { url: string } {
    if (!this.available(p)) throw new LocalizedError("connections.unavailable", undefined, 409);
    if (this.d.vault.state() !== "unlocked") throw new LocalizedError("connections.vaultLocked", undefined, 409);
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > STATE_TTL_MS) this.pending.delete(k);
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString("base64url");
    const all = [...new Set([...IDENTITY_SCOPES, ...scopes])];
    const redirectUri = this.d.redirectUri();
    this.pending.set(state, { verifier, scopes: all, redirectUri, at: now, origin });
    const u = new URL(this.d.google.authUrl);
    u.search = new URLSearchParams({
      client_id: this.d.google.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: all.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    }).toString();
    return { url: u.toString() };
  }

  /** Google sent the browser back (or the user pasted the address): exchange the code, keep the account. */
  async complete(input: string | URLSearchParams): Promise<{ account: ConnectionAccount; origin?: Pending["origin"] }> {
    const q = typeof input === "string" ? callbackParams(input) : input;
    if (q.get("error")) throw new LocalizedError(q.get("error") === "access_denied" ? "connections.denied" : "connections.failed", { error: q.get("error")! }, 400);
    const state = q.get("state") ?? "";
    const pending = this.pending.get(state);
    if (!pending || Date.now() - pending.at > STATE_TTL_MS) throw new LocalizedError("connections.badState", undefined, 400);
    this.pending.delete(state);
    const code = q.get("code");
    if (!code) throw new LocalizedError("connections.badState", undefined, 400);
    if (this.d.vault.state() !== "unlocked") throw new LocalizedError("connections.vaultLocked", undefined, 409);
    const tok = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    if (!tok.refresh_token) throw new LocalizedError("connections.failed", { error: "no refresh token" }, 502);
    const email = await this.email(tok.access_token);
    this.d.vault.upsert({ id: GOOGLE_REFRESH_VAULT_ID, type: "secret", name: `Google (${email})`, fields: { value: tok.refresh_token } });
    this.cache.set("google", { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 });
    const account: ConnectionAccount = {
      provider: "google",
      account: email,
      scopes: typeof tok.scope === "string" ? tok.scope.split(/\s+/).filter(Boolean) : pending.scopes,
      connectedAt: new Date().toISOString(),
    };
    this.save("google", account);
    this.d.audit.append("user", "connection.connect", undefined, { provider: "google", account: email });
    return { account, origin: pending.origin };
  }

  /** A valid access token for a plugin; refreshed a minute before it expires. Errors are English text for the model. */
  async token(p: Provider): Promise<{ accessToken: string; expiresAt: string; account: string }> {
    const acc = this.get(p);
    if (!acc) throw new Error("Google is not connected");
    if (acc.broken) throw new Error("Google access was revoked or expired; the user must connect Google again");
    let t = this.cache.get(p);
    if (!t || t.expiresAt - EARLY_MS <= Date.now()) {
      let r = this.refreshing.get(p);
      if (!r) {
        r = this.refresh(p).finally(() => this.refreshing.delete(p));
        this.refreshing.set(p, r);
      }
      t = await r;
    }
    return { accessToken: t.accessToken, expiresAt: new Date(t.expiresAt).toISOString(), account: acc.account };
  }

  private async refresh(p: Provider): Promise<{ accessToken: string; expiresAt: number }> {
    let refreshToken: string;
    try {
      refreshToken = this.d.vault.access(`vault://${GOOGLE_REFRESH_VAULT_ID}`, { actor: "core:connections" }).value ?? "";
    } catch (e: any) {
      throw new Error(`the Google sign-in cannot be read (${e?.message ?? e}); the vault may be locked`);
    }
    try {
      const tok = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
      const t = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
      this.cache.set(p, t);
      return t;
    } catch (e: any) {
      if (e?.oauthError === "invalid_grant") {
        const acc = this.get(p);
        if (acc) this.save(p, { ...acc, broken: true });
        throw new Error("Google access was revoked or expired; the user must connect Google again");
      }
      throw e;
    }
  }

  /** Revoke at Google (best effort), forget the token and the account. */
  async disconnect(p: Provider): Promise<void> {
    let refreshToken: string | undefined;
    try {
      refreshToken = this.d.vault.access(`vault://${GOOGLE_REFRESH_VAULT_ID}`, { actor: "core:connections" }).value;
    } catch {
      /* gone already, or the vault is locked: nothing to revoke from here */
    }
    if (refreshToken) {
      await fetch(this.d.google.revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: refreshToken }), signal: AbortSignal.timeout(15_000) }).catch(() => {});
    }
    if (this.d.vault.state() === "unlocked" && this.d.vault.getMeta(GOOGLE_REFRESH_VAULT_ID)) this.d.vault.remove(GOOGLE_REFRESH_VAULT_ID);
    this.cache.delete(p);
    this.save(p, undefined);
    this.d.audit.append("user", "connection.disconnect", undefined, { provider: p });
  }

  private async tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    let res: Response;
    try {
      res = await fetch(this.d.google.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ ...params, client_id: this.d.google.clientId, client_secret: this.d.google.clientSecret }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new Error(`Google is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !body.access_token) {
      const err = new Error(`Google refused the sign-in: ${body.error_description ?? body.error ?? res.status}`) as Error & { oauthError?: string };
      err.oauthError = body.error;
      throw err;
    }
    return body as any;
  }

  private async email(accessToken: string): Promise<string> {
    const res = await fetch(this.d.google.userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const body = (await res?.json().catch(() => ({}))) as { email?: string } | undefined;
    return body?.email ?? "Google";
  }
}
