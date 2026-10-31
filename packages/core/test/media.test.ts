// The hub's image proxy and map tile cache (src/media.ts), without the network: local servers stand in for the web.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressProxy } from "../src/egress.ts";
import { FileCache, MediaError, MediaService, fetchImage, imageContentType, imageFileName, parseImageUrl, parseTile, readWorkspaceImage } from "../src/media.ts";
import { attachmentDisposition, byteRange } from "../src/server/http.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
const egress = new EgressProxy();
const realResolve = (host: string) => egress.resolveTarget(host);

describe("media validation", () => {
  it("accepts only http(s) image addresses with a host and no credentials", () => {
    expect(parseImageUrl("https://upload.wikimedia.org/a b.jpg")?.href).toBe("https://upload.wikimedia.org/a%20b.jpg");
    expect(parseImageUrl("http://example.com/x.png?w=200")).toBeTruthy();
    for (const bad of ["ftp://example.com/x.png", "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AA", "//example.com/x", "https://user:pw@example.com/x", "not a url", "", 42, `https://e.com/${"a".repeat(2100)}`]) {
      expect(parseImageUrl(bad), String(bad).slice(0, 40)).toBeUndefined();
    }
  });

  it("checks tile coordinates against the zoom level", () => {
    expect(parseTile("0", "0", "0.png")).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTile("19", String(2 ** 19 - 1), "7")).toEqual({ z: 19, x: 2 ** 19 - 1, y: 7 });
    for (const [z, x, y] of [["20", "0", "0"], ["-1", "0", "0"], ["1", "2", "0"], ["1", "0", "2"], ["3", "1.5", "0"], ["3", "0x1", "0"], ["a", "0", "0"], ["3", "0", "../0"]]) {
      expect(parseTile(z, x, y), `${z}/${x}/${y}`).toBeUndefined();
    }
  });

  it("takes image media types only", () => {
    expect(imageContentType("image/PNG; charset=binary")).toBe("image/png");
    expect(imageContentType("image/svg+xml")).toBe("image/svg+xml");
    expect(imageContentType("text/html")).toBeUndefined();
    expect(imageContentType(undefined)).toBeUndefined();
  });
});

describe("saving and ranges", () => {
  it("names a downloaded web image after its address, with its type's extension", () => {
    expect(imageFileName("https://upload.wikimedia.org/wiki/Eiffel%20Tower.JPG?w=200", "image/jpeg")).toBe("Eiffel Tower.jpg");
    expect(imageFileName("https://example.com/", "image/png")).toBe("image.png");
    expect(imageFileName("https://example.com/a%3Cb%3E.webp", "image/webp")).toBe("a_b_.webp");
    expect(imageFileName("not a url", "image/gif")).toBe("image.gif");
  });

  it("says a file's name for downloads in ASCII and in UTF-8", () => {
    expect(attachmentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(attachmentDisposition('чек "1".jpg')).toBe(`attachment; filename="___ _1_.jpg"; filename*=UTF-8''${encodeURIComponent('чек "1".jpg')}`);
  });

  it("reads one byte range from a Range header", () => {
    expect(byteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=990-2000", 1000)).toEqual({ start: 990, end: 999 });
    expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 1000)).toBe("unsatisfiable");
    for (const whole of [undefined, "", "bytes=-", "bytes=0-1,5-9", "items=0-1", "bytes=a-b"]) expect(byteRange(whole, 1000), String(whole)).toBeUndefined();
  });
});

describe("fetching images", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/ok.png") res.writeHead(200, { "content-type": "image/png", "x-ua": String(req.headers["user-agent"]) }).end(PNG);
      else if (u.pathname === "/page") res.writeHead(200, { "content-type": "text/html" }).end("<html>");
      else if (u.pathname === "/big") res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.alloc(4096));
      else if (u.pathname === "/hop") res.writeHead(302, { location: `http://public.test:${port}/ok.png` }).end();
      else if (u.pathname === "/to-private") res.writeHead(302, { location: `http://127.0.0.1:${port}/ok.png` }).end();
      else if (u.pathname === "/loop") res.writeHead(302, { location: "/loop" }).end();
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // "public.test" stands for a site on the internet: it is the only name allowed to reach the local server.
  const resolve = async (host: string) => (host === "public.test" ? ["127.0.0.1"] : realResolve(host));
  const opts = { resolve, userAgent: "Piomio/test", maxBytes: 1024, timeoutMs: 5000 };
  const status = async (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof MediaError ? e.status : String(e)));

  it("refuses loopback, private and link-local destinations", async () => {
    for (const u of [`http://127.0.0.1:${port}/ok.png`, `http://localhost:${port}/ok.png`, "http://[::1]/x.png", "http://10.1.2.3/x.png", "http://169.254.169.254/latest/meta-data", "http://192.168.0.10/x.png", "http://[::ffff:127.0.0.1]/x.png"]) {
      expect(await status(fetchImage(new URL(u), { ...opts, resolve: realResolve })), u).toBe(403);
    }
  });

  it("fetches an image, follows checked redirects and refuses the rest", async () => {
    const got = await fetchImage(new URL(`http://public.test:${port}/hop`), opts);
    expect(got).toEqual({ data: PNG, type: "image/png" });
    expect(await status(fetchImage(new URL(`http://public.test:${port}/to-private`), opts))).toBe(403);
    expect(await status(fetchImage(new URL(`http://public.test:${port}/loop`), opts))).toBe(502);
    expect(await status(fetchImage(new URL(`http://public.test:${port}/page`), opts))).toBe(415);
    expect(await status(fetchImage(new URL(`http://public.test:${port}/big`), opts))).toBe(413);
    expect(await status(fetchImage(new URL(`http://public.test:${port}/missing.png`), opts))).toBe(502);
  });

  it("caches images and tiles on disk and serves what it has", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "owl-media-"));
    const svc = new MediaService({ dataDir, version: "9.9.9", resolve, tileUrl: `http://public.test:${port}/ok.png?{z}/{x}/{y}` });
    expect(svc.userAgent).toBe("Piomio/9.9.9 (+https://github.com/legostin/piomio)");
    const url = `http://public.test:${port}/ok.png`;
    expect((await svc.image(url)).data).toEqual(PNG);
    // From the cache now, even with the site gone.
    const offline = new MediaService({ dataDir, version: "9.9.9", resolve: async () => ["127.0.0.1"], tileUrl: "http://public.test:1/{z}/{x}/{y}.png" });
    expect(await offline.image(url)).toEqual({ data: PNG, type: "image/png" });
    expect(await status(offline.image("ftp://x/y.png"))).toBe(400);
    expect(await status(offline.image("http://127.0.0.1/y.png"))).toBe(502);

    expect(await svc.tile("3", "4", "2.png")).toEqual(PNG);
    expect(readFileSync(join(dataDir, "cache", "tiles", "3", "4", "2.png"))).toEqual(PNG);
    expect(await offline.tile("3", "4", "2.png")).toEqual(PNG);
    expect(await status(offline.tile("3", "8", "2.png"))).toBe(400);
    expect(await status(offline.tile("5", "1", "1.png"))).toBe(502);
  });

  it("prunes entries nobody used for a long time", () => {
    const dir = mkdtempSync(join(tmpdir(), "owl-cache-"));
    const cache = new FileCache(dir, 1000);
    cache.put("a/old", "x");
    cache.put("a/new", "y");
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(join(dir, "a", "old"), past, past);
    expect(cache.get("a/old")?.fresh).toBe(false);
    cache.prune();
    expect(existsSync(join(dir, "a", "old"))).toBe(false);
    expect(cache.get("a/new")).toMatchObject({ fresh: true });
  });
});

describe("workspace images", () => {
  it("reads image files under the root only", async () => {
    const root = mkdtempSync(join(tmpdir(), "owl-ws-"));
    mkdirSync(join(root, "agent", "conv"), { recursive: true });
    writeFileSync(join(root, "agent", "conv", "chart.png"), PNG);
    writeFileSync(join(root, "agent", "conv", "notes.txt"), "hi");
    const outside = mkdtempSync(join(tmpdir(), "owl-out-"));
    writeFileSync(join(outside, "secret.png"), PNG);
    symlinkSync(join(outside, "secret.png"), join(root, "agent", "conv", "link.png"));

    expect(await readWorkspaceImage(root, "agent/conv/chart.png")).toEqual({ data: PNG, type: "image/png", name: "chart.png" });
    expect(await readWorkspaceImage(root, "agent/conv/notes.txt")).toBeUndefined();
    expect(await readWorkspaceImage(root, "agent/conv/link.png")).toBeUndefined();
    expect(await readWorkspaceImage(root, "../" + outside.split("/").pop() + "/secret.png")).toBeUndefined();
    expect(await readWorkspaceImage(root, "agent/conv/missing.png")).toBeUndefined();
  });
});
