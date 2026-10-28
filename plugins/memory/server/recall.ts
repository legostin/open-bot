// Hybrid recall: which facts matter for a piece of text. Score = relevance (lexical stems weighted by rarity, entity
// mentions) gated by a minimum, then importance, recency, confidence and how often the fact proved useful.
// No embeddings needed; `Embedder` is the seam for a local model later (its similarity joins `relevance`).

import { haystack, stem, stems, words } from "./text.ts";
import { isCurrent, PROFILE_FILE, visibleTo, type Fact, type FactKind } from "./store.ts";

export interface Embedder {
  /** Cosine similarity of the text with each fact (0..1), or undefined when the model is not ready. */
  similarity(text: string, facts: Fact[]): Promise<number[] | undefined>;
}

export interface Usage {
  recalled: number;
  lastRecalled: string;
}

export interface Scored {
  fact: Fact;
  score: number;
  relevance: number;
  lexical: number;
  entity: number;
}

export interface RecallOptions {
  agentId?: string;
  /** Include archived and expired facts (search only). */
  includeArchived?: boolean;
  kinds?: FactKind[];
  limit?: number;
  /** Minimum relevance (0..1) for a fact to count at all. */
  gate?: number;
  usage?: (path: string) => Usage | undefined;
  now?: number;
}

const DAY = 86_400_000;

/** Lowercased searchable text of a fact, cached per object. */
const hay = new WeakMap<Fact, string>();
function factHay(f: Fact): string {
  let h = hay.get(f);
  if (!h) {
    h = haystack(`${f.title} ${f.about.join(" ")} ${f.tags.join(" ")} ${f.slot} ${f.body}`);
    hay.set(f, h);
  }
  return h;
}

/** Entities of a fact mentioned in the text (word stems, so "Анну" finds "Анна"). */
export function entityMatch(f: Fact, textHay: string): number {
  if (!f.about.length) return 0;
  let hit = 0;
  for (const e of f.about) {
    const ws = words(e).map(stem).filter((w) => w.length >= 2);
    if (ws.length && ws.every((w) => textHay.includes(` ${w}`))) hit++;
  }
  return hit ? Math.min(1, 0.65 + (0.35 * hit) / f.about.length) : 0;
}

/** Rank facts for a text. */
export function rank(facts: Iterable<Fact>, text: string, o: RecallOptions = {}): Scored[] {
  const now = o.now ?? Date.now();
  const pool = [...facts].filter((f) => (o.includeArchived ? f.status !== "review" : isCurrent(f, now)) && visibleTo(f, o.agentId) && (!o.kinds || o.kinds.includes(f.kind)));
  const query = stems(text);
  const textHay = haystack(text);
  if (!pool.length || (!query.length && !textHay.trim())) return [];
  // Rarer words say more: inverse document frequency over the pool.
  const df = new Map<string, number>();
  for (const q of query) {
    let n = 0;
    for (const f of pool) if (factHay(f).includes(` ${q}`)) n++;
    df.set(q, n);
  }
  const idf = (q: string) => Math.log(1 + (pool.length + 1) / ((df.get(q) ?? 0) + 0.5));
  const totalIdf = query.reduce((n, q) => n + idf(q), 0) || 1;
  const out: Scored[] = [];
  for (const f of pool) {
    const h = factHay(f);
    let matched = 0;
    for (const q of query) if ((df.get(q) ?? 0) > 0 && h.includes(` ${q}`)) matched += idf(q);
    // All of a short query, or a few rare words of a long message.
    const lexical = Math.max(0.9 * (matched / totalIdf), 1 - Math.exp(-matched / 5));
    const entity = entityMatch(f, textHay);
    const relevance = Math.min(1, Math.max(lexical, entity) + 0.15 * Math.min(lexical, entity));
    if (relevance < (o.gate ?? 0.3)) continue;
    const age = (now - (Date.parse(f.updated || f.created) || now)) / DAY;
    const recency = Math.exp(-Math.max(0, age) / 120);
    const u = o.usage?.(f.path);
    const useful = u ? Math.min(1, u.recalled / 10) : 0;
    const importance = (f.importance - 1) / 4;
    const score = 0.55 * relevance + 0.2 * importance + 0.1 * recency + 0.1 * f.confidence + 0.05 * useful;
    out.push({ fact: f, score, relevance, lexical, entity });
  }
  return out.sort((a, b) => b.score - a.score || b.fact.updated.localeCompare(a.fact.updated)).slice(0, o.limit ?? 20);
}

/** Facts without a query: most important, then newest. */
export function strongest(facts: Iterable<Fact>, o: { agentId?: string; kinds?: FactKind[]; minImportance?: number } = {}): Fact[] {
  return [...facts]
    .filter((f) => isCurrent(f) && visibleTo(f, o.agentId) && (!o.kinds || o.kinds.includes(f.kind)) && f.importance >= (o.minImportance ?? 1))
    .sort((a, b) => b.importance - a.importance || b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
}

/** One fact as a line for the model: "(person: Anna) The user's sister Anna lives in Perm. [people/anna.md]". */
export function factLine(f: Fact, maxBody = 400): string {
  const flat = f.body.replace(/\s+/g, " ").trim();
  const text = flat ? (flat.length > maxBody ? `${flat.slice(0, maxBody - 1)}…` : flat) : f.title;
  const head = flat && !flat.toLowerCase().includes(f.title.toLowerCase().slice(0, 30)) && f.path !== PROFILE_FILE ? `${f.title}: ` : "";
  const label = [f.kind === "self" ? "about the user" : f.kind, f.about.slice(0, 3).join(", ")].filter(Boolean).join(": ");
  const when = [f.validFrom ? `since ${f.validFrom.slice(0, 10)}` : "", f.validUntil ? `until ${f.validUntil.slice(0, 10)}` : ""].filter(Boolean).join(", ");
  const own = f.scope !== "team" ? ", only you" : "";
  return `- (${label}${when ? `, ${when}` : ""}${own}) ${head}${text} [${f.path}]`;
}

/** Lines within a character budget, best first. */
export function within(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget) continue;
    out.push(l);
    used += l.length + 1;
  }
  return out;
}
