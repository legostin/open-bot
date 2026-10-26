// Memory service: every read/write path of the plugin (tools, hook, HTTP) goes through here.
// Mutations are serialized; each one updates the search index, regenerates MEMORY.md and commits to git.

import { join } from "node:path";
import { GitRepo } from "./git.ts";
import { openIndex, type SearchHit, type SearchIndex } from "./search.ts";
import { MemoryStore, INDEX_FILE, PROFILE_FILE, DEFAULT_FOLDERS, normalizeTags, parseFact, serializeFact, stripFrontmatter, type Fact, type ReviewItem } from "./store.ts";
import { dirOf, normalizePath, NotFoundError, PathError, slugify } from "./paths.ts";

export interface MemoryOptions {
  dataDir: string;
  git?: boolean;
  promptMaxChars?: number;
  forceSubstringSearch?: boolean;
  warn: (msg: string) => void;
  /** Notify web clients (ctx.ui.emit). */
  changed: (path: string, action: string) => void;
}

export interface WriteInput {
  path?: string;
  title: string;
  content: string;
  tags?: string[] | string;
}

const MAX_CONTENT = 100_000;
const MAX_TITLE = 200;

const tooLong = () => new PathError("contentTooLong", `Text is too long (max ${MAX_CONTENT} characters)`, { max: MAX_CONTENT });
const indexReadOnly = () => new PathError("indexReadOnly", `${INDEX_FILE} is generated automatically and cannot be edited`, { file: INDEX_FILE });
/** Exported for the HTTP handler. */
export const factNotFound = (path: string) => new NotFoundError("factNotFound", `Fact not found: ${path}`, { path });
const notInReview = (path: string) => new NotFoundError("notInReview", `No fact pending review at ${path}`, { path });

export class Memory {
  store: MemoryStore;
  index!: SearchIndex;
  git: GitRepo;
  o: MemoryOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: MemoryOptions) {
    this.o = o;
    this.store = new MemoryStore(join(o.dataDir, "memory"));
    this.git = new GitRepo(this.store.root, o.warn);
  }

  async start(): Promise<void> {
    this.store.init();
    this.index = openIndex(join(this.o.dataDir, "index.db"), {
      forceSubstring: this.o.forceSubstringSearch,
      onFallback: (r) => this.o.warn(`FTS5 is unavailable, using substring search: ${r}`),
    });
    this.index.rebuild(this.store.facts.values());
    this.store.writeIndex();
    if (this.o.git !== false) {
      await this.git.init();
      await this.git.commit("memory: sync");
    }
  }

  /** Let pending writes (and their git commits) finish, then close the index. */
  async stop(): Promise<void> {
    await this.queue;
    this.index?.close();
  }

  /** Serialize mutations (tools and HTTP may run concurrently). */
  private lock<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private async commit(action: string, path: string): Promise<void> {
    this.store.writeIndex();
    await this.git.commit(`memory: ${action} ${path}`);
    this.o.changed(path, action);
  }

  private uniquePath(title: string): string {
    const slug = slugify(title);
    for (let i = 1; ; i++) {
      const path = `notes/${slug}${i > 1 ? `-${i}` : ""}.md`;
      const existing = this.store.facts.get(path) ?? this.store.review.get(path);
      if (!existing || existing.title.toLowerCase() === title.toLowerCase()) return path;
    }
  }

  // ---------- writes ----------

  /** Create or update a fact. From a tainted session it is queued for review instead. */
  write(input: WriteInput, meta: { source: string; tainted: boolean }): Promise<{ path: string; status: "created" | "updated" | "review" }> {
    return this.lock(async () => {
      const title = String(input.title ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!title) throw new PathError("titleRequired", "A fact title (title) is required");
      if (title.length > MAX_TITLE) throw new PathError("titleTooLong", `Title is too long (max ${MAX_TITLE} characters)`, { max: MAX_TITLE });
      const content = stripFrontmatter(String(input.content ?? "")).trim();
      if (content.length > MAX_CONTENT) throw tooLong();
      const path = input.path ? normalizePath(input.path) : this.uniquePath(title);
      if (path === INDEX_FILE) throw indexReadOnly();
      const existing = this.store.facts.get(path);
      const now = new Date().toISOString();
      const fact: Fact = {
        path,
        title,
        tags: input.tags !== undefined ? normalizeTags(input.tags) : (existing?.tags ?? []),
        created: existing?.created || now,
        updated: now,
        source: meta.source,
        status: meta.tainted ? "review" : "active",
        body: content,
      };
      if (meta.tainted) {
        this.store.putReview(fact);
        await this.commit("review", path);
        return { path, status: "review" as const };
      }
      this.store.put(fact);
      this.index.upsert(fact);
      await this.commit(existing ? "update" : "create", path);
      return { path, status: existing ? ("updated" as const) : ("created" as const) };
    });
  }

  /** Delete a fact (active and pending versions). */
  forget(rawPath: string): Promise<{ path: string }> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (path === INDEX_FILE) throw new PathError("indexGenerated", `${INDEX_FILE} is generated automatically`, { file: INDEX_FILE });
      const a = this.store.removeActive(path);
      const r = this.store.removeReview(path);
      if (!a && !r) throw factNotFound(path);
      this.index.remove(path);
      await this.commit("forget", path);
      return { path };
    });
  }

  /** Save a file edited by the user in the UI (raw markdown, frontmatter optional). Always active. */
  putRaw(rawPath: string, raw: string): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (path === INDEX_FILE) throw indexReadOnly();
      if (raw.length > MAX_CONTENT) throw tooLong();
      const existing = this.store.facts.get(path);
      const parsed = parseFact(path, raw);
      const now = new Date().toISOString();
      const fact: Fact = {
        ...parsed,
        title: parsed.title,
        created: existing?.created || parsed.created || now,
        updated: now,
        source: "user",
        status: "active",
      };
      this.store.put(fact);
      this.index.upsert(fact);
      await this.commit(existing ? "edit" : "create", path);
      return fact;
    });
  }

  approve(rawPath: string): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      const item = this.store.review.get(path);
      if (!item) throw notInReview(path);
      const existing = this.store.facts.get(path);
      const { inPlace: _inPlace, ...rest } = item;
      const fact: Fact = { ...rest, status: "active", created: existing?.created || item.created, updated: new Date().toISOString() };
      if (!item.inPlace) this.store.removeReview(path);
      this.store.put(fact);
      this.index.upsert(fact);
      await this.commit("approve", path);
      return fact;
    });
  }

  reject(rawPath: string): Promise<{ path: string }> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (!this.store.removeReview(path)) throw notInReview(path);
      await this.commit("reject", path);
      return { path };
    });
  }

  // ---------- reads ----------

  search(query: string, limit = 10): SearchHit[] {
    return this.index.search(String(query ?? ""), Math.max(1, Math.min(50, Math.floor(limit) || 10)));
  }

  get(rawPath: string): { fact?: Fact; review?: ReviewItem; path: string } {
    const path = normalizePath(rawPath);
    return { path, fact: this.store.facts.get(path), review: this.store.review.get(path) };
  }

  reviewItems(): ReviewItem[] {
    return [...this.store.review.values()].sort((a, b) => b.updated.localeCompare(a.updated));
  }

  list(rawDir?: string): { dir: string; groups: Array<{ dir: string; facts: Fact[] }>; review: number } {
    const dir = rawDir ? normalizePath(rawDir, { dir: true }) : "";
    const review = [...this.store.review.keys()].filter((p) => !dir || p.startsWith(dir + "/")).length;
    return { dir, groups: this.store.grouped(dir), review };
  }

  tree(): { facts: Array<Omit<Fact, "body">>; folders: string[]; review: number } {
    const folders = new Set<string>(DEFAULT_FOLDERS);
    const facts = [...this.store.facts.values()].map(({ body: _b, ...meta }) => meta);
    for (const f of facts) for (let d = dirOf(f.path); d; d = dirOf(d)) folders.add(d);
    return { facts: facts.sort((a, b) => a.path.localeCompare(b.path)), folders: [...folders].sort(), review: this.store.review.size };
  }

  serialize(f: Fact): string {
    return serializeFact(f);
  }

  /** Text appended to the system prompt at session start. */
  sessionPrompt(): string {
    const max = Math.max(500, this.o.promptMaxChars ?? 4000);
    const out = [
      "## Memory",
      "Long-term memory about the user (markdown facts). Use `memory_search` / `memory_read` for details and `memory_write` to save new durable facts (preferences, people, projects, decisions) — one fact per file.",
    ];
    let used = out.join("\n").length;
    const profile = this.store.facts.get(PROFILE_FILE)?.body.trim();
    if (profile) {
      const budget = Math.floor(max * 0.4);
      const text = profile.length > budget ? profile.slice(0, budget - 1) + "…" : profile;
      out.push("", "### Profile (profile.md)", text);
      used += text.length + 30;
    }
    const groups = this.store.grouped().map((g) => ({ ...g, facts: g.facts.filter((f) => f.path !== PROFILE_FILE) })).filter((g) => g.facts.length);
    const total = groups.reduce((n, g) => n + g.facts.length, 0);
    if (!total) {
      if (!profile) out.push("", "Memory is empty so far.");
      return out.join("\n");
    }
    out.push("", "### Index (title — path)");
    used += 30;
    let shown = 0;
    outer: for (const g of groups) {
      const header = `${g.dir || "(root)"}:`;
      if (used + header.length + 1 > max - 80) break;
      out.push(header);
      used += header.length + 1;
      for (const f of g.facts) {
        const line = `- ${f.title} — ${f.path}`;
        if (used + line.length + 1 > max - 80) break outer;
        out.push(line);
        used += line.length + 1;
        shown++;
      }
    }
    if (shown < total) out.push(`- … and ${total - shown} more (use memory_list or memory_search)`);
    return out.join("\n");
  }
}
