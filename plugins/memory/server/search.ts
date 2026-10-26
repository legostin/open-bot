// Full-text index over active facts: SQLite FTS5 (node:sqlite) with a substring-search fallback.

import { DatabaseSync } from "node:sqlite";
import type { Fact } from "./store.ts";

export interface SearchHit {
  path: string;
  title: string;
  tags: string[];
  snippet: string;
}

export interface SearchIndex {
  readonly mode: "fts5" | "substring";
  rebuild(facts: Iterable<Fact>): void;
  upsert(f: Fact): void;
  remove(path: string): void;
  search(query: string, limit: number): SearchHit[];
  close(): void;
}

export function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16);
}

class FtsIndex implements SearchIndex {
  readonly mode = "fts5" as const;
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("drop table if exists memory_fts");
    this.db.exec("create virtual table memory_fts using fts5(path, title, tags, body, tokenize = 'unicode61 remove_diacritics 2')");
  }

  rebuild(facts: Iterable<Fact>): void {
    this.db.exec("begin");
    try {
      this.db.exec("delete from memory_fts");
      const ins = this.db.prepare("insert into memory_fts(path, title, tags, body) values (?, ?, ?, ?)");
      for (const f of facts) ins.run(f.path, f.title, f.tags.join(", "), f.body);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  upsert(f: Fact): void {
    this.remove(f.path);
    this.db.prepare("insert into memory_fts(path, title, tags, body) values (?, ?, ?, ?)").run(f.path, f.title, f.tags.join(", "), f.body);
  }

  remove(path: string): void {
    this.db.prepare("delete from memory_fts where path = ?").run(path);
  }

  search(query: string, limit: number): SearchHit[] {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const stmt = this.db.prepare(
      "select path, title, tags, snippet(memory_fts, -1, '**', '**', '…', 24) as snip from memory_fts where memory_fts match ? order by bm25(memory_fts, 2.0, 6.0, 3.0, 1.0) limit ?",
    );
    const run = (q: string) => stmt.all(q, limit) as Array<{ path: string; title: string; tags: string; snip: string }>;
    const terms = tokens.map((t) => `"${t}"*`);
    let rows = run(terms.join(" "));
    if (!rows.length && terms.length > 1) rows = run(terms.join(" OR "));
    return rows.map((r) => ({ path: r.path, title: r.title, tags: r.tags ? r.tags.split(", ") : [], snippet: r.snip.replace(/\s+/g, " ").trim() }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** In-memory scan for platforms without FTS5. */
export class SubstringIndex implements SearchIndex {
  readonly mode = "substring" as const;
  private docs = new Map<string, Fact>();

  rebuild(facts: Iterable<Fact>): void {
    this.docs.clear();
    for (const f of facts) this.docs.set(f.path, f);
  }

  upsert(f: Fact): void {
    this.docs.set(f.path, f);
  }

  remove(path: string): void {
    this.docs.delete(path);
  }

  search(query: string, limit: number): SearchHit[] {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const count = (hay: string, t: string) => hay.split(t).length - 1;
    const score = (f: Fact, any: boolean) => {
      const fields = { path: f.path.toLowerCase(), title: f.title.toLowerCase(), tags: f.tags.join(" ").toLowerCase(), body: f.body.toLowerCase() };
      let s = 0;
      let matched = 0;
      for (const t of tokens) {
        const ts = count(fields.title, t) * 6 + count(fields.tags, t) * 3 + count(fields.path, t) * 2 + count(fields.body, t);
        if (ts) matched++;
        s += ts;
      }
      return (any ? matched > 0 : matched === tokens.length) ? s : 0;
    };
    const rank = (any: boolean) =>
      [...this.docs.values()]
        .map((f) => ({ f, s: score(f, any) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit);
    let ranked = rank(false);
    if (!ranked.length && tokens.length > 1) ranked = rank(true);
    return ranked.map(({ f }) => ({ path: f.path, title: f.title, tags: f.tags, snippet: this.snippet(f.body, tokens) }));
  }

  private snippet(body: string, tokens: string[]): string {
    const flat = body.replace(/\s+/g, " ").trim();
    const lower = flat.toLowerCase();
    const pos = Math.min(...tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
    if (!Number.isFinite(pos)) return flat.slice(0, 160) + (flat.length > 160 ? "…" : "");
    const start = Math.max(0, pos - 60);
    const end = Math.min(flat.length, pos + 120);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  }

  close(): void {}
}

/** FTS5 index in `file`, or the substring fallback when SQLite/FTS5 is unavailable. */
export function openIndex(file: string, opts: { forceSubstring?: boolean; onFallback?: (reason: string) => void } = {}): SearchIndex {
  if (opts.forceSubstring) return new SubstringIndex();
  try {
    return new FtsIndex(file);
  } catch (e: any) {
    opts.onFallback?.(e?.message ?? String(e));
    return new SubstringIndex();
  }
}
