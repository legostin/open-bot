// Where the daemon keeps its state: ~/.piomio-node (override with PIOMIO_NODE_HOME).
// config.json {hubUrl, machineId, name} and key.json (Ed25519 private key) are written by `pair`.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { t } from "./messages.ts";

export interface NodeConfig {
  hubUrl: string;
  machineId: string;
  name: string;
  pairedAt?: string;
  /** Every replica of the hub (node.setup): the daemon keeps a connection to each. */
  hubUrls?: string[];
}

export interface NodeKey {
  /** base64url raw 32-byte Ed25519 secret key. */
  secretKey: string;
  /** base64url raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export function nodeHome(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  if (env.PIOMIO_NODE_HOME) return resolve(env.PIOMIO_NODE_HOME);
  const home = join(userHome, ".piomio-node");
  // The project was Owlbot until 2026-10-31: a machine paired then keeps its pairing and policy.
  const old = join(userHome, ".owlbot-node");
  if (!existsSync(home) && existsSync(old)) renameSync(old, home);
  return home;
}

export const configFile = (home: string) => join(home, "config.json");
export const keyFile = (home: string) => join(home, "key.json");
export const policyFile = (home: string) => join(home, "policy.json");

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** Errors whose message is meant for the user as is (the CLI prints them without a stack). */
export class UserError extends Error {}

export class NotPairedError extends UserError {
  constructor(home: string) {
    super(t("home.notPaired", { file: configFile(home) }));
  }
}

export function loadConfig(home: string): NodeConfig {
  const file = configFile(home);
  if (!existsSync(file) || !existsSync(keyFile(home))) throw new NotPairedError(home);
  let c: any;
  try {
    c = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(t("home.readFailed", { file, error: e.message }));
  }
  if (!c?.hubUrl || !c?.machineId) throw new Error(t("home.configCorrupt", { file }));
  const hubUrls = Array.isArray(c.hubUrls) ? c.hubUrls.map(String) : undefined;
  return { hubUrl: String(c.hubUrl), machineId: String(c.machineId), name: String(c.name ?? ""), pairedAt: c.pairedAt, ...(hubUrls ? { hubUrls } : {}) };
}

/** Remembers the hub's replicas, so a restart finds the others when the first one is away. */
export function saveHubUrls(home: string, hubUrls: string[]): void {
  const c = JSON.parse(readFileSync(configFile(home), "utf8"));
  if (JSON.stringify(c.hubUrls ?? []) === JSON.stringify(hubUrls)) return;
  writePrivate(configFile(home), JSON.stringify({ ...c, hubUrls }, null, 2) + "\n");
}

export function loadKey(home: string): NodeKey {
  const file = keyFile(home);
  if (!existsSync(file)) throw new NotPairedError(home);
  const k = JSON.parse(readFileSync(file, "utf8"));
  if (!k?.secretKey || Buffer.from(String(k.secretKey), "base64url").length !== 32) throw new Error(t("home.keyCorrupt", { file }));
  return { secretKey: String(k.secretKey), publicKey: String(k.publicKey ?? "") };
}

export function savePaired(home: string, config: NodeConfig, key: NodeKey): void {
  ensureHome(home);
  writePrivate(keyFile(home), JSON.stringify(key, null, 2) + "\n");
  writePrivate(configFile(home), JSON.stringify(config, null, 2) + "\n");
}

/** Owner-only file (0600). On Windows the user profile ACLs already keep it private. */
export function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

/** "http://host:8080/" → "http://host:8080"; rejects anything that is not http(s). */
export function normalizeHubUrl(input: string): string {
  const raw = String(input ?? "").trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UserError(t("home.badUrl", { url: raw }));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError(t("home.badScheme", { url: raw }));
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

/**
 * An invite link → the hub and the code: the hub's page `https://<hub>/join/<code>`, or the desktop app's
 * `piomio://pair?hub=…&code=…` that page opens. Undefined when it is neither.
 */
export function parseInviteLink(input: string): { hubUrl: string; code: string } | undefined {
  let u: URL;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    return undefined;
  }
  if (/^piomio(-test)?:$/.test(u.protocol)) {
    const hub = u.searchParams.get("hub");
    const code = u.searchParams.get("code");
    return hub && code ? { hubUrl: normalizeHubUrl(hub), code } : undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const m = /^(.*)\/join\/([A-Za-z0-9-]+)\/?$/.exec(u.pathname);
  return m ? { hubUrl: normalizeHubUrl(u.origin + m[1]), code: m[2] } : undefined;
}

/** Hub URL → WebSocket endpoint for nodes. */
export function nodeWsUrl(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/node/ws";
  return u.toString();
}
