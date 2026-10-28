// Pages agents make: one React component in TSX on the pages kit (packages/pages-kit) plus the data it shows. The code,
// the script sucrase compiles from it and the data are files under <dataDir>/pages/<id>/; the rest is a row in `pages`.
// A page is served sandboxed at /p/<id>/<token>/ (server/pages.ts): the token is the page's capability, so whoever has
// the link sees it, and the page itself reaches nothing of the user's (no cookies, no API). It keeps a little state of
// its own (useStored) and reports what broke in a browser, which page_read shows its agent.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "sucrase";
import type { Locale, PageView } from "@owlbot/shared";
import { newId, nowIso, pageModuleAllowed, PAGE_MODULES, truncate } from "@owlbot/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";

export const MAX_CODE_BYTES = 200_000;
export const MAX_DATA_BYTES = 1_000_000;
export const MAX_STATE_BYTES = 256_000;
const MAX_ERROR = 2_000;

/** Hosts a page's getJson / useJson may reach (through the hub): free APIs without keys. */
export const PAGE_API_HOSTS = [
  "api.open-meteo.com",
  "air-quality-api.open-meteo.com",
  "marine-api.open-meteo.com",
  "geocoding-api.open-meteo.com",
  "archive-api.open-meteo.com",
  "api.frankfurter.app",
  "api.frankfurter.dev",
  "wikipedia.org",
  "wikimedia.org",
  "wikidata.org",
];

export function pageApiHostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return PAGE_API_HOSTS.some((a) => h === a || (a.split(".").length === 2 && h.endsWith(`.${a}`)));
}

/** A page could not be made or changed; the message is for the agent. */
export class PageError extends Error {}

export interface PageInput {
  title?: unknown;
  summary?: unknown;
  cover?: unknown;
  code?: unknown;
  data?: unknown;
}

interface Row {
  id: string;
  token: string;
  title: string;
  summary: string | null;
  cover: string | null;
  agent_id: string;
  conversation_id: string | null;
  state: string;
  version: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const line = (v: unknown, max: number): string => (typeof v === "string" ? truncate(v.replace(/\s+/g, " ").trim(), max) : "");

function cover(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  if (s.startsWith("file:")) return s.length <= 1024 ? s : undefined;
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && s.length <= 2048 ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page's TSX compiled to the script the kit runs: CommonJS (sucrase) wrapped as `owlbotPage(function …)`.
 * Syntax errors and imports the kit does not have come back as a PageError the agent can act on.
 */
export function compilePage(code: string): string {
  let out: string;
  try {
    out = transform(code, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true, filePath: "page.tsx" }).code;
  } catch (e) {
    throw new PageError(`The page's code does not compile: ${(e as Error).message}`);
  }
  const missing = [...out.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)].map((m) => m[2]).filter((name) => !pageModuleAllowed(name));
  if (missing.length) {
    throw new PageError(
      `Pages cannot import ${[...new Set(missing)].map((m) => `"${m}"`).join(", ")}. Available: ${PAGE_MODULES.join(", ")} and the shadcn/ui paths "@/components/ui/<name>".`,
    );
  }
  return `owlbotPage(function (require, exports, module) {\n${out}\n});\n`;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface PagesDeps {
  db: Db;
  bus: EventBus;
  dir: string;
}

export class Pages {
  private d: PagesDeps;

  constructor(d: PagesDeps) {
    this.d = d;
    mkdirSync(d.dir, { recursive: true });
  }

  create(input: PageInput, by: { agentId: string; conversationId?: string }): PageView {
    const title = line(input.title, 120);
    if (!title) throw new PageError("Give the page a title.");
    if (typeof input.code !== "string" || !input.code.trim()) throw new PageError("Give the page's code: one React component in TSX with a default export.");
    const id = newId("pg");
    const files = this.prepare(input.code, input.data === undefined ? {} : input.data);
    const now = nowIso();
    this.write(id, files);
    this.d.db
      .prepare("insert into pages(id, token, title, summary, cover, agent_id, conversation_id, state, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)")
      .run(id, randomBytes(18).toString("base64url"), title, line(input.summary, 300) || null, cover(input.cover) ?? null, by.agentId, by.conversationId ?? null, now, now);
    return this.changed(id)!;
  }

  /** New code, data, title, summary or cover: the version goes up and open copies reload. */
  update(id: string, input: PageInput): PageView {
    const row = this.row(id);
    if (!row) throw new PageError(`No page "${id}". See page_list.`);
    const code = typeof input.code === "string" && input.code.trim() ? input.code : undefined;
    if (code !== undefined || input.data !== undefined) {
      const current = this.source(id);
      this.write(id, this.prepare(code ?? current?.code ?? "", input.data !== undefined ? input.data : (current?.data ?? {})));
    }
    const title = input.title !== undefined ? line(input.title, 120) || row.title : row.title;
    const summary = input.summary !== undefined ? line(input.summary, 300) || null : row.summary;
    const pic = input.cover !== undefined ? (cover(input.cover) ?? null) : row.cover;
    this.d.db
      .prepare("update pages set title = ?, summary = ?, cover = ?, version = version + 1, last_error = null, updated_at = ? where id = ?")
      .run(title, summary, pic, nowIso(), id);
    return this.changed(id)!;
  }

  get(id: string): PageView | undefined {
    const r = this.row(id);
    return r ? this.view(r) : undefined;
  }

  /** A page by its id or its exact title (the newest of that title). */
  find(key: string): PageView | undefined {
    const byId = this.get(key);
    if (byId) return byId;
    const r = this.d.db.prepare("select * from pages where lower(title) = lower(?) order by updated_at desc, rowid desc limit 1").get(key.trim()) as Row | undefined;
    return r ? this.view(r) : undefined;
  }

  list(agentId?: string): PageView[] {
    const rows = (
      agentId ? this.d.db.prepare("select * from pages where agent_id = ? order by updated_at desc, rowid desc").all(agentId) : this.d.db.prepare("select * from pages order by updated_at desc, rowid desc").all()
    ) as unknown as Row[];
    return rows.map((r) => this.view(r));
  }

  /** The page's code and data as the agent wrote them. */
  source(id: string): { code: string; data: unknown } | undefined {
    const dir = join(this.d.dir, id);
    if (!existsSync(join(dir, "page.tsx"))) return undefined;
    let data: unknown = {};
    try {
      data = JSON.parse(readFileSync(join(dir, "data.json"), "utf8"));
    } catch {
      /* no data */
    }
    return { code: readFileSync(join(dir, "page.tsx"), "utf8"), data };
  }

  state(id: string): Record<string, unknown> {
    try {
      return JSON.parse(this.row(id)?.state ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** The page behind a link, when the token is its own. */
  open(id: string, token: string): PageView | undefined {
    const r = this.row(id);
    return r && sameToken(r.token, token) ? this.view(r) : undefined;
  }

  /** The compiled script of a page (open() checked the token). */
  script(id: string): string | undefined {
    const file = join(this.d.dir, id, "page.js");
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  /** What the page saved (useStored): keys merged into its state, within the limit. */
  saveState(id: string, changes: unknown): void {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new PageError("state must be an object");
    const next = { ...this.state(id), ...(changes as Record<string, unknown>) };
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new PageError("the page's state is too large");
    this.d.db.prepare("update pages set state = ? where id = ?").run(text, id);
  }

  /** What broke in a browser, kept until the next change (page_read shows it to the agent). */
  reportError(id: string, message: unknown, stack?: unknown): void {
    const text = truncate([typeof message === "string" ? message : "", typeof stack === "string" ? stack : ""].filter(Boolean).join("\n"), MAX_ERROR);
    if (!text) return;
    const r = this.row(id);
    if (!r || r.last_error === text) return;
    this.d.db.prepare("update pages set last_error = ? where id = ?").run(text, id);
    this.changed(id);
  }

  /** The page's HTML: the kit, the theme, the page's data and its script. */
  html(page: PageView, kit: { base: string; theme: string }, locale: Locale): string {
    const src = this.source(page.id);
    const info = { id: page.id, title: page.title, data: src?.data ?? {}, locale, state: this.state(page.id), version: page.version };
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    // Inside <script>, "</" would end the block: JSON escapes it as <.
    const json = JSON.stringify(info).replace(/</g, "\\u003c");
    return [
      "<!doctype html>",
      `<html lang="${locale}">`,
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
      `<title>${esc(page.title)}</title>`,
      `<link rel="stylesheet" href="${kit.base}kit.css">`,
      `<style type="text/tailwindcss">${kit.theme}</style>`,
      `<script src="${kit.base}tailwind.js"></script>`,
      `<script type="application/json" id="owlbot-page">${json}</script>`,
      "</head>",
      "<body>",
      '<div id="root"></div>',
      `<script src="${kit.base}kit.js"></script>`,
      `<script src="page.js?v=${page.version}"></script>`,
      "</body>",
      "</html>",
    ].join("\n");
  }

  private prepare(code: string, data: unknown): { code: string; script: string; data: string } {
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new PageError(`The page's code is over ${MAX_CODE_BYTES / 1000} KB: split it into smaller components or move content into data.`);
    const json = JSON.stringify(data ?? {});
    if (json === undefined) throw new PageError("data must be JSON.");
    if (Buffer.byteLength(json) > MAX_DATA_BYTES) throw new PageError(`The page's data is over ${MAX_DATA_BYTES / 1_000_000} MB.`);
    return { code, script: compilePage(code), data: json };
  }

  private write(id: string, files: { code: string; script: string; data: string }): void {
    const dir = join(this.d.dir, id);
    const tmp = join(this.d.dir, `.${id}.${randomBytes(4).toString("hex")}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "page.tsx"), files.code);
    writeFileSync(join(tmp, "page.js"), files.script);
    writeFileSync(join(tmp, "data.json"), files.data);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  }

  private row(id: string): Row | undefined {
    return this.d.db.prepare("select * from pages where id = ?").get(id) as Row | undefined;
  }

  private view(r: Row): PageView {
    return {
      id: r.id,
      title: r.title,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.cover ? { cover: r.cover } : {}),
      agentId: r.agent_id,
      ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
      url: `/p/${r.id}/${r.token}/`,
      version: r.version,
      ...(r.last_error ? { lastError: r.last_error } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private changed(id: string): PageView | undefined {
    const p = this.get(id);
    if (p) this.d.bus.emit("page.updated", p);
    return p;
  }
}

/** The kit's files (packages/pages-kit/dist) with a short hash of kit.js, which makes their URLs cacheable forever. */
export function loadKit(dir: string): { hash: string; theme: string; files: Map<string, { data: Buffer; type: string }> } | undefined {
  const types: Record<string, string> = { "kit.js": "text/javascript; charset=utf-8", "kit.css": "text/css; charset=utf-8", "tailwind.js": "text/javascript; charset=utf-8" };
  if (!existsSync(join(dir, "kit.js")) || !existsSync(join(dir, "theme.css"))) return undefined;
  const files = new Map<string, { data: Buffer; type: string }>();
  for (const [name, type] of Object.entries(types)) files.set(name, { data: readFileSync(join(dir, name)), type });
  for (const name of readdirSync(dir)) if (name.endsWith(".woff2")) files.set(name, { data: readFileSync(join(dir, name)), type: "font/woff2" });
  const hash = createHash("sha256").update(files.get("kit.js")!.data).update(files.get("kit.css")!.data).digest("hex").slice(0, 12);
  return { hash, theme: readFileSync(join(dir, "theme.css"), "utf8"), files };
}
