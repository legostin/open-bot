import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { isPrivateAddress } from "../server/ssrf.ts";
import { guardedFetch } from "../server/fetch.ts";
import { parseDuckDuckGo } from "../server/search.ts";

const DIR = join(import.meta.dirname, "..");
const DDG_HTML = readFileSync(join(import.meta.dirname, "fixtures", "duckduckgo.html"), "utf8");

const ARTICLE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Growing Tomatoes &amp; Peppers</title>
<style>body { color: red }</style><script>window.tracking = "<p>not content</p>";</script></head>
<body>
  <header class="site-header"><a href="/">Garden Blog</a><nav><a href="/about">About</a><a href="/shop">Shop</a></nav></header>
  <div class="layout">
    <aside class="sidebar"><h3>Popular</h3><p>Ten best shovels of the year, ranked by our editors and readers.</p></aside>
    <main>
      <article>
        <h1>Growing tomatoes</h1>
        <p>Tomatoes need <strong>full sun</strong>, warm soil and steady watering; see the <a href="/guides/soil?x=1">soil guide</a> for details.</p>
        <h2>Varieties</h2>
        <ul><li>Cherry</li><li>Beefsteak<ul><li>Brandywine</li></ul></li></ul>
        <pre><code class="language-sh">water --daily --ml=500</code></pre>
        <table><tr><th>Plant</th><th>Days</th></tr><tr><td>Cherry</td><td>60</td></tr></table>
        <div class="share-buttons">Share on social</div>
        <div style="display: none">Hidden promo text</div>
      </article>
    </main>
  </div>
  <footer>© 2026 Garden Blog. All rights reserved.</footer>
</body></html>`;

let server: http.Server;
let base = "";
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, "http://x");
      const html = (s: string, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(s);
      switch (u.pathname) {
        case "/article":
          return html(ARTICLE);
        case "/long":
          return html(`<html><head><title>Long</title></head><body><main>${"<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>".repeat(500)}</main></body></html>`);
        case "/r1":
          return res.writeHead(302, { location: "/r2" }).end();
        case "/r2":
          return res.writeHead(301, { location: `${base}/article` }).end();
        case "/loop":
          return res.writeHead(307, { location: "/loop" }).end();
        case "/to-file":
          return res.writeHead(302, { location: "file:///etc/passwd" }).end();
        case "/json":
          return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1,"b":[true,null]}');
        case "/text":
          return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("plain text body");
        case "/image":
          return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
        case "/cp1251": {
          // "Привет" in windows-1251, declared only in a <meta> tag.
          const bytes = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1251"><title>T</title></head><body><p>'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from("</p></body></html>")]);
          return res.writeHead(200, { "content-type": "text/html" }).end(bytes);
        }
        case "/missing":
          return html("<html><head><title>Not found</title></head><body><p>No such page.</p></body></html>", 404);
        case "/searx/search":
          return res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              query: u.searchParams.get("q"),
              results: [
                { title: "SearX one", url: "https://one.example/", content: "First   snippet" },
                { title: "SearX two", url: "https://two.example/", content: "Second snippet" },
                { title: "SearX three", url: "https://three.example/", content: "Third" },
              ],
            }),
          );
        case "/res/v1/web/search":
          if (req.headers["x-subscription-token"] !== "brave-test-key") return res.writeHead(401).end("bad key");
          return res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ web: { results: [{ title: "Brave <strong>hit</strong>", url: "https://brave.example/a", description: "Found by <strong>Brave</strong> &amp; friends" }] } }),
          );
        case "/html/":
          return html(DDG_HTML);
        default:
          return html("<p>not found</p>", 404);
      }
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    }),
  );
}

beforeAll(startServer);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("web_fetch", () => {
  let h: PluginHarness;
  beforeAll(async () => {
    h = await startPlugin({ dir: DIR, settings: { allowPrivate: true } });
  });
  afterAll(() => h?.stop());

  it("registers source tools", () => {
    expect(h.tools.get("fetch")).toMatchObject({ effect: "read", source: true });
    expect(h.tools.get("search")).toMatchObject({ effect: "read", source: true });
  });

  it("extracts readable markdown from HTML", async () => {
    const t = await h.invokeText("fetch", { url: `${base}/article` });
    expect(t).toContain("Title: Growing Tomatoes & Peppers");
    expect(t).toContain(`URL: ${base}/article`);
    expect(t).toContain("# Growing tomatoes");
    expect(t).toContain("Tomatoes need **full sun**, warm soil and steady watering; see the [soil guide](" + base + "/guides/soil?x=1) for details.");
    expect(t).toContain("## Varieties");
    expect(t).toContain("- Cherry\n- Beefsteak\n  - Brandywine");
    expect(t).toContain("```sh\nwater --daily --ml=500\n```");
    expect(t).toContain("| Plant | Days |\n| --- | --- |\n| Cherry | 60 |");
    for (const junk of ["window.tracking", "color: red", "About", "Ten best shovels", "All rights reserved", "Share on social", "Hidden promo"]) expect(t).not.toContain(junk);
  });

  it("returns plain text and raw html on request", async () => {
    const text = await h.invokeText("fetch", { url: `${base}/article`, format: "text" });
    expect(text).toContain("Tomatoes need full sun, warm soil");
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");
    const raw = await h.invokeText("fetch", { url: `${base}/article`, format: "html" });
    expect(raw).toContain("<script>window.tracking");
  });

  it("truncates to maxChars", async () => {
    const t = await h.invokeText("fetch", { url: `${base}/long`, maxChars: 500 });
    const content = t.slice(t.indexOf("\n\n") + 2, t.indexOf("\n\n[Truncated"));
    expect(content.length).toBe(500);
    expect(content.startsWith("Lorem ipsum dolor sit amet")).toBe(true);
    expect(t).toMatch(/\[Truncated: showing 500 of \d+ characters\. Call web_fetch again with a larger maxChars to read more\.\]/);
    // Default limit is 20000 characters.
    expect(await h.invokeText("fetch", { url: `${base}/long` })).toMatch(/\[Truncated: showing 20000 of \d+ characters/);
    const full = await h.invokeText("fetch", { url: `${base}/long`, maxChars: 100_000 });
    expect(full).not.toContain("[Truncated");
  });

  it("follows redirects and reports the final URL", async () => {
    const t = await h.invokeText("fetch", { url: `${base}/r1` });
    expect(t).toContain(`URL: ${base}/article`);
    expect(t).toContain(`Redirected from: ${base}/r1`);
    expect(t).toContain("# Growing tomatoes");
    const loop = await h.invoke("fetch", { url: `${base}/loop` });
    expect(loop.isError).toBe(true);
    expect(loop.content[0]).toMatchObject({ text: expect.stringContaining("Too many redirects") });
    const toFile = await h.invokeText("fetch", { url: `${base}/to-file` });
    expect(toFile).toContain("Only http and https URLs are supported");
  });

  it("handles JSON, text, charsets, binary and HTTP errors", async () => {
    expect(await h.invokeText("fetch", { url: `${base}/json` })).toContain('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
    expect(await h.invokeText("fetch", { url: `${base}/text` })).toContain("plain text body");
    expect(await h.invokeText("fetch", { url: `${base}/cp1251` })).toContain("Привет");
    const img = await h.invoke("fetch", { url: `${base}/image` });
    expect(img.isError).toBe(true);
    expect((img.content[0] as any).text).toContain('unsupported content type "image/png"');
    const missing = await h.invoke("fetch", { url: `${base}/missing` });
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as any).text).toContain("Status: HTTP 404");
    expect((missing.content[0] as any).text).toContain("No such page.");
  });

  it("rejects non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,hi", "not a url"]) {
      const r = await h.invoke("fetch", { url });
      expect(r.isError, url).toBe(true);
    }
    expect(await h.invokeText("fetch", { url: "file:///etc/passwd" })).toContain("Only http and https URLs are supported");
  });

  it("blocks private addresses unless allowPrivate is set", async () => {
    h.setSettings({ allowPrivate: false });
    for (const url of [`${base}/article`, `http://localhost:${new URL(base).port}/article`, "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://10.1.2.3/"]) {
      const r = await h.invoke("fetch", { url });
      expect(r.isError, url).toBe(true);
      expect((r.content[0] as any).text, url).toMatch(/private or internal address/);
    }
    h.setSettings({ allowPrivate: true });
    expect(await h.invokeText("fetch", { url: `${base}/article` })).toContain("# Growing tomatoes");
  });
});

describe("SSRF guard", () => {
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:c0a8:101::1", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("checks every redirect target", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: URL) => {
      calls.push(url.href);
      if (url.hostname === "public.example") return new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } });
      if (url.hostname === "hop.example") return new Response(null, { status: 301, headers: { location: "http://127.0.0.1:9/secret" } });
      return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const lookup = async (host: string) => (host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
    await expect(guardedFetch("http://public.example/", { fetchImpl, lookup })).rejects.toThrow(/internal\.example resolves to a private or internal address \(10\.0\.0\.5\)/);
    await expect(guardedFetch("http://hop.example/", { fetchImpl, lookup })).rejects.toThrow(/127\.0\.0\.1/);
    expect(calls).toEqual(["http://public.example/", "http://hop.example/"]);
    const ok = await guardedFetch("http://fine.example/", { fetchImpl, lookup });
    expect(ok.text).toBe("<p>ok</p>");
    // Mixed answers (one public, one private) are refused too.
    await expect(guardedFetch("http://mixed.example/", { fetchImpl, lookup: async () => ["93.184.216.34", "192.168.0.10"] })).rejects.toThrow(/private/);
  });
});

describe("web_search", () => {
  it("parses DuckDuckGo HTML results", () => {
    expect(parseDuckDuckGo(DDG_HTML)).toEqual([
      { title: "Example Docs & Intro", url: "https://example.org/docs/intro?a=1&b=2", snippet: "An introduction to the example documentation — first steps." },
      { title: "Second result", url: "https://second.example.net/page", snippet: "Direct link without a redirect wrapper." },
      { title: "Пример — третий", url: "https://пример.рф/", snippet: "Кириллический домен." },
    ]);
  });

  it("uses SearXNG JSON", async () => {
    const h = await startPlugin({ dir: DIR, settings: { provider: "searxng", searxngUrl: `${base}/searx/` } });
    try {
      const t = await h.invokeText("search", { query: "тест query", count: 2 });
      expect(t).toBe('Search results for "тест query" (provider: searxng):\n\n1. SearX one\n   https://one.example/\n   First snippet\n\n2. SearX two\n   https://two.example/\n   Second snippet');
      const req = seen.filter((s) => s.url.startsWith("/searx/search")).at(-1)!;
      expect(new URL(req.url, "http://x").searchParams.get("format")).toBe("json");
      expect(new URL(req.url, "http://x").searchParams.get("q")).toBe("тест query");
    } finally {
      await h.stop();
    }
  });

  it("uses Brave with the key from the vault, auto picks it first", async () => {
    const h = await startPlugin({ dir: DIR, settings: { provider: "auto", braveBaseUrl: base, searxngUrl: `${base}/searx` }, vault: { brave_api_key: { value: "brave-test-key" } } });
    try {
      const t = await h.invokeText("search", { query: "hello" });
      expect(t).toContain("(provider: brave)");
      expect(t).toContain("1. Brave hit\n   https://brave.example/a\n   Found by Brave & friends");
      const req = seen.filter((s) => s.url.startsWith("/res/v1/web/search")).at(-1)!;
      expect(req.headers["x-subscription-token"]).toBe("brave-test-key");
      expect(new URL(req.url, "http://x").searchParams.get("count")).toBe("8");
    } finally {
      await h.stop();
    }
  });

  it("auto skips providers without keys (missing vault items) and falls back to DuckDuckGo", async () => {
    const h = await startPlugin({ dir: DIR, settings: { duckduckgoUrl: `${base}/html/`, braveBaseUrl: base, tavilyBaseUrl: base } });
    try {
      const t = await h.invokeText("search", { query: "Owlbot test query", count: 2 });
      expect(t).toContain("(provider: duckduckgo)");
      expect(t).toContain("1. Example Docs & Intro\n   https://example.org/docs/intro?a=1&b=2");
      expect(t).toContain("2. Second result");
      expect(t).not.toContain("3.");
      const req = seen.filter((s) => s.url === "/html/").at(-1)!;
      expect(req.method).toBe("POST");
      expect(new URLSearchParams(req.body).get("q")).toBe("Owlbot test query");
      expect(seen.some((s) => s.url.startsWith("/res/v1/web/search") && !s.headers["x-subscription-token"])).toBe(false);
    } finally {
      await h.stop();
    }
  });

  it("an explicit provider without a key is an error", async () => {
    const h = await startPlugin({ dir: DIR, settings: { provider: "brave", braveBaseUrl: base } });
    try {
      const r = await h.invoke("search", { query: "x" });
      expect(r.isError).toBe(true);
      expect((r.content[0] as any).text).toContain('add vault item "brave_api_key"');
    } finally {
      await h.stop();
    }
  });
});
