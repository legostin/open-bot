// The browser's history: every page a tab landed on (the person's and the agents'), kept in one JSON file in the
// plugin's data folder. Small enough to search in memory; written a moment after each change.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginHttpRequest, PluginHttpResponse } from "@owlbot/plugin-sdk";

export interface Visit {
  id: string;
  url: string;
  title: string;
  /** When the tab landed on the page (ms). */
  at: number;
  /** "user", or the id of the agent that drove the browser. */
  by: string;
  /** The site's icon (an http(s) URL). */
  icon?: string;
}

/** A tile of the new tab page: a site people open often. */
export interface Site {
  url: string;
  title: string;
  icon?: string;
  visits: number;
}

export interface HistoryOptions {
  file: string;
  maxAgeDays?: number;
  maxVisits?: number;
  /** 0 writes at once (tests). */
  writeDelayMs?: number;
  now?: () => number;
}

const DAY = 86_400_000;
/** A page that changes its own address this soon after it opened (a canonical URL, a redirect in script) is the same visit. */
const SETTLE_MS = 4000;

function decoded(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const words = (q: string | undefined) => (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
const haystack = (v: Visit) => `${v.title} ${decoded(v.url)}`.toLowerCase();

export class HistoryStore {
  private visits: Visit[] = [];
  /** The page each tab is on: landing there again (a reload, a redirect back) is the same visit. */
  private current = new Map<string, Visit>();
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly file: string;
  private readonly maxAge: number;
  private readonly maxVisits: number;
  private readonly writeDelay: number;
  private readonly now: () => number;

  constructor(opts: HistoryOptions) {
    this.file = opts.file;
    this.maxAge = (opts.maxAgeDays ?? 90) * DAY;
    this.maxVisits = opts.maxVisits ?? 10_000;
    this.writeDelay = opts.writeDelayMs ?? 1000;
    this.now = opts.now ?? Date.now;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(data?.visits)) this.visits = data.visits.filter((v: Visit) => v && typeof v.url === "string" && typeof v.at === "number");
    } catch {
      /* no history yet */
    }
    this.prune();
  }

  /**
   * A tab landed on a page. Only http(s) pages are kept; the same page again in the same tab is not a new visit, nor
   * is a page that only rewrote its address (`sameDocument`) right after it opened.
   */
  record(v: { url: string; title?: string; by: string; tab: string; icon?: string; sameDocument?: boolean }): Visit | null {
    if (!/^https?:\/\//i.test(v.url)) return null;
    const last = this.current.get(v.tab);
    const settling = !!v.sameDocument && !!last && this.now() - last.at < SETTLE_MS;
    if (last && (last.url === v.url || settling) && this.visits.includes(last)) {
      last.url = v.url;
      if (v.title) last.title = v.title;
      if (v.icon) last.icon = v.icon;
      this.changed();
      return last;
    }
    const at = this.now();
    const visit: Visit = { id: `${at.toString(36)}${(this.seq++).toString(36)}`, url: v.url, title: v.title ?? "", at, by: v.by, ...(v.icon ? { icon: v.icon } : {}) };
    this.visits.push(visit);
    this.current.set(v.tab, visit);
    this.prune();
    this.changed();
    return visit;
  }

  /** The title (or icon) came after the page: it goes to the newest visit of that page. */
  setTitle(url: string, title: string): void {
    const v = this.newest(url);
    if (!v || !title || v.title === title) return;
    v.title = title;
    this.changed();
  }

  setIcon(url: string, icon: string): void {
    const v = this.newest(url);
    if (!v || !icon || v.icon === icon) return;
    v.icon = icon;
    this.changed();
  }

  /**
   * Visits whose title or address has every word of `q`, newest first; `before` (ms) continues a list, `since` (ms)
   * stops it.
   */
  search(opts: { q?: string; before?: number; since?: number; limit?: number }): { visits: Visit[]; more: boolean } {
    const w = words(opts.q);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const out: Visit[] = [];
    for (let i = this.visits.length - 1; i >= 0; i--) {
      const v = this.visits[i];
      if (opts.since !== undefined && v.at < opts.since) break;
      if (opts.before !== undefined && v.at >= opts.before) continue;
      if (w.length && !w.every((x) => haystack(v).includes(x))) continue;
      if (out.length === limit) return { visits: out, more: true };
      out.push(v);
    }
    return { visits: out, more: false };
  }

  /**
   * Pages for the address bar's suggestions, one per address: a site whose name starts with what is typed first,
   * then the pages opened most often, then the newest.
   */
  suggest(q: string, limit = 6): Visit[] {
    const w = words(q);
    if (!w.length) return [];
    const head = w[0];
    const byUrl = new Map<string, { v: Visit; count: number; host: boolean }>();
    for (const v of this.visits) {
      if (!w.every((x) => haystack(v).includes(x))) continue;
      const seen = byUrl.get(v.url);
      if (seen) {
        seen.count++;
        if (v.at >= seen.v.at) seen.v = { ...v, title: v.title || seen.v.title, icon: v.icon ?? seen.v.icon };
        continue;
      }
      byUrl.set(v.url, { v, count: 1, host: hostOf(v.url).toLowerCase().split(".").some((label) => label.startsWith(head)) });
    }
    return [...byUrl.values()]
      .sort((a, b) => Number(b.host) - Number(a.host) || b.count - a.count || b.v.at - a.v.at)
      .slice(0, limit)
      .map((x) => x.v);
  }

  /** The sites opened most in the last 30 days, one tile per site (its home page). */
  top(limit = 8): Site[] {
    const since = this.now() - 30 * DAY;
    const sites = new Map<string, Site & { last: number }>();
    for (const v of this.visits) {
      if (v.at < since) continue;
      let origin: URL;
      try {
        origin = new URL(v.url);
      } catch {
        continue;
      }
      const s = sites.get(origin.origin) ?? { url: `${origin.origin}/`, title: origin.host.replace(/^www\./, ""), visits: 0, last: 0 };
      s.visits++;
      s.last = Math.max(s.last, v.at);
      if (origin.pathname === "/" && !origin.search && v.title) s.title = v.title;
      if (v.icon) s.icon = v.icon;
      sites.set(origin.origin, s);
    }
    return [...sites.values()]
      .sort((a, b) => b.visits - a.visits || b.last - a.last)
      .slice(0, limit)
      .map(({ last: _, ...s }) => s);
  }

  remove(id: string): boolean {
    const i = this.visits.findIndex((v) => v.id === id);
    if (i < 0) return false;
    this.visits.splice(i, 1);
    this.changed();
    return true;
  }

  /** Delete every visit, or those matching `q` and newer than `since` (ms). Returns how many went. */
  clear(filter: { q?: string; since?: number } = {}): number {
    const w = words(filter.q);
    const keep = this.visits.filter((v) => (filter.since !== undefined && v.at < filter.since) || (w.length > 0 && !w.every((x) => haystack(v).includes(x))));
    const n = this.visits.length - keep.length;
    this.visits = keep;
    if (n) this.changed();
    return n;
  }

  /** Write a pending change now (before the plugin stops). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, visits: this.visits }));
    renameSync(tmp, this.file);
  }

  private newest(url: string): Visit | undefined {
    for (let i = this.visits.length - 1; i >= 0; i--) if (this.visits[i].url === url) return this.visits[i];
    return undefined;
  }

  private prune(): void {
    const since = this.now() - this.maxAge;
    let drop = 0;
    while (drop < this.visits.length && this.visits[drop].at < since) drop++;
    drop = Math.max(drop, this.visits.length - this.maxVisits);
    if (drop > 0) {
      this.visits.splice(0, drop);
      this.dirty = true;
    }
  }

  private changed(): void {
    this.dirty = true;
    if (this.writeDelay === 0) return this.flush();
    this.timer ??= setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch {
        this.dirty = true;
      }
    }, this.writeDelay);
    this.timer.unref?.();
  }
}

/**
 * The live view's history routes (/api/plugins/browser/http/…): GET /history?q&before&limit, GET /suggest?q,
 * GET /top, DELETE /history?id (one visit) and DELETE /history (all of it).
 */
export function historyHttp(store: HistoryStore, req: PluginHttpRequest): PluginHttpResponse {
  if (req.public) return { status: 404 };
  const q = req.query ?? {};
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (req.method === "GET" && req.path === "/history") return { body: store.search({ q: q.q, before: num(q.before), limit: num(q.limit) }) };
  if (req.method === "GET" && req.path === "/suggest") return { body: { visits: store.suggest(q.q ?? "", num(q.limit) ?? 6) } };
  if (req.method === "GET" && req.path === "/top") return { body: { sites: store.top(num(q.limit) ?? 8) } };
  if (req.method === "DELETE" && req.path === "/history") {
    if (q.id) return { body: { removed: store.remove(q.id) ? 1 : 0 } };
    return { body: { removed: store.clear() } };
  }
  return { status: 404 };
}
