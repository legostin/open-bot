// Shared HTTP helpers for the main app and the security console.

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Params } from "@owlbot/shared";
import { LocalizedError } from "../i18n.ts";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Resolve `rel` inside `root`; undefined if it escapes the root or does not exist as a file. */
export function safeFile(root: string, rel: string): string | undefined {
  const base = resolve(root);
  const full = resolve(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return undefined;
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return full;
}

/** `attachment` with the file's name (RFC 6266: an ASCII fallback, then the UTF-8 name). */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The single byte range a `Range` header asks for: undefined to send the whole file (none, malformed, several). */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    // The last N bytes.
    const n = Number(m[2]);
    if (!n) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * A file with its length (a download shows progress), a validator (opened again, it comes back as 304) and byte
 * ranges (Safari plays a video only from a server that answers them).
 */
export function sendFile(reply: FastifyReply, file: string, opts: { cache?: boolean; download?: boolean } = {}): FastifyReply {
  const st = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header("content-type", type);
  reply.header("cache-control", opts.cache ? "public, max-age=31536000, immutable" : "no-cache");
  reply.header("etag", etag);
  reply.header("last-modified", st.mtime.toUTCString());
  reply.header("accept-ranges", "bytes");
  if (opts.download) reply.header("content-disposition", attachmentDisposition(file.split(/[\\/]/).pop()!));
  const headers = reply.request.headers;
  if (headers["if-none-match"]?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return reply.code(304).send();
  const ifRange = headers["if-range"];
  const range = ifRange === undefined || ifRange === etag ? byteRange(headers.range, st.size) : undefined;
  if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${st.size}`).send();
  if (range) {
    reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${st.size}`).header("content-length", range.end - range.start + 1);
    return reply.send(createReadStream(file, range));
  }
  reply.header("content-length", st.size);
  return reply.send(createReadStream(file));
}

export function hostAllowed(req: FastifyRequest, allowed: string[]): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return allowed.includes(name);
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Same-origin check for state-changing requests: Origin (or Referer) must be one of `origins`. The page's
 * `Referrer-Policy: no-referrer` makes a browser send `Origin: null` on its own same-origin XMLHttpRequests (an upload
 * that reports progress); the browser's `Sec-Fetch-Site: same-origin`, which no page can set, vouches for those.
 */
export function originAllowed(req: FastifyRequest, origins: string[]): boolean {
  const o = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
  if ((!o || o === "null") && req.headers["sec-fetch-site"] === "same-origin") return true;
  if (!o) return false;
  return origins.includes(o);
}

function safeOrigin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

/** Origins the browser may use to reach a service on `port` via any allowed host name. */
export function originsFor(base: string, allowedHosts: string[], port: number): string[] {
  const out = new Set<string>([originOf(base)]);
  for (const h of allowedHosts) {
    out.add(`http://${h}:${port}`);
    out.add(`https://${h}:${port}`);
  }
  return [...out];
}

export function clientIp(req: FastifyRequest): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Failed attempts per client address in a sliding window: pairing and the invite page share one. */
export class FailureBudget {
  private limit: number;
  private windowMs: number;
  private seen = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private recent(ip: string, now = Date.now()): number[] {
    const list = (this.seen.get(ip) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.seen.set(ip, list);
    else this.seen.delete(ip);
    return list;
  }

  exhausted(req: FastifyRequest): boolean {
    return this.recent(clientIp(req)).length >= this.limit;
  }

  fail(req: FastifyRequest): void {
    const ip = clientIp(req);
    this.seen.set(ip, [...this.recent(ip), Date.now()]);
  }
}

export function securityHeaders(reply: FastifyReply, csp: string): void {
  reply.header("content-security-policy", csp);
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

/** HTTP error with a core message key (locales/en.ts); text that is not a key is shown as is. */
export class HttpError extends LocalizedError {
  declare status: number;
  constructor(status: number, key: string, params?: Params) {
    super(key, params, status);
  }
}
