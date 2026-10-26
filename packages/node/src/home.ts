// Where the daemon keeps its state: ~/.openbot-node (override with OPENBOT_NODE_HOME).
// config.json {hubUrl, machineId, name} and key.json (Ed25519 private key) are written by `pair`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { t } from "./messages.ts";

export interface NodeConfig {
  hubUrl: string;
  machineId: string;
  name: string;
  pairedAt?: string;
}

export interface NodeKey {
  /** base64url raw 32-byte Ed25519 secret key. */
  secretKey: string;
  /** base64url raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export function nodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OPENBOT_NODE_HOME || join(homedir(), ".openbot-node"));
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
  return { hubUrl: String(c.hubUrl), machineId: String(c.machineId), name: String(c.name ?? ""), pairedAt: c.pairedAt };
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

/** Hub URL → WebSocket endpoint for nodes. */
export function nodeWsUrl(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/node/ws";
  return u.toString();
}
