// Builtin plugin "wikipedia": search and read Wikipedia in any language, no key. wikipedia_article shows the
// article's summary as a card in the chat (widget "article": picture, title, the opening paragraphs, a link) and gives
// the model the text, the whole article when asked; wikipedia_search lists matching articles.

import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import type { ToolResult } from "@owlbot/shared";

interface Settings {
  /** The wiki's address with "{lang}" for the language (tests point it at a fake). */
  wikiUrl?: string;
}

/** What the "article" card draws. */
export interface ArticleCard {
  lang: string;
  title: string;
  description?: string;
  extract: string;
  image?: { src: string; width?: number; height?: number };
  url: string;
}

const LANG = /^[a-z]{2,3}(-[a-z]{2,8})?$/;
const MAX_FULL_CHARS = 16_000;
const MAX_RESULTS = 10;
const USER_AGENT = "Owlbot/0.1 (self-hosted personal agent; wikipedia plugin)";

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

class WikiError extends Error {}

/** <span class="searchmatch">Lisbon</span> → Lisbon; entities people would see as code become characters. */
export function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Wikimedia's standard thumbnail width that stays sharp across a card on a retina screen. */
const CARD_IMAGE_WIDTH = 960;

/**
 * The lead picture for the card: the summary's thumbnail (330 px) is blurry across a card, so the same image at
 * CARD_IMAGE_WIDTH when the original is that large, else the original itself.
 */
export function leadImage(s: any): ArticleCard["image"] | undefined {
  const thumb = s?.thumbnail;
  const orig = s?.originalimage;
  if (!thumb?.source) return undefined;
  const w = Number(thumb.width) || 0;
  const h = Number(thumb.height) || 0;
  if (orig?.source && Number(orig.width) <= CARD_IMAGE_WIDTH) return { src: String(orig.source), width: orig.width, height: orig.height };
  if (/\/\d+px-/.test(thumb.source) && Number(orig?.width) > CARD_IMAGE_WIDTH && w) {
    return { src: String(thumb.source).replace(/\/\d+px-/, `/${CARD_IMAGE_WIDTH}px-`), width: CARD_IMAGE_WIDTH, height: Math.round((h * CARD_IMAGE_WIDTH) / w) };
  }
  return { src: String(thumb.source), width: w || undefined, height: h || undefined };
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const wiki = (lang: string) => (settings.wikiUrl || "https://{lang}.wikipedia.org").replace("{lang}", lang).replace(/\/+$/, "");

    function langOf(v: unknown): string {
      const l = String(v ?? "").trim().toLowerCase();
      if (!l) return ctx.i18n.locale();
      if (!LANG.test(l)) throw new WikiError(`"${v}" is not a Wikipedia language code (en, ru, de, fr…).`);
      return l;
    }

    async function get(url: string): Promise<{ status: number; body: any }> {
      let res: Response;
      try {
        res = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT, "api-user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      } catch (e: any) {
        throw new WikiError(`Wikipedia is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
      }
      const body = await res.json().catch(() => undefined);
      if (!res.ok && res.status !== 404) throw new WikiError(`Wikipedia: ${(body as any)?.detail ?? (body as any)?.title ?? `HTTP ${res.status}`}`);
      return { status: res.status, body };
    }

    async function search(query: string, lang: string, limit: number): Promise<any[]> {
      const r = await get(`${wiki(lang)}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${limit}`);
      return Array.isArray(r.body?.pages) ? r.body.pages : [];
    }

    async function summary(title: string, lang: string): Promise<any | undefined> {
      const r = await get(`${wiki(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title.trim().replace(/ /g, "_"))}?redirect=true`);
      return r.status === 404 ? undefined : r.body;
    }

    async function fullText(title: string, lang: string): Promise<string> {
      const r = await get(`${wiki(lang)}/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`);
      return String(r.body?.query?.pages?.[0]?.extract ?? "");
    }

    ctx.tools.register({
      name: "search",
      effect: "read",
      source: true,
      description:
        "Search Wikipedia for articles: titles, one-line descriptions and a snippet. Use it to find the exact title when unsure, then wikipedia_article to read one. " +
        "`lang` is the Wikipedia's language code (default: the user's language); search in English for things better covered there.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for" },
          lang: { type: "string", description: "Wikipedia language: en, ru, de… (default: the user's language)" },
          limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: "How many results (default 5)" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        try {
          const lang = langOf(input.lang);
          const query = String(input.query ?? "").trim();
          if (!query) return text("query is empty.", true);
          const pages = await search(query, lang, Math.min(MAX_RESULTS, Math.max(1, Math.round(Number(input.limit) || 5))));
          if (!pages.length) return text(`Nothing on ${lang}.wikipedia.org for "${query}".`);
          return text(
            pages
              .map((p, i) => `${i + 1}. ${p.title}${p.description ? ` — ${p.description}` : ""}\n   ${plain(String(p.excerpt ?? ""))}\n   https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.key ?? p.title))}`)
              .join("\n"),
          );
        } catch (e: any) {
          return text(e instanceof WikiError ? e.message : `Wikipedia search failed: ${e?.message ?? e}`, true);
        }
      },
    });

    ctx.tools.register({
      name: "article",
      effect: "read",
      source: true,
      description:
        "Read a Wikipedia article and show its summary to the user as a card in the chat (picture, title, opening paragraphs, link). " +
        "Give its `title` (or a close guess: the best search match is taken); `full: true` returns the whole article's text to you, for detailed questions. " +
        "Use it when the user asks who or what something is, or wants to learn about a topic; then answer in your own words, briefly: the card shows the summary.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Article title, e.g. \"Lisbon\"" },
          lang: { type: "string", description: "Wikipedia language: en, ru, de… (default: the user's language)" },
          full: { type: "boolean", description: "Return the whole article's text, not just the summary" },
        },
        required: ["title"],
      },
      handler: async (input, call) => {
        try {
          const lang = langOf(input.lang);
          const asked = String(input.title ?? "").trim();
          if (!asked) return text("title is empty.", true);
          let s = await summary(asked, lang);
          if (!s) {
            const best = (await search(asked, lang, 1))[0];
            if (best) s = await summary(String(best.key ?? best.title), lang);
          }
          if (!s?.title) return text(`No article "${asked}" on ${lang}.wikipedia.org. Try wikipedia_search, or another language.`, true);
          const card: ArticleCard = {
            lang,
            title: plain(String(s.title)),
            ...(s.description ? { description: String(s.description) } : {}),
            extract: String(s.extract ?? ""),
            ...(leadImage(s) ? { image: leadImage(s)! } : {}),
            url: String(s.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`),
          };
          if (s.type === "disambiguation")
            return text(`"${card.title}" on ${lang}.wikipedia.org is a disambiguation page: ${card.extract}\nUse wikipedia_search to find the article meant.`);
          ctx.widgets.show(call, "article", card);
          let body = `${card.title}${card.description ? ` (${card.description})` : ""}\n${card.extract}\n${card.url}`;
          if (input.full) {
            const full = await fullText(card.title, lang);
            if (full) body += `\n\nFull text${full.length > MAX_FULL_CHARS ? ` (first ${MAX_FULL_CHARS} characters)` : ""}:\n${full.slice(0, MAX_FULL_CHARS)}`;
          }
          return text(`${body}\n\nA card with the article's summary and link is shown in the chat: answer in your own words, without repeating it.`);
        } catch (e: any) {
          return text(e instanceof WikiError ? e.message : `Wikipedia failed: ${e?.message ?? e}`, true);
        }
      },
    });
  },
};

export default plugin;
