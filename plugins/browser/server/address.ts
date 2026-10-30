// What the address bar's text is: an address to open or words to search for. Pure, shared by the server and the UI
// (which labels its first suggestion "Go to …" or "Search …" with it).

export type SearchEngine = "duckduckgo" | "google" | "yandex" | "bing";

/** Results page of each engine for an already encoded query. */
export const SEARCH_ENGINES: Record<SearchEngine, (encoded: string) => string> = {
  duckduckgo: (q) => `https://duckduckgo.com/?q=${q}`,
  google: (q) => `https://www.google.com/search?q=${q}`,
  yandex: (q) => `https://yandex.ru/search/?text=${q}`,
  bing: (q) => `https://www.bing.com/search?q=${q}`,
};

export function isSearchEngine(v: unknown): v is SearchEngine {
  return typeof v === "string" && Object.hasOwn(SEARCH_ENGINES, v);
}

export function searchUrl(engine: SearchEngine, query: string): string {
  return SEARCH_ENGINES[engine](encodeURIComponent(query.trim()));
}

// A host as people type it: localhost, an IPv4 or [IPv6] address, or labels ending in a letters-only (or punycode)
// top-level domain, then an optional port and path. "1.5" and "v1.2" are words.
const HOST =
  /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[\da-f:.]+\]|([\p{L}\d]([\p{L}\d-]*[\p{L}\d])?\.)+(\p{L}{2,}|xn--[a-z\d-]+))(:\d{1,5})?([/?#]\S*)?$/iu;
/** A single-label host with a port (a machine on the local network): "nas:8080". */
const HOST_PORT = /^[\p{L}\d-]+:\d{1,5}([/?#]\S*)?$/u;

export function addressKind(text: string): "url" | "search" | "empty" {
  const s = text.trim();
  if (!s) return "empty";
  // A scheme says it is an address even with spaces in the path (the URL parser encodes them).
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(s) || /^about:blank$/i.test(s)) return "url";
  if (/\s/.test(s)) return "search";
  return HOST.test(s) || HOST_PORT.test(s) ? "url" : "search";
}
