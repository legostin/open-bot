// Hub connection: outgoing WebSocket to <hub>/node/ws, Ed25519 challenge auth, then JSON-RPC 2.0.
// Reconnects forever with exponential backoff (max 60 s); a 4401 close (revoked / unknown key) is fatal.

import WebSocket from "ws";
import { createRpcPeer, wsTransport, type RpcPeer, type WsLike } from "@openbot/shared";
import { nodeWsUrl } from "./home.ts";
import { signChallenge } from "./keys.ts";
import { machineInfo, type Logger } from "./info.ts";
import type { NodeService } from "./service.ts";

export const CLOSE_UNAUTHORIZED = 4401;

export interface NodeClientOptions {
  hubUrl: string;
  machineId: string;
  secretKey: string;
  service: NodeService;
  log: Logger;
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called once when the hub refuses this machine for good (close code 4401). */
  onFatal?: (message: string) => void;
}

export type ClientState = "idle" | "connecting" | "online" | "stopped";

export class NodeClient {
  private o: NodeClientOptions;
  state: ClientState = "idle";
  private ws?: WebSocket;
  private peer?: RpcPeer;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private onlineWaiters: Array<() => void> = [];
  private stopPolicyWatch?: () => void;
  private helloTimer?: NodeJS.Timeout;
  /** Name the hub knows this machine by (from node.hello). */
  hubName?: string;

  constructor(o: NodeClientOptions) {
    this.o = o;
    o.service.policy.onChange(() => {
      // Allowed dirs / brains changed: tell the hub (debounced).
      if (this.state !== "online") return;
      clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => void this.hello().catch((e) => this.o.log(`node.hello: ${e.message}`)), 300);
    });
  }

  start(): void {
    if (this.state !== "idle") return;
    this.stopPolicyWatch = this.o.service.policy.watch();
    this.connect();
  }

  /** Resolves once authenticated and node.hello was accepted. */
  waitOnline(timeoutMs = 30_000): Promise<void> {
    if (this.state === "online") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("хаб не ответил вовремя")), timeoutMs);
      this.onlineWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private connect(): void {
    if (this.state === "stopped") return;
    this.state = "connecting";
    const url = nodeWsUrl(this.o.hubUrl);
    const ws = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024 });
    this.ws = ws;
    let authed = false;
    let lastError: string | undefined;

    ws.on("message", (data) => {
      if (authed) return;
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.type === "challenge" && typeof msg.nonce === "string") {
        ws.send(JSON.stringify({ type: "auth", machineId: this.o.machineId, signature: signChallenge(msg.nonce, this.o.secretKey) }));
      } else if (msg?.type === "ok") {
        authed = true;
        this.onAuthed(ws);
      }
    });
    ws.on("error", (e: any) => {
      lastError = e?.code ? `${e.code}` : (e?.message ?? String(e));
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = String(reasonBuf ?? "");
      const wasOnline = this.state === "online";
      if (this.ws === ws) {
        this.ws = undefined;
        this.peer = undefined;
      }
      clearInterval(this.pingTimer);
      void this.o.service.abortAll();
      if (this.state === "stopped") return;
      if (code === CLOSE_UNAUTHORIZED) {
        const message =
          `Хаб отклонил подключение (${reason || "unauthorized"}): машина отозвана или ключ не подходит.\n` +
          `Привяжите машину заново: openbot-node pair ${this.o.hubUrl} <код>`;
        this.o.log(message);
        void this.stop();
        this.o.onFatal?.(message);
        return;
      }
      if (wasOnline) this.o.log(`соединение с хабом потеряно (${code}${reason ? ` ${reason}` : ""})`);
      this.scheduleReconnect(lastError);
    });
  }

  private scheduleReconnect(why?: string): void {
    if (this.state === "stopped") return;
    this.state = "connecting";
    const min = this.o.minBackoffMs ?? 1000;
    const max = this.o.maxBackoffMs ?? 60_000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 16));
    this.attempt++;
    const after = delay < 1000 ? `${delay} мс` : `${Math.round(delay / 1000)} с`;
    this.o.log(why ? `хаб ${this.o.hubUrl} недоступен (${why}), повтор через ${after}` : `переподключение через ${after}`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onAuthed(ws: WebSocket): void {
    // From here on every text frame is JSON-RPC. The listener is added while the "ok" frame is being
    // dispatched, so it only sees later frames.
    const peer = createRpcPeer(wsTransport(ws as unknown as WsLike));
    this.peer = peer;
    this.o.service.attach(peer);
    void (async () => {
      try {
        const r = await this.hello();
        if (this.peer !== peer) return;
        this.attempt = 0;
        this.state = "online";
        this.hubName = r?.name;
        this.o.log(`подключено к хабу ${this.o.hubUrl} как «${r?.name ?? this.o.machineId}»`);
        for (const w of this.onlineWaiters.splice(0)) w();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          peer.request("node.ping", {}, { timeoutMs: 15_000 }).catch(() => {
            if (this.peer === peer) {
              this.o.log("хаб не отвечает на ping, переподключение");
              ws.terminate();
            }
          });
        }, this.o.pingIntervalMs ?? 30_000);
        this.pingTimer.unref?.();
      } catch (e: any) {
        this.o.log(`node.hello не удался: ${e?.message ?? e}`);
        ws.terminate();
      }
    })();
  }

  /** Probe the CLIs and announce this machine (info + installed brains) to the hub. */
  async hello(): Promise<{ machineId: string; name: string }> {
    const peer = this.peer;
    if (!peer) throw new Error("нет соединения с хабом");
    const clis = await this.o.service.brains.probeAll();
    const info = machineInfo(this.o.service.policy.get(), clis);
    const brains = this.o.service.brains.available();
    const r = await peer.request<{ machineId: string; name: string }>("node.hello", { info, brains }, { timeoutMs: 30_000 });
    this.o.log(`мозги: ${brains.map((b) => b.id).join(", ") || "нет"}`);
    return r;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.helloTimer);
    clearInterval(this.pingTimer);
    this.stopPolicyWatch?.();
    const ws = this.ws;
    this.ws = undefined;
    this.peer = undefined;
    try {
      ws?.close(1000, "node stopping");
    } catch {
      /* ignore */
    }
    await this.o.service.abortAll();
  }
}
