// Memory files on disk: one fact per markdown file with YAML frontmatter.
// Active facts live in the memory root. Facts pending the user's review wait in .review/<path> (written from tainted
// sessions by earlier versions; changes from such sessions are now approved in the chat) or carry status: review.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { stringify } from "yaml";
import { parseFrontmatter } from "@owlbot/shared";
import { dirOf, normalizePath, PathError } from "./paths.ts";

export type FactStatus = "active" | "review";

export interface Fact {
  path: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  source: string;
  status: FactStatus;
  body: string;
}

export interface ReviewItem extends Fact {
  /** True when an active-tree file itself carries status: review (edited by hand); false for .review/ copies. */
  inPlace: boolean;
}

export const INDEX_FILE = "MEMORY.md";
export const PROFILE_FILE = "profile.md";
export const DEFAULT_FOLDERS = ["people", "projects", "notes"];
const REVIEW_DIR = ".review";

function str(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v === undefined || v === null ? "" : String(v);
}

export function normalizeTags(v: unknown): string[] {
  // Commas separate tags everywhere (the search index stores them comma-joined).
  const list = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).flatMap((t) => String(t ?? "").split(","));
  const out: string[] = [];
  for (const t of list) {
    const s = String(t ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 20);
}

function titleFromBody(path: string, body: string): string {
  const h = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (h) return h;
  const base = path.split("/").pop()!.replace(/\.md$/, "");
  return base.replace(/[-_]+/g, " ");
}

/** Parse a fact file (frontmatter optional, invalid YAML tolerated). */
export function parseFact(path: string, text: string): Fact {
  let data: Record<string, any> = {};
  let body = text;
  try {
    ({ data, body } = parseFrontmatter(text));
  } catch {
    /* invalid YAML: treat the whole file as body */
  }
  const status: FactStatus = str(data.status).toLowerCase() === "review" ? "review" : "active";
  return {
    path,
    title: str(data.title).replace(/\s+/g, " ").trim() || titleFromBody(path, body),
    tags: normalizeTags(data.tags),
    created: str(data.created),
    updated: str(data.updated),
    source: str(data.source),
    status,
    body: body.replace(/^\s*\n/, "").trimEnd(),
  };
}

const y = (v: unknown) => stringify(v, { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trimEnd();

export function serializeFact(f: Fact): string {
  const fm = [
    `title: ${y(f.title)}`,
    `tags: ${y(f.tags)}`,
    `created: ${y(f.created)}`,
    `updated: ${y(f.updated)}`,
    `source: ${y(f.source)}`,
    `status: ${f.status}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${f.body.trim()}\n`;
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

export class MemoryStore {
  root: string;
  facts = new Map<string, Fact>();
  review = new Map<string, ReviewItem>();

  constructor(root: string) {
    this.root = root;
  }

  /** Absolute path of a fact (validated). `review` → its .review/ copy. */
  abs(path: string, review = false): string {
    const p = normalizePath(path);
    const abs = review ? join(this.root, REVIEW_DIR, ...p.split("/")) : join(this.root, ...p.split("/"));
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new PathError("outsideRoot", `Path is outside the memory folder: ${path}`, { path });
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new PathError("symlink", `Symbolic links are not supported: ${path}`, { path });
    return abs;
  }

  init(): void {
    mkdirSync(this.root, { recursive: true });
    for (const d of DEFAULT_FOLDERS) mkdirSync(join(this.root, d), { recursive: true });
    this.scan();
  }

  /** (Re)load every fact from disk. */
  scan(): void {
    this.facts.clear();
    this.review.clear();
    for (const path of this.walk(this.root, "")) {
      if (path === INDEX_FILE) continue;
      const f = this.load(path, false);
      if (!f) continue;
      if (f.status === "review") this.review.set(path, { ...f, inPlace: true });
      else this.facts.set(path, f);
    }
    const rr = join(this.root, REVIEW_DIR);
    if (existsSync(rr)) {
      for (const path of this.walk(rr, "")) {
        const f = this.load(path, true);
        if (f) this.review.set(path, { ...f, status: "review", inPlace: false });
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

  private load(path: string, review: boolean): Fact | undefined {
    try {
      return parseFact(path, readFileSync(this.abs(path, review), "utf8"));
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

  /** Write an active fact. */
  put(f: Fact): void {
    const fact: Fact = { ...f, status: "active" };
    this.writeFile(this.abs(fact.path), serializeFact(fact));
    this.facts.set(fact.path, fact);
    const r = this.review.get(fact.path);
    if (r?.inPlace) this.review.delete(fact.path);
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
    const abs = this.abs(path, !r.inPlace);
    if (existsSync(abs)) rmSync(abs);
    return true;
  }

  /** Raw file text (validated path); undefined if missing. */
  raw(path: string, review = false): string | undefined {
    const abs = path === INDEX_FILE && !review ? join(this.root, INDEX_FILE) : this.abs(path, review);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  }

  /** Active facts grouped by folder ("" = root first), sorted by title. */
  grouped(prefix = ""): Array<{ dir: string; facts: Fact[] }> {
    const groups = new Map<string, Fact[]>();
    for (const f of this.facts.values()) {
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

  /** MEMORY.md: links to every active fact, grouped by folder. */
  indexMarkdown(): string {
    const lines = ["# Memory", "", "<!-- Generated by Owlbot from the files in this folder. Do not edit: it is rewritten on every change. -->"];
    const groups = this.grouped();
    if (!groups.length) lines.push("", "_No facts yet._");
    for (const g of groups) {
      lines.push("", `## ${g.dir || "(root)"}`);
      for (const f of g.facts) lines.push(`- [${f.title.replace(/[[\]]/g, "\\$&")}](${encodeURI(f.path)})${f.tags.length ? ` — ${f.tags.join(", ")}` : ""}`);
    }
    return lines.join("\n") + "\n";
  }

  writeIndex(): void {
    this.writeFile(join(this.root, INDEX_FILE), this.indexMarkdown());
  }
}
