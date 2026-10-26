import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface KdfParams {
  t: number;
  m: number; // KiB
  p: number;
  salt: string; // base64
}

export const DEFAULT_KDF: Omit<KdfParams, "salt"> = { t: 3, m: 65536, p: 1 };

export function newSalt(): string {
  return randomBytes(16).toString("base64");
}

export function deriveKey(passphrase: string, kdf: KdfParams): Uint8Array {
  return argon2id(passphrase, Buffer.from(kdf.salt, "base64"), { t: kdf.t, m: kdf.m, p: kdf.p, dkLen: 32 });
}

export interface Sealed {
  nonce: string; // base64, 24 bytes
  ct: string; // base64
}

export function seal(key: Uint8Array, plaintext: Uint8Array, aad?: string): Sealed {
  const nonce = new Uint8Array(randomBytes(24));
  const cipher = xchacha20poly1305(key, nonce, aad ? new TextEncoder().encode(aad) : undefined);
  const ct = cipher.encrypt(plaintext);
  return { nonce: Buffer.from(nonce).toString("base64"), ct: Buffer.from(ct).toString("base64") };
}

export function open(key: Uint8Array, sealed: Sealed, aad?: string): Uint8Array {
  const cipher = xchacha20poly1305(key, new Uint8Array(Buffer.from(sealed.nonce, "base64")), aad ? new TextEncoder().encode(aad) : undefined);
  return cipher.decrypt(new Uint8Array(Buffer.from(sealed.ct, "base64")));
}

export function sealJson(key: Uint8Array, value: unknown, aad?: string): Sealed {
  return seal(key, new TextEncoder().encode(JSON.stringify(value)), aad);
}

export function openJson<T>(key: Uint8Array, sealed: Sealed, aad?: string): T {
  return JSON.parse(new TextDecoder().decode(open(key, sealed, aad))) as T;
}

export function newDataKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Password hashing for login (Argon2id, OWASP minimum params). Format: argon2id$t$m$p$salt$hash */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const t = 2;
  const m = 19456;
  const p = 1;
  const h = argon2id(password, salt, { t, m, p, dkLen: 32 });
  return `argon2id$${t}$${m}$${p}$${salt.toString("base64")}$${Buffer.from(h).toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, t, m, p, salt, hash] = stored.split("$");
  if (alg !== "argon2id") return false;
  const h = argon2id(password, Buffer.from(salt, "base64"), { t: Number(t), m: Number(m), p: Number(p), dkLen: 32 });
  return constantTimeEqual(Buffer.from(h).toString("base64"), hash);
}
