// What makes the app talk to the demo hub instead of a real one, installed before the app's modules run: `fetch` of
// this origin's /api/* goes to the hub in this page, and a WebSocket to /api/ws is the hub's DemoSocket. Everything else
// (the demo's own files) goes to the network as usual.

import { DemoSocket, type SocketPeer } from "./hub/socket";

export interface ApiPeer {
  handle(method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }>;
}

function isApi(url: URL): boolean {
  return url.origin === location.origin && url.pathname.startsWith("/api/");
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (raw == null) return undefined;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function installShims(api: ApiPeer, sockets: SocketPeer): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (!isApi(url)) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const res = await api.handle(method, url, await readBody(input, init));
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };

  // Sign-in pages of services open nowhere in the demo (the hub answers a .invalid address for them).
  const realOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    if (url && /^https:\/\/[^/]*\.invalid\//.test(String(url))) return null;
    return realOpen(url, target, features);
  };

  const RealWebSocket = window.WebSocket;
  const Shim = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const u = new URL(String(url), location.href);
    if (u.pathname === "/api/ws") return new DemoSocket(u.href, sockets);
    return new RealWebSocket(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Shim;
}
