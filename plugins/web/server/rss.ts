// RSS 2.0 / RDF and Atom feeds for web_rss: the items (title, link, date, a short summary, a picture), and the feeds a
// site's page points to (<link rel="alternate" type="application/rss+xml">). Feeds are loose XML in practice: tags
// are found by name whatever their namespace prefix, CDATA and entities are undone, HTML in summaries becomes text.

export interface FeedItem {
  title: string;
  url?: string;
  /** ISO date, when the feed gives one that parses. */
  date?: string;
  summary?: string;
  image?: string;
}

export interface ParsedFeed {
  title?: string;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const uncdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
/** Text of a field: CDATA unwrapped, HTML (escaped or not) dropped, entities decoded, spaces collapsed. */
const plain = (s: string) =>
  decodeEntities(
    decodeEntities(uncdata(s))
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

/** The blocks <tag …>…</tag> (any namespace prefix). */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

/** The first field among `names`, as raw inner XML. */
function field(xml: string, names: string[]): string | undefined {
  for (const n of names) {
    const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`, "i").exec(xml);
    if (m && m[1].trim()) return m[1];
  }
  return undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(plain(s));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** A feed's picture for an item: media:thumbnail / media:content / an image enclosure, else the first <img> in its HTML. */
function imageOf(item: string, base: string): string | undefined {
  for (const m of item.matchAll(/<(media:thumbnail|media:content|enclosure)\b[^>]*>/gi)) {
    const tag = m[0];
    const type = attr(tag, "type") ?? "";
    const medium = attr(tag, "medium") ?? "";
    if (m[1].toLowerCase() === "media:thumbnail" || type.startsWith("image/") || medium === "image") {
      const src = absolute(attr(tag, "url"), base);
      if (src) return src;
    }
  }
  const html = decodeEntities(uncdata(item));
  const img = /<img\b[^>]*>/i.exec(html);
  return img ? absolute(attr(img[0], "src"), base) : undefined;
}

/** Items of an RSS, RDF or Atom document; undefined when it is not a feed. */
export function parseFeed(xml: string, base: string): ParsedFeed | undefined {
  const head = xml.slice(0, 4000);
  const atom = /<feed\b[^>]*>/i.test(head);
  if (!atom && !/<(rss|rdf:RDF|channel)\b/i.test(head)) return undefined;
  const items: FeedItem[] = [];
  for (const it of blocks(xml, atom ? "entry" : "item")) {
    const title = plain(field(it, ["title"]) ?? "");
    let url: string | undefined;
    if (atom) {
      const links = [...it.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
      const best = links.find((l) => (attr(l, "rel") ?? "alternate") === "alternate") ?? links[0];
      url = absolute(best ? attr(best, "href") : undefined, base);
    } else {
      url = absolute(plain(field(it, ["link"]) ?? "") || undefined, base) ?? absolute(plain(field(it, ["guid"]) ?? ""), base);
    }
    const raw = field(it, atom ? ["summary", "content"] : ["description", "content:encoded", "summary"]);
    const summary = raw ? plain(raw).slice(0, 600) : undefined;
    const date = isoDate(field(it, atom ? ["published", "updated"] : ["pubDate", "dc:date", "published", "updated"]));
    const image = imageOf(it, base);
    if (!title && !url) continue;
    items.push({ title: title || url!, ...(url ? { url } : {}), ...(date ? { date } : {}), ...(summary ? { summary } : {}), ...(image ? { image } : {}) });
  }
  const top = atom ? xml.replace(/<entry\b[\s\S]*$/i, "") : (blocks(xml, "channel")[0] ?? xml).replace(/<item\b[\s\S]*$/i, "");
  const title = plain(field(top, ["title"]) ?? "") || undefined;
  return { ...(title ? { title } : {}), items };
}

/** The feeds an HTML page points to, RSS and Atom, in page order. */
export function findFeeds(html: string, base: string): Array<{ url: string; title?: string }> {
  const out: Array<{ url: string; title?: string }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\balternate\b/i.test(attr(tag, "rel") ?? "")) continue;
    if (!/(rss|atom)\+xml|application\/feed\+json/i.test(attr(tag, "type") ?? "")) continue;
    const url = absolute(attr(tag, "href"), base);
    const title = attr(tag, "title")?.trim();
    if (url && !out.some((f) => f.url === url)) out.push({ url, ...(title ? { title } : {}) });
  }
  return out;
}
