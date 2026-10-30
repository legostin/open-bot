// Web search providers: Brave Search API, Tavily, SearXNG (JSON) and DuckDuckGo HTML (no key).

import { parse } from "node-html-parser";

export type ProviderId = "brave" | "tavily" | "searxng" | "duckduckgo";
export const PROVIDERS: ProviderId[] = ["brave", "tavily", "searxng", "duckduckgo"];

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchSettings {
  provider?: "auto" | ProviderId;
  searxngUrl?: string;
  braveBaseUrl?: string;
  tavilyBaseUrl?: string;
  duckduckgoUrl?: string;
  userAgent?: string;
}

export interface SearchDeps {
  settings: SearchSettings;
  /** Vault lookup (ctx.vault.get); throws when the item is missing or the vault is sealed. */
  vault: (id: string) => Promise<Record<string, string>>;
  userAgent: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SNIPPET_MAX = 400;

function clean(s: unknown): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip tags and decode entities (Brave descriptions contain <strong> etc.). */
function stripHtml(s: unknown): string {
  return clean(parse(String(s ?? "")).text);
}

function snippet(s: string): string {
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1) + "…" : s;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

async function vaultValue(deps: SearchDeps, id: string): Promise<string | undefined> {
  try {
    const item = await deps.vault(id);
    const v = item.value ?? item.password ?? item.token ?? Object.values(item)[0];
    return v ? String(v) : undefined;
  } catch {
    return undefined; // missing item or sealed vault: provider not configured
  }
}

async function http(deps: SearchDeps, provider: ProviderId, url: string, init: RequestInit): Promise<Response> {
  const res = await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000) });
  if (!res.ok) {
    const body = clean((await res.text().catch(() => "")).slice(0, 300));
    throw new Error(`${provider}: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res;
}

async function brave(deps: SearchDeps, key: string, query: string, count: number): Promise<SearchResult[]> {
  const base = trimSlash(deps.settings.braveBaseUrl || "https://api.search.brave.com");
  const url = `${base}/res/v1/web/search?${new URLSearchParams({ q: query, count: String(Math.min(count, 20)) })}`;
  const res = await http(deps, "brave", url, { headers: { accept: "application/json", "x-subscription-token": key, "user-agent": deps.userAgent } });
  const json: any = await res.json();
  return (json?.web?.results ?? []).map((r: any) => ({ title: stripHtml(r.title), url: String(r.url ?? ""), snippet: snippet(stripHtml(r.description)) }));
}

async function tavily(deps: SearchDeps, key: string, query: string, count: number): Promise<SearchResult[]> {
  const base = trimSlash(deps.settings.tavilyBaseUrl || "https://api.tavily.com");
  const res = await http(deps, "tavily", `${base}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": deps.userAgent },
    body: JSON.stringify({ query, max_results: Math.min(count, 20), search_depth: "basic" }),
  });
  const json: any = await res.json();
  return (json?.results ?? []).map((r: any) => ({ title: clean(r.title), url: String(r.url ?? ""), snippet: snippet(clean(r.content)) }));
}

async function searxng(deps: SearchDeps, baseUrl: string, query: string, count: number): Promise<SearchResult[]> {
  const url = `${trimSlash(baseUrl)}/search?${new URLSearchParams({ q: query, format: "json" })}`;
  const res = await http(deps, "searxng", url, { headers: { accept: "application/json", "user-agent": deps.userAgent } });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("searxng: the instance did not return JSON (enable `json` in search.formats of its settings.yml)");
  }
  return (json?.results ?? []).map((r: any) => ({ title: clean(r.title), url: String(r.url ?? ""), snippet: snippet(clean(r.content)) }));
}

/** Resolve DuckDuckGo redirect links (//duckduckgo.com/l/?uddg=<target>) to the target URL. */
export function ddgTarget(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) {
      const target = u.searchParams.get("uddg");
      if (u.pathname.startsWith("/l/") && target) return /^https?:\/\//i.test(target) ? target : undefined;
      return undefined; // internal links, ads (/y.js)
    }
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the result list of html.duckduckgo.com/html/. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const doc = parse(html);
  const out: SearchResult[] = [];
  for (const r of doc.querySelectorAll(".result")) {
    if (r.classList.contains("result--ad")) continue;
    const a = r.querySelector(".result__a");
    const url = ddgTarget(a?.getAttribute("href"));
    if (!a || !url) continue;
    out.push({ title: clean(a.text), url, snippet: snippet(clean(r.querySelector(".result__snippet")?.text)) });
  }
  return out;
}

async function duckduckgo(deps: SearchDeps, query: string, count: number): Promise<SearchResult[]> {
  const url = deps.settings.duckduckgoUrl || "https://html.duckduckgo.com/html/";
  const res = await (deps.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": deps.userAgent, accept: "text/html" },
    body: new URLSearchParams({ q: query, b: "" }).toString(),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
  });
  const html = await res.text();
  if (!res.ok && res.status !== 202) throw new Error(`duckduckgo: HTTP ${res.status}`);
  const results = parseDuckDuckGo(html);
  if (!results.length && (res.status === 202 || /anomaly|challenge-form|captcha/i.test(html)) && !/no-results/.test(html)) {
    throw new Error("duckduckgo: it refused the request with a bot check (without a search API key it often does)");
  }
  return results.slice(0, count);
}

/**
 * What the model gets when no provider answered (without a key that is DuckDuckGo, which often refuses automated
 * requests): the same search in the browser, and how the person gets reliable search.
 */
export function searchUnavailable(query: string, reason: string): string {
  const q = encodeURIComponent(query);
  return [
    `Web search failed: ${reason}`,
    `Search in the browser instead, if you have its tools: browser_open https://duckduckgo.com/?q=${q} ` +
      `(or https://www.google.com/search?q=${q}, https://yandex.ru/search/?text=${q}), then browser_get_text.`,
    'For reliable web search, offer the user a free Brave Search API key: show the web plugin\'s setup card (hub_plugin_setup with id "web").',
  ].join("\n");
}

/** Run a search with the configured provider ("auto": first configured of brave → tavily → searxng → duckduckgo). */
export async function webSearch(query: string, count: number, deps: SearchDeps): Promise<{ provider: ProviderId; results: SearchResult[]; skipped: string[] }> {
  const chosen = deps.settings.provider ?? "auto";
  const explicit = chosen !== "auto";
  const order: ProviderId[] = explicit ? [chosen as ProviderId] : PROVIDERS;
  const skipped: string[] = [];
  for (const p of order) {
    try {
      let results: SearchResult[] | undefined;
      if (p === "brave" || p === "tavily") {
        const key = await vaultValue(deps, `${p}_api_key`);
        if (!key) {
          if (explicit) throw new Error(`${p}: no API key — add vault item "${p}_api_key" (field "value") in the security console`);
          continue;
        }
        results = p === "brave" ? await brave(deps, key, query, count) : await tavily(deps, key, query, count);
      } else if (p === "searxng") {
        if (!deps.settings.searxngUrl) {
          if (explicit) throw new Error("searxng: set searxngUrl in the web plugin settings");
          continue;
        }
        results = await searxng(deps, deps.settings.searxngUrl, query, count);
      } else results = await duckduckgo(deps, query, count);
      return { provider: p, results: results.filter((r) => r.url).slice(0, count), skipped };
    } catch (e: any) {
      if (explicit) throw e;
      skipped.push(e?.name === "TimeoutError" ? `${p}: timed out` : String(e?.message ?? e));
    }
  }
  throw new Error(`All search providers failed: ${skipped.join("; ")}`);
}
