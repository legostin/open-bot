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
import { linkHttp } from "../replica-link.ts";

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
  if (target.link) {
    // Over the link to the leader (it may have no address we can reach).
    reply.hijack();
    const link = target.link;
    const chunks: Buffer[] = [];
    req.raw.on("data", (c: Buffer) => chunks.push(c));
    req.raw.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !HOP.has(k) && k !== "content-length") headers[k] = v;
      headers["x-forwarded-for"] = req.ip;
      linkHttp(link, { method: req.method, path: req.url, headers, body: Buffer.concat(chunks) }).then(
        (r) => {
          reply.raw.writeHead(r.status, r.headers);
          reply.raw.end(r.body);
        },
        () => {
          if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
          reply.raw.end(JSON.stringify({ error: `The hub is moving to ${target.name}; try again in a moment` }));
        },
      );
    });
    return;
  }
  if (!target.url) return done();
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
  const headers0: Record<string, string> = {};
  for (const k of ["authorization", "cookie", "user-agent", "accept-language"]) if (typeof req.headers[k] === "string") headers0[k] = req.headers[k] as string;
  if (target.link) {
    // The leader opens the socket to its own device app; messages travel over the link.
    const link = target.link;
    const id = Math.random().toString(36).slice(2);
    const queue: string[] = [];
    let open = false;
    const close = () => {
      link.notify("replica.ws.close", { id });
      if (socket.readyState === WebSocket.OPEN) socket.close(1012, "hub moved");
    };
    link.onNotification("replica.ws.msg", (m: { id: string; data: string; binary?: boolean }) => {
      if (m.id === id && socket.readyState === WebSocket.OPEN) socket.send(m.binary ? Buffer.from(m.data, "base64") : m.data);
    });
    link.onNotification("replica.ws.close", (m: { id: string }) => m.id === id && socket.readyState === WebSocket.OPEN && socket.close(1012, "hub moved"));
    socket.on("message", (d, binary) => {
      const data = binary ? Buffer.from(d as Buffer).toString("base64") : String(d);
      if (open) link.notify("replica.ws.msg", { id, data, binary });
      else queue.push(JSON.stringify({ data, binary }));
    });
    socket.on("close", close);
    link.request("replica.ws.open", { id, path: req.url, headers: { ...headers0, origin: `https://127.0.0.1:${hub.config.devicePort}` } }, { timeoutMs: 15_000 }).then(
      () => {
        open = true;
        for (const q of queue.splice(0)) link.notify("replica.ws.msg", { id, ...JSON.parse(q) });
      },
      close,
    );
    link.onClose(close);
    return true;
  }
  if (!target.url) return false;
  const fingerprint = hub.deviceTls().fingerprint;
  const url = new URL(req.url, target.url.replace(/^http/, "ws"));
  const headers: Record<string, string> = { ...headers0, origin: target.url };
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
