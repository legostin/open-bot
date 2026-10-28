// The device port's TLS identity: a self-signed ECDSA P-256 certificate, made once and kept in <data>/devices/.
// Phones never check it against a CA: the QR carries the SHA-256 of the certificate and the app pins it. Node can
// make keys but not certificates, so the certificate's DER is assembled here (no dependency).

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface DeviceTls {
  key: string;
  cert: string;
  /** base64url SHA-256 of the certificate's DER, what the phone pins. */
  fingerprint: string;
}

// ---------- DER ----------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    for (let v = p; ; v = Math.floor(v / 128)) {
      chunk.unshift((v % 128) | (chunk.length ? 0x80 : 0));
      if (v < 128) break;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime up to 2049, GeneralizedTime after (RFC 5280). */
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const COMMON_NAME = "2.5.4.3";

/** A self-signed X.509 v3 certificate (DER) for `publicKey`, valid for 20 years. */
export function selfSignedCertificate(publicKey: KeyObject, privateKey: KeyObject, commonName: string, now = new Date()): Buffer {
  const name = seq(set(seq(oid(COMMON_NAME), tlv(0x0c, Buffer.from(commonName.slice(0, 64))))));
  const algorithm = seq(oid(ECDSA_SHA256));
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 20);
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(randomBytes(16)),
    algorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  return seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

export function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function fingerprintOf(certPem: string): string {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  return createHash("sha256").update(der).digest("base64url");
}

/** The device port's key and certificate, created on first use and kept (hub-only files) so pinned phones keep working. */
export function deviceTls(dataDir: string): DeviceTls {
  const dir = join(dataDir, "devices");
  const keyFile = join(dir, "tls-key.pem");
  const certFile = join(dir, "tls-cert.pem");
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = selfSignedCertificate(publicKey, privateKey, `Owlbot hub ${hostname()}`);
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    writeFileSync(certFile, pem("CERTIFICATE", der), { mode: 0o644 });
  }
  const key = readFileSync(keyFile, "utf8");
  const cert = readFileSync(certFile, "utf8");
  return { key, cert, fingerprint: fingerprintOf(cert) };
}
