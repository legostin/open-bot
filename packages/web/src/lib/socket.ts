// Realtime connection to the hub (/api/ws) with reconnect + backoff.

import type { UiEvent } from "@piomio/shared";
import { backoffDelay } from "./backoff";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "offline";

export interface SocketHandlers {
  onEvent(e: UiEvent): void;
  onState(s: ConnectionState): void;
  /** Fired after a successful reconnect (not on the first connect): refetch state. */
  onReconnect(): void;
  /** The upgrade keeps failing: maybe the session expired. */
  onRepeatedFailure?(): void;
}

export class HubSocket {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private everOpened = false;
  private stopped = false;
  private queue: string[] = [];
  private h: SocketHandlers;

  constructor(h: SocketHandlers) {
    this.h = h;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    this.ws?.close(1000, "bye");
    this.ws = undefined;
  }

  send(msg: unknown): void {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (this.queue.length < 200) this.queue.push(s);
  }

  /** Try now instead of waiting out the backoff (the phone app saw the hub come back). */
  retryNow(): void {
    this.wake();
  }

  /** Reconnect immediately when the tab becomes visible / network comes back. */
  private wake = () => {
    if (this.stopped || document.visibilityState === "hidden") return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      clearTimeout(this.timer);
      this.attempt = 0;
      this.connect();
    }
  };

  private connect(): void {
    if (this.stopped) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.h.onState(this.everOpened ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.h.onState("open");
      for (const m of this.queue.splice(0)) ws.send(m);
      if (reconnected) this.h.onReconnect();
    };
    ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(String(ev.data)) as UiEvent;
        if (e && typeof e.type === "string") this.h.onEvent(e);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      this.h.onState(this.attempt > 2 ? "offline" : "reconnecting");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    // Every third failure: the hub may be back with the session gone (it restarted), and the upgrade fails for good.
    if (this.attempt % 3 === 0) this.h.onRepeatedFailure?.();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
