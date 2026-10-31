// The demo hub's route table: the requests the web UI makes, matched by method and path pattern ("/api/x/:id"), each
// answered from the demo world. What it does not know answers 404 and is reported, so the site's checks catch an app
// change the demo has not caught up with.

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteInput {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

export type Handler = (input: RouteInput) => unknown;

/** An answer other than 200: the UI shows `message` as the hub's words. */
export class DemoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Route {
  method: Method;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  private unknown: (method: string, path: string) => void;

  constructor(unknown: (method: string, path: string) => void = (m, p) => console.warn(`[demo] unknown route ${m} ${p}`)) {
    this.unknown = unknown;
  }

  route(method: Method, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split("/"), handler });
  }

  async handle(method: string, url: URL, body?: unknown): Promise<{ status: number; body: unknown }> {
    const parts = url.pathname.split("/");
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const hit = r.parts.every((p, i) => {
        if (p.startsWith(":")) {
          params[p.slice(1)] = decodeURIComponent(parts[i]);
          return parts[i] !== "";
        }
        return p === parts[i];
      });
      if (!hit) continue;
      try {
        const out = await r.handler({ params, query: url.searchParams, body: body ?? {} });
        return { status: 200, body: out ?? {} };
      } catch (e) {
        if (e instanceof DemoError) return { status: e.status, body: { error: e.message } };
        console.error("[demo] route failed", method, url.pathname, e);
        return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    this.unknown(method, url.pathname);
    return { status: 404, body: { error: "not found" } };
  }
}
