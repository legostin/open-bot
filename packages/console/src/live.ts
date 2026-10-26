// Live updates over /console-api/ws with reconnect + backoff.

import type { ConsoleEvent } from "./types.ts";

export type LiveStatus = "connecting" | "open" | "closed";

export interface LiveOptions {
  onEvent: (e: ConsoleEvent) => void;
  onStatus: (s: LiveStatus) => void;
  /** Server refused the socket (no session): let the app re-check auth. */
  onUnauthorized: () => void;
  /** Called after a reconnect so pages can refetch what they may have missed. */
  onReconnect: () => void;
}

export function connectLive(opts: LiveOptions): () => void {
  let ws: WebSocket | undefined;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let everOpened = false;

  const open = () => {
    if (stopped) return;
    opts.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/console-api/ws`);
    ws.onopen = () => {
      if (everOpened) opts.onReconnect();
      everOpened = true;
      attempt = 0;
      opts.onStatus("open");
    };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(String(m.data)) as ConsoleEvent;
        if (e && typeof e.type === "string") opts.onEvent(e);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (ev) => {
      ws = undefined;
      if (stopped) return;
      opts.onStatus("closed");
      if (ev.code === 4401) {
        opts.onUnauthorized();
        return;
      }
      attempt++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5);
      timer = setTimeout(open, delay);
    };
  };

  const onOnline = () => {
    if (!ws && !stopped) {
      clearTimeout(timer);
      open();
    }
  };
  window.addEventListener("online", onOnline);
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener("online", onOnline);
    ws?.close();
  };
}
