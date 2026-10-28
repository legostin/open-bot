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

export function sendFile(reply: FastifyReply, file: string, opts: { cache?: boolean; download?: boolean } = {}): FastifyReply {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  reply.header("content-type", type);
  reply.header("cache-control", opts.cache ? "public, max-age=31536000, immutable" : "no-cache");
  if (opts.download) reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.split(/[\\/]/).pop()!)}`);
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

/** Same-origin check for state-changing requests: Origin (or Referer) must be one of `origins`. */
export function originAllowed(req: FastifyRequest, origins: string[]): boolean {
  const o = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
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
