// The demo's service worker: what the app loads without fetch (pictures in messages and posts, map tiles) comes from
// the demo's own files instead of a hub. It holds no state and reaches nothing outside the site:
//   /api/files?path=P                      → <demo>/files/P
//   /api/media?url=https://media.demo.invalid/P → <demo>/media/P
//   /api/map/tiles/z/x/y.png               → <demo>/tiles/z/x/y.png
//   /api/integrations/<id>/logo            → <demo>/logos/<id>.png
// Built on its own (no imports) into demo-sw.js next to demo.html.

// The web app's type checker knows the DOM, not workers: the little of the worker scope used here.
interface FetchEventLike {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
const sw = self as unknown as {
  registration: { scope: string };
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", cb: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(type: "fetch", cb: (e: FetchEventLike) => void): void;
};

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

function target(url: URL): string | undefined {
  const base = sw.registration.scope;
  if (url.pathname === "/api/files") {
    const p = url.searchParams.get("path");
    return p ? new URL(`files/${p.replace(/^\/+/, "")}`, base).href : undefined;
  }
  if (url.pathname === "/api/media") {
    const src = url.searchParams.get("url") ?? "";
    const m = /^https:\/\/media\.demo\.invalid\/(.+)$/.exec(src);
    return m ? new URL(`media/${m[1]}`, base).href : undefined;
  }
  const logo = /^\/api\/integrations\/([a-z0-9-]+)\/logo$/.exec(url.pathname);
  if (logo) return new URL(`logos/${logo[1]}.png`, base).href;
  const tile = /^\/api\/map\/tiles\/(\d+\/\d+\/\d+\.png)$/.exec(url.pathname);
  if (tile) return new URL(`tiles/${tile[1]}`, base).href;
  return undefined;
}

sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== sw.location.origin || !url.pathname.startsWith("/api/")) return;
  const to = target(url);
  e.respondWith(to ? fetch(to) : new Response("", { status: 404 }));
});

export {};
