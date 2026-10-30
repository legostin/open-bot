// A standby replica sends the phones on to the leader (cluster.ts): device-app requests and the app's WebSocket go
// through as they are (the phone's token is the same on every replica), so a phone may reach the hub at any
// replica's address. The replicas' own routes stay here.

import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import WebSocket from "ws";
import type { Hub } from "../app.ts";

const HERE = /^\/api\/replica\//;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

const pinOk = (s: TLSSocket, fingerprint: string): boolean => {
  const der = s.getPeerCertificate?.()?.raw;
  return !!der && createHash("sha256").update(der).digest("base64url") === fingerprint;
};

function headersFor(h: IncomingHttpHeaders, ip: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  out["x-forwarded-for"] = ip;
  return out;
}

/** onRequest hook of the device app. */
export function forwardToLeader(hub: Hub, req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const target = hub.cluster.leaderTarget();
  if (!target || HERE.test(req.url) || req.headers.upgrade) return done();
  const fingerprint = hub.deviceTls().fingerprint;
  const url = new URL(req.url, target.url);
  const https = url.protocol === "https:";
  reply.hijack();
  const up = (https ? httpsRequest : httpRequest)(
    url,
    { method: req.method, headers: headersFor(req.headers, req.ip), ...(https ? { rejectUnauthorized: false } : {}), timeout: 6 * 3600_000 },
    (res) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
      reply.raw.writeHead(res.statusCode ?? 502, headers);
      res.pipe(reply.raw);
    },
  );
  if (https) up.on("socket", (s) => s.once("secureConnect", () => !pinOk(s as TLSSocket, fingerprint) && up.destroy(new Error("leader certificate"))));
  up.on("error", () => {
    if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
    reply.raw.end(JSON.stringify({ error: `The hub is moving to ${target.name}; try again in a moment` }));
  });
  req.raw.pipe(up);
}

/** The app's WebSocket on a standby: one to the leader, messages both ways. True when it took the socket. */
export function pipeToLeader(hub: Hub, socket: WebSocket, req: FastifyRequest): boolean {
  const target = hub.cluster.leaderTarget();
  if (!target) return false;
  const fingerprint = hub.deviceTls().fingerprint;
  const url = new URL(req.url, target.url.replace(/^http/, "ws"));
  const headers: Record<string, string> = {};
  for (const k of ["authorization", "cookie", "user-agent", "accept-language"]) if (typeof req.headers[k] === "string") headers[k] = req.headers[k] as string;
  headers.origin = target.url;
  const up = new WebSocket(url, { headers, rejectUnauthorized: false, handshakeTimeout: 10_000 });
  up.on("upgrade", (res) => {
    const s = res.socket as TLSSocket;
    if (url.protocol === "wss:" && !pinOk(s, fingerprint)) up.terminate();
  });
  const queue: Array<WebSocket.RawData> = [];
  socket.on("message", (d) => (up.readyState === WebSocket.OPEN ? up.send(d) : queue.push(d)));
  up.on("open", () => {
    for (const d of queue.splice(0)) up.send(d);
  });
  up.on("message", (d, binary) => socket.readyState === WebSocket.OPEN && socket.send(d, { binary }));
  const closeBoth = () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1012, "hub moved");
    if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.terminate();
  };
  up.on("close", closeBoth);
  up.on("error", closeBoth);
  socket.on("close", closeBoth);
  return true;
}
