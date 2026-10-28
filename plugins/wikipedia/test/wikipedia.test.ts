// The Wikipedia plugin against a fake wiki: search, the article card, falling back to the best search match,
// disambiguation pages and the full text.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { leadImage, plain, type ArticleCard } from "../server/index.ts";

const dir = join(import.meta.dirname, "..");

function fakeWiki() {
  const requests: Array<{ path: string; agent?: string }> = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const path = decodeURIComponent(u.pathname);
    requests.push({ path: path + u.search, agent: req.headers["user-agent"] });
    const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    // "/<lang>/…": the wiki of that language.
    const [, lang, ...rest] = path.split("/");
    const p = "/" + rest.join("/");
    if (p === "/w/rest.php/v1/search/page") {
      const q = u.searchParams.get("q");
      if (q === "nothing") return send(200, { pages: [] });
      return send(200, {
        pages: [{ key: "Lisbon", title: "Lisbon", description: "Capital of Portugal", excerpt: '<span class="searchmatch">Lisbon</span> is the capital &amp; largest city' }],
      });
    }
    if (p === "/api/rest_v1/page/summary/Lisbon")
      return send(200, {
        type: "standard",
        title: "Lisbon",
        description: "Capital of Portugal",
        extract: "Lisbon is the capital and largest city of Portugal.",
        thumbnail: { source: "https://upload.wikimedia.org/lisbon.jpg", width: 330, height: 171 },
        content_urls: { desktop: { page: `https://${lang}.wikipedia.org/wiki/Lisbon` } },
      });
    if (p === "/api/rest_v1/page/summary/Mercury")
      return send(200, { type: "disambiguation", title: "Mercury", extract: "Mercury may refer to: a planet, an element, a god." });
    if (p.startsWith("/api/rest_v1/page/summary/")) return send(404, { title: "Not found." });
    if (p === "/w/api.php") return send(200, { query: { pages: [{ title: "Lisbon", extract: "Lisbon is the capital.\n\nHistory\nPhoenicians…" }] } });
    send(404, {});
  });
  return { server, requests };
}

describe("wikipedia plugin", () => {
  let api: ReturnType<typeof fakeWiki>;
  let h: PluginHarness;

  beforeAll(async () => {
    api = fakeWiki();
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({ dir, settings: { wikiUrl: `http://127.0.0.1:${(api.server.address() as any).port}/{lang}` }, locale: "ru" });
  });

  afterAll(async () => {
    await h?.stop();
    api?.server.close();
  });

  it("strips the search markup", () => {
    expect(plain('<span class="searchmatch">Lisbon</span> &amp; <b>Porto</b>')).toBe("Lisbon & Porto");
  });

  it("takes a sharp lead picture for the card", () => {
    const thumb = { source: "https://upload.wikimedia.org/x/thumb/a/ab/L.jpg/330px-L.jpg", width: 330, height: 165 };
    expect(leadImage({ thumbnail: thumb, originalimage: { source: "https://upload.wikimedia.org/x/a/ab/L.jpg", width: 4000, height: 2000 } })).toEqual({
      src: "https://upload.wikimedia.org/x/thumb/a/ab/L.jpg/960px-L.jpg",
      width: 960,
      height: 480,
    });
    expect(leadImage({ thumbnail: thumb, originalimage: { source: "https://upload.wikimedia.org/x/a/ab/L.jpg", width: 500, height: 250 } })).toEqual({
      src: "https://upload.wikimedia.org/x/a/ab/L.jpg",
      width: 500,
      height: 250,
    });
    expect(leadImage({})).toBeUndefined();
  });

  it("searches in the user's language by default, as a good citizen", async () => {
    const r = await h.invokeText("search", { query: "lisbon" });
    expect(r).toContain("1. Lisbon — Capital of Portugal");
    expect(r).toContain("Lisbon is the capital & largest city");
    expect(r).toContain("https://ru.wikipedia.org/wiki/Lisbon");
    expect(api.requests.at(-1)!.path).toMatch(/^\/ru\/w\/rest\.php/);
    expect(api.requests.at(-1)!.agent).toMatch(/^Owlbot\//);
    expect(await h.invokeText("search", { query: "nothing", lang: "en" })).toBe('Nothing on en.wikipedia.org for "nothing".');
    expect((await h.invoke("search", { query: "x", lang: "not a lang" })).isError).toBe(true);
  });

  it("shows the article card and gives the model its text", async () => {
    const r = await h.invoke("article", { title: "Lisbon", lang: "en" }, { callId: "a1" });
    expect(r.isError).toBeFalsy();
    const w = r._meta!.widgets![0];
    expect(w.kind).toBe("article");
    expect(w.data as ArticleCard).toEqual({
      lang: "en",
      title: "Lisbon",
      description: "Capital of Portugal",
      extract: "Lisbon is the capital and largest city of Portugal.",
      image: { src: "https://upload.wikimedia.org/lisbon.jpg", width: 330, height: 171 },
      url: "https://en.wikipedia.org/wiki/Lisbon",
    });
    const text = r.content.map((c: any) => c.text).join("");
    expect(text).toContain("Lisbon (Capital of Portugal)\nLisbon is the capital and largest city of Portugal.");
    expect(text).not.toContain("Full text");
  });

  it("takes the best search match for a loose title, and the full text when asked", async () => {
    const r = await h.invoke("article", { title: "lisbon city", full: true }, { callId: "a2" });
    expect((r._meta!.widgets![0].data as ArticleCard).title).toBe("Lisbon");
    expect(r.content.map((c: any) => c.text).join("")).toContain("Full text:\nLisbon is the capital.\n\nHistory");
  });

  it("explains disambiguation pages instead of showing a card", async () => {
    const r = await h.invoke("article", { title: "Mercury" }, { callId: "a3" });
    expect(r._meta?.widgets).toBeUndefined();
    expect(r.content.map((c: any) => c.text).join("")).toContain("is a disambiguation page");
  });
});
