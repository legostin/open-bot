// HTML → readable markdown / plain text. A small readability-style extractor on top of node-html-parser:
// drop scripts, chrome and hidden nodes, find the element that holds most of the prose, render it.

import { parse, type HTMLElement, type Node } from "node-html-parser";

export type TextFormat = "markdown" | "text";

export interface Extracted {
  title: string;
  content: string;
  /** The page's own picture for sharing (og:image, twitter:image), absolute; what a post about the page shows. */
  image?: string;
}

const ELEMENT = 1;
const TEXT = 3;

/** Removed everywhere before anything else. */
const DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "frame", "frameset", "object", "embed",
  "applet", "audio", "video", "source", "track", "map", "button", "input", "select", "option", "optgroup", "textarea",
  "datalist", "dialog", "link", "meta", "base", "head",
]);

/** Page chrome. `header` only when it is not part of an article/main. */
const CHROME_TAGS = new Set(["nav", "aside", "footer", "menu"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar"]);
const JUNK_RE =
  /(^|[\s_-])(cookies?|consent|gdpr|popup|modal|newsletter|subscribe|share|sharing|social|related|recommended|advert|advertisement|ads?|promo|sponsored|breadcrumbs?|sidebar|comments?|footer|navbar|nav|menu|skip-link|toolbar|pagination|paywall|signup)([\s_-]|$)/i;

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "legend",
  "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const isEl = (n: Node): n is HTMLElement => n.nodeType === ELEMENT;
const tagOf = (el: HTMLElement) => (el.rawTagName ?? "").toLowerCase();

function collapse(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** Normalize inline text: collapse spaces per line, trim, keep explicit line breaks. */
function cleanInline(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrap(s: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

function isHidden(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return true;
  if ((el.getAttribute("aria-hidden") ?? "").toLowerCase() === "true") return true;
  const style = (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function allElements(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const stack: HTMLElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    out.push(el);
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const c = el.childNodes[i];
      if (isEl(c)) stack.push(c);
    }
  }
  return out;
}

/** Text length of every element (bottom-up, no repeated traversals). */
function textLengths(root: HTMLElement): Map<HTMLElement, number> {
  const lens = new Map<HTMLElement, number>();
  const els = allElements(root);
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    let n = 0;
    for (const c of el.childNodes) n += isEl(c) ? (lens.get(c) ?? 0) : c.nodeType === TEXT ? collapse(c.text).trim().length : 0;
    lens.set(el, n);
  }
  return lens;
}

/** Length of paragraph-like text under every element. */
function proseLengths(root: HTMLElement): { per: Map<HTMLElement, number>; total: number } {
  const per = new Map<HTMLElement, number>();
  let total = 0;
  for (const p of root.querySelectorAll("p, pre, blockquote")) {
    const len = collapse(p.text).trim().length;
    if (len < 25) continue;
    total += len;
    for (let a: HTMLElement | null = p; a; a = a.parentNode) {
      per.set(a, (per.get(a) ?? 0) + len);
      if (a === root) break;
    }
  }
  return { per, total };
}

function chooseRoot(body: HTMLElement): HTMLElement {
  const lens = textLengths(body);
  const bodyLen = lens.get(body) ?? 0;
  let start = body;
  let best = 0;
  for (const c of body.querySelectorAll("article, main, [role=main]")) {
    const n = lens.get(c) ?? 0;
    if (n > best) {
      best = n;
      start = c;
    }
  }
  if (start !== body && best < Math.max(200, bodyLen * 0.3)) start = body;
  // Descend while a single child holds most of the prose (skips wrappers, sidebars, footers).
  const { per, total } = proseLengths(start);
  if (total < 200) return start;
  let cur = start;
  for (;;) {
    if (tagOf(cur) === "article" || cur.childNodes.some((c) => isEl(c) && tagOf(c) === "h1")) break;
    const next = cur.childNodes.filter(isEl).find((c) => (per.get(c) ?? 0) >= total * 0.75);
    if (!next) break;
    cur = next;
  }
  return cur;
}

function stripChrome(root: HTMLElement, lens: Map<HTMLElement, number>): void {
  const rootLen = lens.get(root) ?? 0;
  const drop: HTMLElement[] = [];
  for (const el of allElements(root)) {
    if (el === root) continue;
    const tag = tagOf(el);
    const role = (el.getAttribute("role") ?? "").toLowerCase();
    if (isHidden(el) || CHROME_TAGS.has(tag) || CHROME_ROLES.has(role)) drop.push(el);
    else if (tag === "header" && !el.closest("article, main")) drop.push(el);
    else if (JUNK_RE.test(`${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`) && (lens.get(el) ?? 0) < rootLen * 0.3) drop.push(el);
  }
  for (const el of drop) el.remove();
}

class Renderer {
  mode: TextFormat;
  base: string;
  constructor(mode: TextFormat, base: string) {
    this.mode = mode;
    this.base = base;
  }

  private md(): boolean {
    return this.mode === "markdown";
  }

  private url(href: string | undefined): string | undefined {
    if (!href) return undefined;
    try {
      const u = new URL(href.trim(), this.base);
      return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : undefined;
    } catch {
      return undefined;
    }
  }

  /** Children of a block container → list of blocks. */
  blocks(el: HTMLElement): string[] {
    const out: string[] = [];
    let inline = "";
    const flush = () => {
      const t = cleanInline(inline);
      if (t) out.push(t);
      inline = "";
    };
    for (const c of el.childNodes) {
      if (c.nodeType === TEXT) inline += collapse(c.text);
      else if (isEl(c)) {
        const tag = tagOf(c);
        if (BLOCK_TAGS.has(tag)) {
          flush();
          out.push(...this.block(c, tag));
        } else inline += this.inline(c, tag);
      }
    }
    flush();
    return out;
  }

  private block(el: HTMLElement, tag: string): string[] {
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const t = cleanInline(this.inlineChildren(el)).replace(/\n+/g, " ");
        if (!t) return [];
        return [this.md() ? `${"#".repeat(Number(tag[1]))} ${t}` : t];
      }
      case "ul":
      case "ol":
        return this.list(el, tag === "ol");
      case "blockquote": {
        const inner = this.blocks(el).join("\n\n");
        if (!inner) return [];
        return [this.md() ? inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : inner];
      }
      case "pre": {
        const code = el.text.replace(/^\n+|\s+$/g, "");
        if (!code) return [];
        if (!this.md()) return [code];
        const cls = `${el.getAttribute("class") ?? ""} ${el.querySelector("code")?.getAttribute("class") ?? ""}`;
        const lang = /(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1] ?? "";
        const fence = code.includes("```") ? "~~~~" : "```";
        return [`${fence}${lang}\n${code}\n${fence}`];
      }
      case "hr":
        return this.md() ? ["---"] : [];
      case "table":
        return this.table(el);
      case "dt": {
        const t = cleanInline(this.inlineChildren(el));
        return t ? [this.md() ? `**${t}**` : t] : [];
      }
      default:
        return this.blocks(el);
    }
  }

  private list(el: HTMLElement, ordered: boolean): string[] {
    let n = Number.parseInt(el.getAttribute("start") ?? "1", 10) || 1;
    const lines: string[] = [];
    for (const li of el.childNodes) {
      if (!isEl(li)) continue;
      const inner = tagOf(li) === "li" ? this.blocks(li).join("\n") : this.block(li, tagOf(li)).join("\n");
      if (!inner) continue;
      const marker = ordered ? `${n++}.` : "-";
      const pad = " ".repeat(marker.length + 1);
      lines.push(
        inner
          .split("\n")
          .map((l, i) => (i === 0 ? `${marker} ${l}` : l ? pad + l : l))
          .join("\n"),
      );
    }
    return lines.length ? [lines.join("\n")] : [];
  }

  private table(el: HTMLElement): string[] {
    const rows = el.querySelectorAll("tr").filter((tr) => tr.closest("table") === el);
    const cellsOf = (tr: HTMLElement) => tr.childNodes.filter(isEl).filter((c) => ["td", "th"].includes(tagOf(c)));
    // Layout tables (cells with blocks or long text) are rendered as plain containers.
    const layout = rows.some((tr) => cellsOf(tr).some((c) => c.querySelector("p, div, ul, ol, table, h1, h2, h3") || collapse(c.text).length > 400));
    if (layout || !rows.length) return rows.length ? rows.flatMap((tr) => cellsOf(tr).flatMap((c) => this.blocks(c))) : this.blocks(el);
    const cell = (c: HTMLElement) => cleanInline(this.inlineChildren(c)).replace(/\n+/g, " ");
    const grid = rows.map((tr) => cellsOf(tr).map((c) => (this.md() ? cell(c).replace(/\|/g, "\\|") : cell(c))));
    const width = Math.max(...grid.map((r) => r.length));
    if (width === 0) return [];
    const line = (r: string[]) => (this.md() ? `| ${[...r, ...new Array(width - r.length).fill("")].join(" | ")} |` : r.join(" | "));
    const out = grid.map(line);
    if (this.md()) out.splice(1, 0, `|${" --- |".repeat(width)}`);
    const caption = el.querySelector("caption");
    if (caption) out.unshift(cleanInline(caption.text));
    return [out.join("\n")];
  }

  private inlineChildren(el: HTMLElement): string {
    let s = "";
    for (const c of el.childNodes) {
      if (c.nodeType === TEXT) s += collapse(c.text);
      else if (isEl(c)) {
        const tag = tagOf(c);
        s += BLOCK_TAGS.has(tag) ? ` ${this.blocks(c).join("\n")} ` : this.inline(c, tag);
      }
    }
    return s;
  }

  private inline(el: HTMLElement, tag: string): string {
    switch (tag) {
      case "br":
        return "\n";
      case "img": {
        const alt = collapse(el.getAttribute("alt") ?? "").trim();
        const src = this.url(el.getAttribute("src"));
        if (!alt) return "";
        return this.md() && src ? `![${alt}](${src})` : "";
      }
      case "a": {
        const text = this.inlineChildren(el);
        const href = this.url(el.getAttribute("href"));
        const t = collapse(text).trim();
        if (!this.md() || !href || !t || href === this.base) return text;
        const m = /^(\s*)/.exec(text)![1] ? " " : "";
        const e = /(\s*)$/.exec(text)![1] ? " " : "";
        return `${m}[${t.replace(/[[\]]/g, "\\$&")}](${href.replace(/\)/g, "%29").replace(/ /g, "%20")})${e}`;
      }
      case "strong":
      case "b":
        return this.md() ? wrap(this.inlineChildren(el), "**") : this.inlineChildren(el);
      case "em":
      case "i":
        return this.md() ? wrap(this.inlineChildren(el), "*") : this.inlineChildren(el);
      case "del":
      case "s":
      case "strike":
        return this.md() ? wrap(this.inlineChildren(el), "~~") : this.inlineChildren(el);
      case "code":
      case "kbd":
      case "samp":
      case "tt": {
        const t = collapse(el.text);
        if (!this.md() || !t.trim()) return t;
        return wrap(t, t.includes("`") ? "``" : "`");
      }
      default:
        return this.inlineChildren(el);
    }
  }
}

/** Extract the title and the readable content of an HTML document. */
export function extractHtml(html: string, pageUrl: string, format: TextFormat = "markdown"): Extracted {
  const doc = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, textarea: true } });
  const title =
    collapse(doc.querySelector("title")?.text ?? "").trim() ||
    collapse(doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "").trim() ||
    collapse(doc.querySelector("h1")?.text ?? "").trim();
  const shared =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ??
    doc.querySelector('meta[property="og:image:url"]')?.getAttribute("content") ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content");
  let image: string | undefined;
  try {
    const u = shared?.trim() ? new URL(shared.trim(), pageUrl) : undefined;
    if (u && (u.protocol === "https:" || u.protocol === "http:")) image = u.href;
  } catch {
    /* no usable picture */
  }
  let base = pageUrl;
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      /* keep page URL */
    }
  }
  for (const el of allElements(doc)) if (el !== doc && DROP_TAGS.has(tagOf(el))) el.remove();
  const body = doc.querySelector("body") ?? doc;
  let content: string;
  try {
    const root = chooseRoot(body);
    stripChrome(root, textLengths(root));
    content = new Renderer(format, base)
      .blocks(root)
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    // Pathological markup (e.g. extreme nesting): fall back to collapsed text.
    content = collapse(body.text).trim();
  }
  return { title, content, ...(image ? { image } : {}) };
}
