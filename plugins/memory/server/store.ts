// Memory files on disk: one fact per markdown file with YAML frontmatter.
// Active and archived facts live in the memory root. Facts an earlier version held for the user's yes wait in .pending/<path>
// (not in git: a fact the user declines never reaches the history); earlier versions kept such facts in .review/<path>
// or as status: review in place. Forgotten facts go to .trash/<path> (not in git: the deletion is the commit), from
// where Undo brings them back.
//
// Schema v2 (see docs/superpowers/specs/2026-10-29-memory-design.md) adds kind, entities, slot, importance, confidence,
// validity dates, supersession, scope, sensitivity and provenance. Every new field is optional: v1 files load as they
// are (fields derived from the folder and title) and get the new fields when they are next saved. Frontmatter keys this
// version does not know are kept.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { stringify } from "yaml";
import { parseFrontmatter } from "@owlbot/shared";
import { dirOf, normalizePath, PathError } from "./paths.ts";

export type FactStatus = "active" | "review" | "archived";
export const KINDS = ["self", "preference", "person", "place", "project", "event", "howto", "note"] as const;
export type FactKind = (typeof KINDS)[number];

/** Folder of new facts by kind. */
export const KIND_FOLDER: Record<FactKind, string> = {
  self: "you",
  preference: "preferences",
  person: "people",
  place: "places",
  project: "projects",
  event: "timeline",
  howto: "howto",
  note: "notes",
};
const FOLDER_KIND: Record<string, FactKind> = { ...Object.fromEntries(Object.entries(KIND_FOLDER).map(([k, f]) => [f, k as FactKind])), events: "event", profile: "self" };

/** Where a fact came from: the agent (or "user" for the person's own edits), the conversation, and their words. */
export interface Source {
  agent: string;
  conversation?: string;
  session?: string;
  at: string;
  quote?: string;
}

export interface Fact {
  path: string;
  title: string;
  kind: FactKind;
  /** Entities the fact mentions: people, places, projects, by name. */
  about: string[];
  /** A changeable attribute ("home city"): a newer fact with the same subject and slot supersedes this one. */
  slot: string;
  tags: string[];
  /** 1..5 */
  importance: number;
  /** 0..1 */
  confidence: number;
  validFrom: string;
  validUntil: string;
  supersededBy: string;
  supersedes: string[];
  /** "team" or "agent:<id>" (only that agent sees it). */
  scope: string;
  sensitive: boolean;
  created: string;
  updated: string;
  /** v1 provenance ("agent/session" or "user"), kept as written. */
  source: string;
  sources: Source[];
  status: FactStatus;
  body: string;
  /** Frontmatter keys this version does not know, written back unchanged. */
  extra: Record<string, unknown>;
}

export interface ReviewItem extends Fact {
  /** True when an active-tree file itself carries status: review; false for .pending/ and .review/ copies. */
  inPlace: boolean;
  /** Where a copy waits: .pending/ (new, outside git) or .review/ (v1). */
  area?: "pending" | "review";
}

export const INDEX_FILE = "MEMORY.md";
export const PROFILE_FILE = "profile.md";
export const DEFAULT_FOLDERS = ["people", "projects", "notes"];
const REVIEW_DIR = ".review";
const PENDING_DIR = ".pending";
const TRASH_DIR = ".trash";
/** Kept out of git: the trash (the deletion is the commit) and facts not approved yet. */
const IGNORED = [`${TRASH_DIR}/`, `${PENDING_DIR}/`, ".tmp-*"];

const KNOWN_KEYS = new Set([
  "title",
  "kind",
  "about",
  "slot",
  "tags",
  "importance",
  "confidence",
  "valid_from",
  "valid_until",
  "superseded_by",
  "supersedes",
  "scope",
  "sensitive",
  "created",
  "updated",
  "source",
  "sources",
  "status",
]);

function str(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v === undefined || v === null ? "" : String(v);
}

function list(v: unknown, max = 20, len = 80): string[] {
  const items = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).flatMap((t) => String(t ?? "").split(","));
  const out: string[] = [];
  for (const t of items) {
    const s = String(t ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, len);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, max);
}

export function normalizeTags(v: unknown): string[] {
  // Commas separate tags everywhere (the search index stores them comma-joined).
  return list(v, 20, 50);
}

export function normalizeEntities(v: unknown): string[] {
  return list(v, 12, 80);
}

export function isKind(v: unknown): v is FactKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/** Kind of a v1 file, from its folder ("people/anna.md" → person); profile.md → self. */
export function kindOfPath(path: string): FactKind {
  if (path === PROFILE_FILE) return "self";
  const top = path.includes("/") ? path.split("/")[0].toLowerCase() : "";
  return FOLDER_KIND[top] ?? "note";
}

export function clampImportance(v: unknown, fallback = 3): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : fallback;
}

function clampConfidence(v: unknown, fallback = 1): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 100) / 100)) : fallback;
}

function titleFromBody(path: string, body: string): string {
  const h = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (h) return h;
  const base = path.split("/").pop()!.replace(/\.md$/, "");
  return base.replace(/[-_]+/g, " ");
}

/** "Анна — сестра" in people/ → ["Анна"]: v1 person, place and project files are about the name in their title. */
export function entitiesFromTitle(kind: FactKind, title: string): string[] {
  if (kind !== "person" && kind !== "place" && kind !== "project") return [];
  const name = title.split(/\s+[—–-]\s+|:\s/)[0]?.trim();
  return name && name.length <= 60 ? [name] : [];
}

function parseSources(v: unknown): Source[] {
  if (!Array.isArray(v)) return [];
  const out: Source[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const agent = str(o.agent).trim();
    if (!agent) continue;
    const src: Source = { agent, at: str(o.at) };
    if (str(o.conversation)) src.conversation = str(o.conversation);
    if (str(o.session)) src.session = str(o.session);
    if (str(o.quote)) src.quote = str(o.quote).slice(0, 300);
    out.push(src);
  }
  return out.slice(-20);
}

/** A v1 "agent/session" source string as provenance. */
function legacySource(source: string, at: string): Source[] {
  if (!source) return [];
  if (source === "user") return [{ agent: "user", at }];
  const [agent, session] = source.split("/");
  return agent ? [{ agent, ...(session ? { session } : {}), at }] : [];
}

/** Parse a fact file (frontmatter optional, invalid YAML tolerated). */
export function parseFact(path: string, text: string): Fact {
  let data: Record<string, any> = {};
  let body = text;
  try {
    ({ data, body } = parseFrontmatter(text));
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  } catch {
    /* invalid YAML: treat the whole file as body */
  }
  const rawStatus = str(data.status).toLowerCase();
  const status: FactStatus = rawStatus === "review" ? "review" : rawStatus === "archived" ? "archived" : "active";
  const kind = isKind(data.kind) ? data.kind : kindOfPath(path);
  const title = str(data.title).replace(/\s+/g, " ").trim() || titleFromBody(path, body);
  const created = str(data.created);
  const updated = str(data.updated);
  const source = str(data.source);
  const sources = parseSources(data.sources);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  return {
    path,
    title,
    kind,
    about: data.about !== undefined ? normalizeEntities(data.about) : entitiesFromTitle(kind, title),
    slot: str(data.slot).replace(/\s+/g, " ").trim().slice(0, 60),
    tags: normalizeTags(data.tags),
    importance: clampImportance(data.importance, path === PROFILE_FILE ? 5 : 3),
    confidence: clampConfidence(data.confidence, 1),
    validFrom: str(data.valid_from),
    validUntil: str(data.valid_until),
    supersededBy: str(data.superseded_by),
    supersedes: list(data.supersedes, 20, 200),
    scope: /^agent:[\w.-]+$/.test(str(data.scope)) ? str(data.scope) : "team",
    sensitive: data.sensitive === true || str(data.sensitive) === "true",
    created,
    updated,
    source,
    sources: sources.length ? sources : legacySource(source, updated || created),
    status,
    body: body.replace(/^\s*\n/, "").trimEnd(),
    extra,
  };
}

const y = (v: unknown) => stringify(v, { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trimEnd();

export function serializeFact(f: Fact): string {
  const lines = [`title: ${y(f.title)}`, `kind: ${f.kind}`];
  if (f.about.length) lines.push(`about: ${y(f.about)}`);
  if (f.slot) lines.push(`slot: ${y(f.slot)}`);
  lines.push(`tags: ${y(f.tags)}`, `importance: ${f.importance}`);
  if (f.confidence !== 1) lines.push(`confidence: ${f.confidence}`);
  if (f.validFrom) lines.push(`valid_from: ${y(f.validFrom)}`);
  if (f.validUntil) lines.push(`valid_until: ${y(f.validUntil)}`);
  if (f.supersededBy) lines.push(`superseded_by: ${y(f.supersededBy)}`);
  if (f.supersedes.length) lines.push(`supersedes: ${y(f.supersedes)}`);
  if (f.scope && f.scope !== "team") lines.push(`scope: ${y(f.scope)}`);
  if (f.sensitive) lines.push("sensitive: true");
  lines.push(`created: ${y(f.created)}`, `updated: ${y(f.updated)}`, `source: ${y(f.source)}`);
  if (f.sources.length) lines.push(`sources: ${y(f.sources)}`);
  lines.push(`status: ${f.status}`);
  for (const [k, v] of Object.entries(f.extra ?? {})) {
    try {
      lines.push(`${/^[\w-]+$/.test(k) ? k : y(k)}: ${y(v)}`);
    } catch {
      /* a value YAML cannot write back is dropped rather than corrupting the file */
    }
  }
  return `---\n${lines.join("\n")}\n---\n\n${f.body.trim()}\n`;
}

/** Strip a leading frontmatter block from model-provided content. */
export function stripFrontmatter(content: string): string {
  if (!/^---\r?\n/.test(content)) return content;
  try {
    return parseFrontmatter(content).body;
  } catch {
    return content;
  }
}

/** A fact with defaults for everything but what is given. */
export function newFact(p: Partial<Fact> & Pick<Fact, "path" | "title" | "body">): Fact {
  const now = new Date().toISOString();
  return {
    kind: kindOfPath(p.path),
    about: [],
    slot: "",
    tags: [],
    importance: 3,
    confidence: 1,
    validFrom: "",
    validUntil: "",
    supersededBy: "",
    supersedes: [],
    scope: "team",
    sensitive: false,
    created: now,
    updated: now,
    source: "",
    sources: [],
    status: "active",
    extra: {},
    ...p,
  };
}

/** Is the fact true now (not archived, not past its end)? */
export function isCurrent(f: Fact, now = Date.now()): boolean {
  if (f.status !== "active") return false;
  if (!f.validUntil) return true;
  const t = Date.parse(f.validUntil.length === 10 ? `${f.validUntil}T23:59:59` : f.validUntil);
  return !Number.isFinite(t) || t > now;
}

/** Can this agent see the fact? Team facts are everyone's; "agent:<id>" ones only that agent's. */
export function visibleTo(f: Fact, agentId?: string): boolean {
  return f.scope === "team" || !agentId || f.scope === `agent:${agentId}`;
}

export class MemoryStore {
  root: string;
  /** Active and archived facts. */
  facts = new Map<string, Fact>();
  review = new Map<string, ReviewItem>();

  constructor(root: string) {
    this.root = root;
  }

  /** Absolute path of a fact (validated). `area` → its .review/ or .trash/ copy. */
  abs(path: string, area: "" | "review" | "pending" | "trash" | boolean = ""): string {
    const p = normalizePath(path);
    const dir = area === "review" || area === true ? REVIEW_DIR : area === "pending" ? PENDING_DIR : area === "trash" ? TRASH_DIR : "";
    const abs = dir ? join(this.root, dir, ...p.split("/")) : join(this.root, ...p.split("/"));
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new PathError("outsideRoot", `Path is outside the memory folder: ${path}`, { path });
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new PathError("symlink", `Symbolic links are not supported: ${path}`, { path });
    return abs;
  }

  init(): void {
    mkdirSync(this.root, { recursive: true });
    for (const d of DEFAULT_FOLDERS) mkdirSync(join(this.root, d), { recursive: true });
    // Forgotten facts stay out of git: the deletion is the commit, the trash is for Undo.
    const ignore = join(this.root, ".gitignore");
    const had = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
    const missing = IGNORED.filter((l) => !had.split(/\r?\n/).includes(l));
    if (missing.length) writeFileSync(ignore, `${had}${had && !had.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
    this.scan();
  }

  /** (Re)load every fact from disk. */
  scan(): void {
    this.facts.clear();
    this.review.clear();
    for (const path of this.walk(this.root, "")) {
      if (path === INDEX_FILE) continue;
      const f = this.load(path, "");
      if (!f) continue;
      if (f.status === "review") this.review.set(path, { ...f, inPlace: true });
      else this.facts.set(path, f);
    }
    for (const area of ["review", "pending"] as const) {
      const dir = join(this.root, area === "review" ? REVIEW_DIR : PENDING_DIR);
      if (!existsSync(dir)) continue;
      for (const path of this.walk(dir, "")) {
        const f = this.load(path, area);
        if (f) this.review.set(path, { ...f, status: "review", inPlace: false, area });
      }
    }
  }

  private walk(dir: string, prefix: string): string[] {
    const out: string[] = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.walk(join(dir, e.name), rel));
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          out.push(normalizePath(rel));
        } catch {
          /* names we would not accept from tools are ignored */
        }
      }
    }
    return out;
  }

  private load(path: string, area: "" | "review" | "pending" | "trash"): Fact | undefined {
    try {
      return parseFact(path, readFileSync(this.abs(path, area), "utf8"));
    } catch {
      return undefined;
    }
  }

  private writeFile(abs: string, content: string): void {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.tmp-${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, abs);
  }

  /** Write an active or archived fact. */
  put(f: Fact): void {
    const fact: Fact = { ...f, status: f.status === "archived" ? "archived" : "active" };
    this.writeFile(this.abs(fact.path), serializeFact(fact));
    this.facts.set(fact.path, fact);
    const r = this.review.get(fact.path);
    if (r?.inPlace) this.review.delete(fact.path);
  }

  /** Write a fact that waits for the user's yes, in .pending/ (outside git until they approve). */
  putReview(f: Fact): void {
    const fact: Fact = { ...f, status: "review" };
    this.writeFile(this.abs(fact.path, "pending"), serializeFact(fact));
    this.review.set(fact.path, { ...fact, inPlace: false, area: "pending" });
  }

  removeActive(path: string): boolean {
    const abs = this.abs(path);
    const had = this.facts.delete(path);
    const r = this.review.get(path);
    if (r?.inPlace) this.review.delete(path);
    if (existsSync(abs)) {
      rmSync(abs);
      return true;
    }
    return had;
  }

  removeReview(path: string): boolean {
    const r = this.review.get(path);
    if (!r) return false;
    this.review.delete(path);
    const abs = this.abs(path, r.inPlace ? "" : (r.area ?? "review"));
    if (existsSync(abs)) rmSync(abs);
    return true;
  }

  /** Move a fact file (active, archived or in-place review) into the trash. */
  trash(path: string): Fact | undefined {
    const abs = this.abs(path);
    const fact = this.facts.get(path) ?? this.review.get(path);
    if (!existsSync(abs)) {
      this.facts.delete(path);
      return undefined;
    }
    const to = this.abs(path, "trash");
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) rmSync(to);
    renameSync(abs, to);
    this.facts.delete(path);
    const r = this.review.get(path);
    if (r?.inPlace) this.review.delete(path);
    return fact;
  }

  /** Bring a fact back from the trash; undefined when it is not there or its path is taken again. */
  untrash(path: string): Fact | undefined {
    const from = this.abs(path, "trash");
    const to = this.abs(path);
    if (!existsSync(from) || existsSync(to)) return undefined;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    const f = this.load(path, "");
    if (!f) return undefined;
    if (f.status === "review") this.review.set(path, { ...f, inPlace: true });
    else this.facts.set(path, f);
    return f;
  }

  /** Facts in the trash, newest first, with when they were forgotten. */
  trashed(): Array<Fact & { trashedAt: string }> {
    const dir = join(this.root, TRASH_DIR);
    if (!existsSync(dir)) return [];
    const out: Array<Fact & { trashedAt: string }> = [];
    for (const path of this.walk(dir, "")) {
      const f = this.load(path, "trash");
      if (!f) continue;
      let at = "";
      try {
        at = statSync(this.abs(path, "trash")).mtime.toISOString();
      } catch {
        /* gone meanwhile */
      }
      out.push({ ...f, trashedAt: at });
    }
    return out.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  }

  /** Forget for good what has been in the trash longer than `ms` (only while git keeps the history). */
  purgeTrash(ms: number, now = Date.now()): number {
    let n = 0;
    for (const f of this.trashed()) {
      if (!f.trashedAt || now - Date.parse(f.trashedAt) < ms) continue;
      try {
        rmSync(this.abs(f.path, "trash"));
        n++;
      } catch {
        /* gone meanwhile */
      }
    }
    return n;
  }

  inTrash(path: string): boolean {
    try {
      return existsSync(this.abs(path, "trash"));
    } catch {
      return false;
    }
  }

  /** Raw file text (validated path); undefined if missing. */
  raw(path: string, review = false): string | undefined {
    const abs = path === INDEX_FILE && !review ? join(this.root, INDEX_FILE) : this.abs(path, review ? "review" : "");
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  }

  /** Facts that are true now, grouped by folder ("" = root first), sorted by title. */
  grouped(prefix = ""): Array<{ dir: string; facts: Fact[] }> {
    const groups = new Map<string, Fact[]>();
    for (const f of this.facts.values()) {
      if (!isCurrent(f)) continue;
      if (prefix && !(f.path.startsWith(prefix + "/") || f.path === prefix)) continue;
      const d = dirOf(f.path);
      const list = groups.get(d) ?? [];
      list.push(f);
      groups.set(d, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([dir, facts]) => ({ dir, facts: facts.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path)) }));
  }

  /** MEMORY.md: links to every fact that is true now, grouped by kind. */
  indexMarkdown(): string {
    const lines = ["# Memory", "", "<!-- Generated by Owlbot from the files in this folder. Do not edit: it is rewritten on every change. -->"];
    const byKind = new Map<FactKind, Fact[]>();
    for (const f of this.facts.values()) {
      if (!isCurrent(f)) continue;
      byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
    }
    if (!byKind.size) lines.push("", "_No facts yet._");
    for (const kind of KINDS) {
      const facts = byKind.get(kind);
      if (!facts?.length) continue;
      lines.push("", `## ${KIND_HEADINGS[kind]}`);
      for (const f of facts.sort((a, b) => b.importance - a.importance || a.title.localeCompare(b.title))) {
        const meta = [f.about.join(", "), f.tags.join(", "), f.scope !== "team" ? `only ${f.scope.slice(6)}` : ""].filter(Boolean).join(" · ");
        lines.push(`- [${f.title.replace(/[[\]]/g, "\\$&")}](${encodeURI(f.path)})${meta ? ` — ${meta}` : ""}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  writeIndex(): void {
    this.writeFile(join(this.root, INDEX_FILE), this.indexMarkdown());
  }
}

/** Headings of MEMORY.md (English: the file is read by models and people alike). */
const KIND_HEADINGS: Record<FactKind, string> = {
  self: "About the user",
  preference: "Preferences",
  person: "People",
  place: "Places",
  project: "Projects",
  event: "Timeline",
  howto: "How-to",
  note: "Notes",
};
