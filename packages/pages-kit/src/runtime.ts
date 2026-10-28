// What a page knows and can do. A page runs sandboxed at /p/<id>/<token>/ (no cookies, no storage of its own): the hub
// put its data into the HTML, and the page's own routes next to it serve pictures, map tiles, routes, allowed JSON
// APIs and the page's saved state. The chat it sits in hears it through postMessage: "ask" sends the person's words to
// the agent, "open" opens a link outside the page.
import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../shared/src/i18n.ts";

export interface PageInfo {
  id: string;
  title: string;
  data: unknown;
  locale: Locale;
  /** What the page saved with useStored, by key. */
  state: Record<string, unknown>;
  version: number;
}

let info: PageInfo = { id: "", title: "", data: {}, locale: "en", state: {}, version: 0 };

export function setPageInfo(next: PageInfo): void {
  info = next;
}

export function pageInfo(): PageInfo {
  return info;
}

const framed = (): boolean => {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
};

/** Tells the chat the page sits in; nothing happens when the page is open on its own. */
export function post(message: Record<string, unknown>): boolean {
  if (!framed()) return false;
  window.parent.postMessage({ owlbot: true, page: info.id, ...message }, "*");
  return true;
}

/** The data the agent gave the page (page_create / page_update). */
export function useData<T = any>(): T {
  return info.data as T;
}

/** Sends `text` to the agent as the person's message in the chat (and closes the page there). */
export function ask(text: string): boolean {
  return post({ type: "ask", text });
}

/** Opens a link outside the page: the chat opens it, or a new tab when the page is open on its own. */
export function openLink(url: string): void {
  if (!post({ type: "open", url })) window.open(url, "_blank", "noopener,noreferrer");
}

const EXTERNAL = /^https?:\/\//i;

/** An http(s) picture through the page's image route (the page loads nothing from other sites itself). */
export function proxied(src: string): string;
export function proxied(src: string | undefined): string | undefined;
export function proxied(src: string | undefined): string | undefined {
  return src && EXTERNAL.test(src) ? `img?url=${encodeURIComponent(src)}` : src;
}

/** JSON from an allowed API (Open-Meteo, Wikipedia, …) through the page's fetch route. */
export async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(`fetch?url=${encodeURIComponent(url)}`);
  const body = await r.text();
  if (!r.ok) {
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      /* plain text */
    }
    throw new Error(message || `HTTP ${r.status}`);
  }
  return JSON.parse(body) as T;
}

/** getJson as a hook: { data, error, loading }; a null url fetches nothing. */
export function useJson<T = any>(url: string | null | undefined): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: !!url });
  useEffect(() => {
    if (!url) return setState({ loading: false });
    let live = true;
    setState({ loading: true });
    getJson<T>(url).then(
      (data) => live && setState({ data, loading: false }),
      (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

const pending = new Map<string, unknown>();
let flush: ReturnType<typeof setTimeout> | undefined;

function save(key: string, value: unknown): void {
  pending.set(key, value);
  clearTimeout(flush);
  flush = setTimeout(() => {
    const changes = Object.fromEntries(pending);
    pending.clear();
    // text/plain keeps it a simple request: the page's origin is opaque, and there is no preflight to answer.
    void fetch("state", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(changes) }).catch(() => undefined);
  }, 400);
}

/** State that stays with the page for everyone who opens it (ticks on a checklist, a choice): like useState, saved on the hub. */
export function useStored<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (key in info.state ? (info.state[key] as T) : initial));
  const ref = useRef(value);
  ref.current = value;
  const set = (next: T | ((prev: T) => T)) => {
    const v = typeof next === "function" ? (next as (prev: T) => T)(ref.current) : next;
    ref.current = v;
    info.state[key] = v;
    setValue(v);
    save(key, v);
  };
  return [value, set];
}

const reported = new Set<string>();

/** A runtime error goes to the hub (page_read shows it to the agent) and to the chat. */
export function reportError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!reported.has(message)) {
    reported.add(message);
    const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 8).join("\n") : "";
    void fetch("error", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ message, stack }) }).catch(() => undefined);
    post({ type: "error", message });
  }
  return message;
}
