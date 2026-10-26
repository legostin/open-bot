// Encrypted vault. Item metadata (name, type, scope, hints) is plaintext so it can be listed while sealed;
// secret fields are encrypted with a random data key wrapped by an Argon2id-derived key.

import { readFileSync } from "node:fs";
import type { Params, VaultItem, VaultItemMeta, VaultItemType, VaultScope, VaultState } from "@openbot/shared";
import { hostMatches, newId, nowIso } from "@openbot/shared";
import { openDb, json, type Db } from "../db.ts";
import { DEFAULT_KDF, deriveKey, newDataKey, newSalt, open, openJson, seal, sealJson, type KdfParams, type Sealed } from "./crypto.ts";
import { Redactor } from "./redact.ts";
import { LocalizedError, tFor } from "../i18n.ts";

export class VaultError extends LocalizedError {
  code: "sealed" | "uninitialized" | "not_found" | "forbidden" | "bad_passphrase" | "exists" | "invalid";
  constructor(code: VaultError["code"], key: string, params?: Params) {
    // The same HTTP status on both origins (the security console and the chat's create/unlock card).
    super(key, params, code === "not_found" ? 404 : code === "bad_passphrase" || code === "invalid" ? 400 : code === "forbidden" ? 403 : 409);
    this.code = code;
  }
}

export interface AccessRequest {
  /** Who is asking: "plugin:<id>", "core", "user". */
  actor: string;
  pluginId?: string;
  agentId?: string;
  tool?: string;
  domain?: string;
}

const DEFAULT_SCOPE: VaultScope = { domains: [], plugins: [], agents: [], tools: [], mode: "auto", revealToModel: false };

export class VaultService {
  db: Db;
  private key: Uint8Array | undefined;
  redactor = new Redactor();
  private onState: (s: VaultState) => void;
  private onAccess: (entry: { actor: string; itemId: string; allowed: boolean; reason?: string }) => void;

  constructor(file: string, hooks: { onState?: (s: VaultState) => void; onAccess?: (e: { actor: string; itemId: string; allowed: boolean; reason?: string }) => void } = {}) {
    this.db = openDb(file);
    this.db.exec(`
      create table if not exists vault_meta(key text primary key, value text not null);
      create table if not exists vault_items(id text primary key, type text not null, name text not null, scope text not null, hints text not null, secret text not null, created_at text not null, updated_at text not null);
    `);
    this.onState = hooks.onState ?? (() => {});
    this.onAccess = hooks.onAccess ?? (() => {});
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare("select value from vault_meta where key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("insert into vault_meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  state(): VaultState {
    if (!this.meta("wrapped_key")) return "uninitialized";
    return this.key ? "unlocked" : "sealed";
  }

  init(passphrase: string): void {
    if (this.meta("wrapped_key")) throw new VaultError("exists", "vault.exists");
    if (passphrase.length < 8) throw new VaultError("bad_passphrase", "vault.passphraseTooShort");
    const kdf: KdfParams = { ...DEFAULT_KDF, salt: newSalt() };
    const kek = deriveKey(passphrase, kdf);
    const dek = newDataKey();
    this.setMeta("kdf", JSON.stringify(kdf));
    this.setMeta("wrapped_key", JSON.stringify(seal(kek, dek, "openbot-vault-dek")));
    this.key = dek;
    this.refreshRedactor();
    this.onState("unlocked");
  }

  unlock(passphrase: string): void {
    const wrapped = this.meta("wrapped_key");
    if (!wrapped) throw new VaultError("uninitialized", "vault.uninitialized");
    const kdf = json<KdfParams>(this.meta("kdf"), { ...DEFAULT_KDF, salt: "" });
    try {
      this.key = open(deriveKey(passphrase, kdf), JSON.parse(wrapped) as Sealed, "openbot-vault-dek");
    } catch {
      throw new VaultError("bad_passphrase", "vault.badPassphrase");
    }
    this.refreshRedactor();
    this.onState("unlocked");
  }

  unlockFromFile(file: string): boolean {
    try {
      const pass = readFileSync(file, "utf8").trim();
      if (this.state() === "uninitialized") this.init(pass);
      else this.unlock(pass);
      return true;
    } catch (e) {
      console.error("[vault] auto-unlock failed:", (e as Error).message);
      return false;
    }
  }

  changePassphrase(oldPass: string, newPass: string): void {
    this.unlock(oldPass);
    const kdf: KdfParams = { ...DEFAULT_KDF, salt: newSalt() };
    this.setMeta("kdf", JSON.stringify(kdf));
    this.setMeta("wrapped_key", JSON.stringify(seal(deriveKey(newPass, kdf), this.key!, "openbot-vault-dek")));
  }

  seal(): void {
    this.key = undefined;
    this.redactor.clear();
    this.onState("sealed");
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new VaultError(this.state() === "uninitialized" ? "uninitialized" : "sealed", "vault.sealed");
    return this.key;
  }

  private metaFrom(r: any): VaultItemMeta {
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      scope: { ...DEFAULT_SCOPE, ...json<Partial<VaultScope>>(r.scope, {}) },
      hints: json<Record<string, string>>(r.hints, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): VaultItemMeta[] {
    return this.db.prepare("select * from vault_items order by name").all().map((r) => this.metaFrom(r));
  }

  getMeta(id: string): VaultItemMeta | undefined {
    const r = this.db.prepare("select * from vault_items where id = ?").get(id);
    return r ? this.metaFrom(r) : undefined;
  }

  /** Full item including secret fields. Only for the console (user) and checked accessors. */
  read(id: string): VaultItem {
    const key = this.requireKey();
    const r: any = this.db.prepare("select * from vault_items where id = ?").get(id);
    if (!r) throw new VaultError("not_found", "vault.notFound", { id });
    const fields = openJson<Record<string, string>>(key, JSON.parse(r.secret) as Sealed, `item:${id}`);
    return { ...this.metaFrom(r), fields };
  }

  upsert(input: { id?: string; type: VaultItemType; name: string; fields: Record<string, string>; scope?: Partial<VaultScope>; hints?: Record<string, string> }): VaultItemMeta {
    const id = input.id ?? (slugId(input.name) || newId("v_"));
    if (!VAULT_ID.test(id)) throw new VaultError("invalid", "vault.badId", { id: id.slice(0, 80) });
    const key = this.requireKey();
    const existing = this.db.prepare("select id, created_at from vault_items where id = ?").get(id) as { id: string; created_at: string } | undefined;
    const now = nowIso();
    const defaultScope: Partial<VaultScope> = input.type === "login" ? { plugins: ["browser"] } : {};
    const scope = { ...DEFAULT_SCOPE, ...defaultScope, ...(input.scope ?? {}) };
    const hints = input.hints ?? defaultHints(input.type, input.fields);
    const secret = JSON.stringify(sealJson(key, input.fields, `item:${id}`));
    if (existing) {
      this.db
        .prepare("update vault_items set type = ?, name = ?, scope = ?, hints = ?, secret = ?, updated_at = ? where id = ?")
        .run(input.type, input.name, JSON.stringify(scope), JSON.stringify(hints), secret, now, id);
    } else {
      this.db
        .prepare("insert into vault_items(id, type, name, scope, hints, secret, created_at, updated_at) values (?,?,?,?,?,?,?,?)")
        .run(id, input.type, input.name, JSON.stringify(scope), JSON.stringify(hints), secret, now, now);
    }
    this.refreshRedactor();
    return this.getMeta(id)!;
  }

  updateScope(id: string, scope: Partial<VaultScope>): VaultItemMeta {
    const m = this.getMeta(id);
    if (!m) throw new VaultError("not_found", "vault.notFound", { id });
    this.db.prepare("update vault_items set scope = ?, updated_at = ? where id = ?").run(JSON.stringify({ ...m.scope, ...scope }), nowIso(), id);
    this.refreshRedactor();
    return this.getMeta(id)!;
  }

  remove(id: string): void {
    this.db.prepare("delete from vault_items where id = ?").run(id);
    this.refreshRedactor();
  }

  /**
   * Resolve an item for a non-user accessor, enforcing the item's scope.
   * Plugins must also have the item in permissions.vault (checked by the plugin host).
   */
  access(ref: string, req: AccessRequest): Record<string, string> {
    const id = refToId(ref);
    const meta = this.getMeta(id);
    if (!meta) {
      this.onAccess({ actor: req.actor, itemId: id, allowed: false, reason: "not_found" });
      throw new VaultError("not_found", "vault.notFound", { id });
    }
    const deny = (key: string, params: Params): never => {
      this.onAccess({ actor: req.actor, itemId: id, allowed: false, reason: tFor("en")(key, { id, ...params }) });
      throw new VaultError("forbidden", key, { id, ...params });
    };
    const s = meta.scope;
    if (req.pluginId && s.plugins.length > 0 && !s.plugins.includes(req.pluginId) && !s.plugins.includes("*")) deny("vault.scope.plugin", { plugin: req.pluginId });
    if (req.pluginId && s.plugins.length === 0 && meta.type === "login") deny("vault.scope.plugin", { plugin: req.pluginId });
    if (req.agentId && s.agents.length > 0 && !s.agents.includes(req.agentId)) deny("vault.scope.agent", { agent: req.agentId });
    if (req.tool && s.tools.length > 0 && !s.tools.includes(req.tool)) deny("vault.scope.tool", { tool: req.tool });
    if (meta.type === "login" && req.domain !== undefined) {
      const allowedDomains = s.domains.length ? s.domains : meta.hints.url ? [new URL(meta.hints.url).hostname] : [];
      if (allowedDomains.length && !allowedDomains.some((d) => hostMatches(req.domain!, d) || hostMatches(req.domain!, "*." + d.replace(/^\*\./, "")))) {
        deny("vault.scope.domain", { domain: req.domain });
      }
    }
    const item = this.read(id);
    this.onAccess({ actor: req.actor, itemId: id, allowed: true });
    return item.fields;
  }

  /** Re-index all secret values for redaction. */
  refreshRedactor(): void {
    if (!this.key) return;
    const secrets: Array<{ id: string; value: string }> = [];
    for (const r of this.db.prepare("select id, secret, scope from vault_items").all() as Array<{ id: string; secret: string; scope: string }>) {
      // Items the user allowed the model to read are not redacted (that is the point of revealToModel).
      if (json<Partial<VaultScope>>(r.scope, {}).revealToModel) continue;
      try {
        const fields = openJson<Record<string, string>>(this.key, JSON.parse(r.secret) as Sealed, `item:${r.id}`);
        for (const [k, v] of Object.entries(fields)) {
          if (k === "username" || k === "url") continue;
          secrets.push({ id: r.id, value: v });
        }
      } catch {
        /* corrupted item — skip */
      }
    }
    this.redactor.setSecrets(secrets);
  }
}

export function refToId(ref: string): string {
  return ref.startsWith("vault://") ? ref.slice("vault://".length) : ref;
}

/** Ids people choose for vault items: they appear in vault://<id> references and grants. */
export const VAULT_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;

function slugId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function defaultHints(type: VaultItemType, fields: Record<string, string>): Record<string, string> {
  if (type === "login") {
    const h: Record<string, string> = {};
    if (fields.url) h.url = fields.url;
    if (fields.username) h.username = fields.username;
    return h;
  }
  return {};
}
