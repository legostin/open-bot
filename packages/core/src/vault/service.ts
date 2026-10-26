// Encrypted vault. Item metadata (name, type, scope, hints) is plaintext so it can be listed while sealed;
// secret fields are encrypted with a random data key wrapped by an Argon2id-derived key.

import { readFileSync } from "node:fs";
import type { VaultItem, VaultItemMeta, VaultItemType, VaultScope, VaultState } from "@openbot/shared";
import { hostMatches, newId, nowIso } from "@openbot/shared";
import { openDb, json, type Db } from "../db.ts";
import { DEFAULT_KDF, deriveKey, newDataKey, newSalt, open, openJson, seal, sealJson, type KdfParams, type Sealed } from "./crypto.ts";
import { Redactor } from "./redact.ts";

export class VaultError extends Error {
  code: "sealed" | "uninitialized" | "not_found" | "forbidden" | "bad_passphrase" | "exists";
  constructor(code: VaultError["code"], message: string) {
    super(message);
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
    if (this.meta("wrapped_key")) throw new VaultError("exists", "Vault уже инициализирован");
    if (passphrase.length < 8) throw new VaultError("bad_passphrase", "Пароль vault — минимум 8 символов");
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
    if (!wrapped) throw new VaultError("uninitialized", "Vault ещё не создан");
    const kdf = json<KdfParams>(this.meta("kdf"), { ...DEFAULT_KDF, salt: "" });
    try {
      this.key = open(deriveKey(passphrase, kdf), JSON.parse(wrapped) as Sealed, "openbot-vault-dek");
    } catch {
      throw new VaultError("bad_passphrase", "Неверный пароль vault");
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
    if (!this.key) throw new VaultError(this.state() === "uninitialized" ? "uninitialized" : "sealed", "Vault запечатан — разблокируйте его в пульте безопасности");
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
    if (!r) throw new VaultError("not_found", `Нет записи vault://${id}`);
    const fields = openJson<Record<string, string>>(key, JSON.parse(r.secret) as Sealed, `item:${id}`);
    return { ...this.metaFrom(r), fields };
  }

  upsert(input: { id?: string; type: VaultItemType; name: string; fields: Record<string, string>; scope?: Partial<VaultScope>; hints?: Record<string, string> }): VaultItemMeta {
    const key = this.requireKey();
    const id = input.id ?? (slugId(input.name) || newId("v_"));
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
    if (!m) throw new VaultError("not_found", `Нет записи vault://${id}`);
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
      throw new VaultError("not_found", `Нет записи vault://${id}`);
    }
    const deny = (reason: string): never => {
      this.onAccess({ actor: req.actor, itemId: id, allowed: false, reason });
      throw new VaultError("forbidden", `Доступ к vault://${id} запрещён: ${reason}`);
    };
    const s = meta.scope;
    if (req.pluginId && s.plugins.length > 0 && !s.plugins.includes(req.pluginId) && !s.plugins.includes("*")) deny(`плагин ${req.pluginId} не в области записи`);
    if (req.pluginId && s.plugins.length === 0 && meta.type === "login") deny(`плагин ${req.pluginId} не в области записи`);
    if (req.agentId && s.agents.length > 0 && !s.agents.includes(req.agentId)) deny(`агент ${req.agentId} не в области записи`);
    if (req.tool && s.tools.length > 0 && !s.tools.includes(req.tool)) deny(`инструмент ${req.tool} не в области записи`);
    if (meta.type === "login" && req.domain !== undefined) {
      const allowedDomains = s.domains.length ? s.domains : meta.hints.url ? [new URL(meta.hints.url).hostname] : [];
      if (allowedDomains.length && !allowedDomains.some((d) => hostMatches(req.domain!, d) || hostMatches(req.domain!, "*." + d.replace(/^\*\./, "")))) {
        deny(`домен ${req.domain} не разрешён для этой записи`);
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
