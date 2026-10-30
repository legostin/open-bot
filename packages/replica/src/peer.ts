// How replicas talk: every request is signed with the sender's Ed25519 key, and the TLS certificate of the other side is
// pinned by fingerprint (all replicas serve the hub's one self-signed device certificate).

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { ed25519 } from "@noble/curves/ed25519.js";

export interface ReplicaKey {
  id: string;
  /** base64url */
  publicKey: string;
  secretKey: string;
}

export const REPLICA_AUTH = "OwlbotReplica";
/** How far a request's clock may be from ours. */
const WINDOW_MS = 60_000;

export function newReplicaKey(id: string): ReplicaKey {
  const secret = ed25519.utils.randomSecretKey();
  return { id, publicKey: Buffer.from(ed25519.getPublicKey(secret)).toString("base64url"), secretKey: Buffer.from(secret).toString("base64url") };
}

const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("base64url");
const message = (method: string, path: string, ts: number, nonce: string, body: string | Uint8Array) =>
  new TextEncoder().encode(`${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${digest(body)}`);

/** The authorization header of a request. */
export function signRequest(key: ReplicaKey, method: string, path: string, body: string | Uint8Array = "", now = Date.now()): string {
  const nonce = randomBytes(9).toString("base64url");
  const sig = ed25519.sign(message(method, path, now, nonce, body), Buffer.from(key.secretKey, "base64url"));
  return `${REPLICA_AUTH} ${key.id}.${now}.${nonce}.${Buffer.from(sig).toString("base64url")}`;
}

/** The replica that signed a request, or undefined. `publicKey` looks a replica's key up (undefined: unknown or revoked). */
export function verifyRequest(
  header: string | undefined,
  method: string,
  path: string,
  body: string | Uint8Array,
  publicKey: (id: string) => string | undefined,
  now = Date.now(),
): string | undefined {
  if (!header?.startsWith(`${REPLICA_AUTH} `)) return undefined;
  const [id, tsText, nonce, sig] = header.slice(REPLICA_AUTH.length + 1).split(".");
  const ts = Number(tsText);
  if (!id || !nonce || !sig || !Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) return undefined;
  const pub = publicKey(id);
  if (!pub) return undefined;
  try {
    return ed25519.verify(Buffer.from(sig, "base64url"), message(method, path, ts, nonce, body), Buffer.from(pub, "base64url")) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The fingerprint the hub pins (devices-tls.ts): sha256 of the certificate's DER, base64url. */
export function fingerprintOfDer(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("base64url");
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export class PinError extends Error {}

/**
 * One HTTP(S) request. With a fingerprint, the server's certificate must be that one (any CA, a self-signed one
 * included); without one, the usual CA checks apply. The body is read whole.
 */
export function pinnedRequest(
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; fingerprint?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PinnedResponse> {
  const u = new URL(url);
  const https = u.protocol === "https:";
  const body = o.body ?? "";
  return new Promise((resolve, reject) => {
    const req = (https ? httpsRequest : httpRequest)(
      u,
      {
        method: o.method ?? "GET",
        headers: { ...(o.headers ?? {}), ...(body.length ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
        ...(https && o.fingerprint ? { rejectUnauthorized: false } : {}),
        timeout: o.timeoutMs ?? 30_000,
        ...(o.signal ? { signal: o.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    if (https && o.fingerprint) {
      req.on("socket", (s) => {
        const check = () => {
          const der = (s as TLSSocket).getPeerCertificate?.()?.raw;
          if (!der || fingerprintOfDer(der) !== o.fingerprint) req.destroy(new PinError(`certificate of ${u.host} is not the hub's`));
        };
        if ((s as TLSSocket).authorized !== undefined && (s as any).encrypted && (s as any)._secureEstablished) check();
        else s.once("secureConnect", check);
      });
    }
    req.on("timeout", () => req.destroy(new Error(`timeout: ${u.host}`)));
    req.on("error", reject);
    req.end(body.length ? body : undefined);
  });
}
