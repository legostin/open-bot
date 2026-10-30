// Egress proxy: brains and plugins reach the network only through here.
// Each process gets a token (in the proxy URL userinfo) mapped to a host allowlist.

import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { hostMatches } from "@owlbot/shared";
import type { AuditLog } from "./audit.ts";

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const PRIVATE_V6: Array<[string, number]> = [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]];
const privateNets = new net.BlockList();
for (const [a, p] of PRIVATE_V4) privateNets.addSubnet(a, p, "ipv4");
for (const [a, p] of PRIVATE_V6) privateNets.addSubnet(a, p, "ipv6");

/** dns.lookup replacement that only returns addresses we already checked (no second resolution). */
export function pinnedLookup(addrs: string[]): net.LookupFunction {
  return ((_host: string, opts: { all?: boolean }, cb: (...a: any[]) => void) => {
    if (opts?.all) cb(null, addrs.map((address) => ({ address, family: net.isIP(address) })));
    else cb(null, addrs[0], net.isIP(addrs[0]));
  }) as net.LookupFunction;
}

function v4FromHex(hi: string, lo: string): string {
  const n = ((parseInt(hi, 16) << 16) | parseInt(lo, 16)) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Loopback, LAN, link-local, CGNAT, multicast… including IPv4 embedded in IPv6 (mapped, NAT64, 6to4). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return privateNets.check(ip, "ipv4");
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return privateNets.check(dotted[1], "ipv4");
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) return privateNets.check(v4FromHex(hex[1], hex[2]), "ipv4");
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) return privateNets.check(v4FromHex(sixToFour[1], sixToFour[2]), "ipv4");
  return privateNets.check(ip, "ipv6");
}

interface Grant {
  owner: string;
  allow: string[];
}

export class EgressProxy {
  private grants = new Map<string, Grant>();
  private server?: http.Server;
  private denyLogged = new Map<string, number>();
  audit?: AuditLog;
  /** Dynamic extra allowlist for brains (settings.brainEgressAllow). */
  extraBrainAllow: () => string[] = () => [];
  /** Hosts allowed to resolve to private addresses (settings.egressPrivateAllow). */
  privateAllow: () => string[] = () => [];

  /**
   * Resolve once and return the address to connect to, so a DNS answer cannot change between check and use.
   * Private destinations are refused unless the host is listed in privateAllow.
   */
  async resolveTarget(host: string): Promise<string[]> {
    const bare = host.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(bare) ? [bare] : (await lookup(bare, { all: true, verbatim: true })).map((a) => a.address);
    if (addrs.length === 0) throw new Error(`cannot resolve ${host}`);
    const okPrivate = this.privateAllow().some((p) => hostMatches(bare, p));
    if (!okPrivate && addrs.some(isPrivateAddress)) throw new Error(`${host} resolves to a private address; add it to egressPrivateAllow to allow`);
    return addrs;
  }

  issueToken(owner: string, allow: string[]): string {
    const token = randomBytes(18).toString("base64url");
    this.grants.set(token, { owner, allow });
    return token;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  revokeOwner(owner: string): void {
    for (const [t, g] of this.grants) if (g.owner === owner) this.grants.delete(t);
  }

  allowed(token: string | undefined, host: string): { ok: boolean; owner?: string } {
    if (!token) return { ok: false };
    const g = this.grants.get(token);
    if (!g) return { ok: false };
    const list = g.owner.startsWith("brain:") ? [...g.allow, ...this.extraBrainAllow()] : g.allow;
    return { ok: list.some((p) => hostMatches(host, p)), owner: g.owner };
  }

  private tokenFrom(req: http.IncomingMessage): string | undefined {
    const h = req.headers["proxy-authorization"];
    if (!h || Array.isArray(h)) return undefined;
    const m = /^Basic\s+(.+)$/i.exec(h);
    if (!m) return undefined;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    return decoded.split(":")[0];
  }

  private logDeny(owner: string | undefined, host: string): void {
    const key = `${owner}|${host}`;
    const last = this.denyLogged.get(key) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.denyLogged.set(key, Date.now());
    this.audit?.append(owner ?? "unknown", "egress.deny", host);
  }

  listen(port: number): Promise<void> {
    const server = http.createServer((req, res) => {
      // Plain HTTP proxying (absolute-form URL).
      let target: URL;
      try {
        target = new URL(req.url ?? "");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const token = this.tokenFrom(req);
      const verdict = this.allowed(token, target.hostname);
      if (!verdict.ok) {
        this.logDeny(verdict.owner, target.hostname);
        res.writeHead(token ? 403 : 407, { "proxy-authenticate": "Basic realm=owlbot" }).end(`egress to ${target.hostname} is not allowed`);
        return;
      }
      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      this.resolveTarget(target.hostname).then(
        (addrs) => {
          const opts: http.RequestOptions = {
            host: target.hostname,
            port: Number(target.port || 80),
            lookup: pinnedLookup(addrs), // Node tries each address in turn (autoSelectFamily is on by default)
            method: req.method,
            path: target.pathname + target.search,
            headers,
          };
          const up = http.request(opts, (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          });
          up.on("error", (e) => {
            if (!res.headersSent) res.writeHead(502);
            res.end(`upstream error: ${e.message}`);
          });
          req.pipe(up);
        },
        (e: Error) => {
          this.logDeny(verdict.owner, target.hostname);
          res.writeHead(403).end(`egress to ${target.hostname} is not allowed: ${e.message}`);
        },
      );
    });

    server.on("connect", (req, clientSocket: net.Socket, head) => {
      // A client may reset the connection at any moment, a refused one too: never let that error go unheard.
      clientSocket.on("error", () => {});
      const raw = req.url ?? "";
      const sep = raw.lastIndexOf(":");
      const host = (sep > 0 ? raw.slice(0, sep) : raw).replace(/^\[|\]$/g, "");
      const port = Number(sep > 0 ? raw.slice(sep + 1) : 443);
      const token = this.tokenFrom(req);
      const verdict = this.allowed(token, host);
      if (!verdict.ok) {
        this.logDeny(verdict.owner, host);
        clientSocket.end(`HTTP/1.1 ${token ? "403 Forbidden" : "407 Proxy Authentication Required"}\r\nProxy-Authenticate: Basic realm=owlbot\r\n\r\n`);
        return;
      }
      this.resolveTarget(host).then(
        (addrs) => {
          const upstream = net.connect({ host, port, lookup: pinnedLookup(addrs), autoSelectFamily: true }, () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head?.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
          });
          upstream.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
          clientSocket.on("error", () => upstream.destroy());
        },
        () => {
          this.logDeny(verdict.owner, host);
          clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        },
      );
    });

    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  close(): Promise<void> {
    // The plugins and brains that held connections are gone by now: kept-alive ones would hold the close forever.
    return new Promise((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections?.();
    });
  }
}
