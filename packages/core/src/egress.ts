// Egress proxy: brains and plugins reach the network only through here.
// Each process gets a token (in the proxy URL userinfo) mapped to a host allowlist.

import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { hostMatches } from "@openbot/shared";
import type { AuditLog } from "./audit.ts";

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
        res.writeHead(token ? 403 : 407, { "proxy-authenticate": "Basic realm=openbot" }).end(`egress to ${target.hostname} is not allowed`);
        return;
      }
      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const up = http.request(
        { host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on("error", (e) => res.writeHead(502).end(`upstream error: ${e.message}`));
      req.pipe(up);
    });

    server.on("connect", (req, clientSocket: net.Socket, head) => {
      const [host, portStr] = (req.url ?? "").split(":");
      const port = Number(portStr || 443);
      const token = this.tokenFrom(req);
      const verdict = this.allowed(token, host);
      if (!verdict.ok) {
        this.logDeny(verdict.owner, host);
        clientSocket.end(`HTTP/1.1 ${token ? "403 Forbidden" : "407 Proxy Authentication Required"}\r\nProxy-Authenticate: Basic realm=openbot\r\n\r\n`);
        return;
      }
      const upstream = net.connect(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      clientSocket.on("error", () => upstream.destroy());
    });

    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
