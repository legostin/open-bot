// End-to-end: an agent shows images and a map (core tools show_images / show_map), the web UI gets them as message
// parts, the channels get them as media, and the hub serves them through its own authenticated routes. Routes go to a
// stand-in OSRM server (OWLBOT_ROUTER_URL).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { simplify } from "../src/routing.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("agents show images and maps", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";
  const sent: any[] = [];

  const req = async (method: string, path: string, body?: unknown, auth = true) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        origin: base,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(auth && cookie ? { cookie } : {}),
        ...(auth && csrf ? { "x-csrf": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return r;
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await req(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  };

  /** Send `CALL tool args` and return the assistant reply once it is complete. */
  const call = async (tool: string, args: unknown) => {
    const m = await json("POST", `/api/conversations/${conv}/messages`, { text: `CALL ${tool} ${JSON.stringify(args)}` });
    return until(async () => {
      const msgs: any[] = await json("GET", `/api/conversations/${conv}/messages`);
      const after = msgs.slice(msgs.findIndex((x) => x.id === m.id) + 1);
      return after.find((x) => x.role === "assistant" && x.status === "complete" && x.parts.some((p: any) => p.type === "text" && p.text.startsWith("tool said:")));
    }, `reply to ${tool}`);
  };

  /** The stand-in router: what it was asked, and whether it is down. */
  const asked: string[] = [];
  let routerDown = false;
  let router: Server;

  beforeAll(async () => {
    const [port, consolePort, egressPort, routerPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    router = createHttpServer((req, res) => {
      asked.push(req.url ?? "");
      if (routerDown) {
        res.writeHead(503).end();
        return;
      }
      // Each stop, and a bend half way between each pair: the line the hub stores.
      const pts = /\/driving\/([^?]+)/.exec(req.url ?? "")![1].split(";").map((p) => p.split(",").map(Number));
      const line = pts.flatMap((p, n) => (n ? [[(pts[n - 1][0] + p[0]) / 2 + 0.001, (pts[n - 1][1] + p[1]) / 2], p] : [p]));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: "Ok", routes: [{ distance: 2412.4, duration: 1830.2, geometry: { type: "LineString", coordinates: line } }] }));
    });
    await new Promise<void>((r) => router.listen(routerPort, "127.0.0.1", r));
    const config = loadConfig(
      {
        OWLBOT_PORT: String(port),
        OWLBOT_DEVICES: "0",
        OWLBOT_CONSOLE_PORT: String(consolePort),
        OWLBOT_EGRESS_PORT: String(egressPort),
        OWLBOT_ROUTER_URL: `http://127.0.0.1:${routerPort}`,
        TZ: "UTC",
      },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-media-hub-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    await json("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await json("GET", "/api/bootstrap");
    csrf = boot.csrf;
    conv = boot.mainConversationId;
    // A phone channel: the main agent's replies to web messages are mirrored there.
    hub.channels.register("phone", "Phone", "phone-test", { closed: false, request: async (_m: string, p: any) => (sent.push(p.message), {}) } as any);
    // A chart the agent drew in its workspace.
    const ws = hub.runner.workspacePath({ agentId: "assistant", conversationId: conv });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "chart.png"), PNG);
    writeFileSync(join(ws, "notes.txt"), "not a picture");
  });

  afterAll(async () => {
    await hub?.stop();
    router?.close();
  });

  it("show_images adds a carousel to the reply and sends it to the channels", async () => {
    sent.length = 0;
    const reply = await call("show_images", {
      images: [
        { url: "https://img.example.com/owl.jpg", caption: "  A   barn owl ", alt: "Owl on a branch" },
        { path: "chart.png", caption: "Mice per night" },
      ],
    });
    const result = reply.parts.find((p: any) => p.type === "tool_result");
    expect(result.isError).toBeFalsy();
    expect(result.output).toMatch(/carousel of 2 images/);
    const images = reply.parts.findIndex((p: any) => p.type === "images");
    expect(reply.parts[images]).toEqual({
      type: "images",
      items: [
        { src: "https://img.example.com/owl.jpg", alt: "Owl on a branch", caption: "A barn owl" },
        { src: `file:assistant/${conv}/chart.png`, caption: "Mice per night" },
      ],
    });
    // In the reply where the tool was called: before the words that follow it.
    expect(images).toBeLessThan(reply.parts.findIndex((p: any) => p.type === "text"));

    const out = await until(() => sent.find((m) => m.media), "the mirrored reply with media");
    expect(out.media).toEqual([
      { kind: "image", url: "https://img.example.com/owl.jpg", caption: "A barn owl" },
      { kind: "image", data: PNG.toString("base64"), mimeType: "image/png", name: "chart.png", caption: "Mice per night" },
    ]);

    // The workspace file is served to the signed-in UI only.
    const file = await req("GET", `/api/files?path=${encodeURIComponent(`assistant/${conv}/chart.png`)}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it("show_images refuses files outside the workspace, non-images and bad addresses", async () => {
    const bad = async (images: unknown[]) => (await call("show_images", { images })).parts.find((p: any) => p.type === "tool_result");
    for (const [images, why] of [
      [[{ path: "../../../owlbot.db" }], /outside your workspace|no such file/],
      [[{ path: "notes.txt" }], /not an image/],
      [[{ path: "missing.png" }], /no such file/],
      [[{ url: "ftp://example.com/x.png" }], /public http\(s\) address/],
      [[{ caption: "nothing" }], /give url or path/],
      [Array.from({ length: 11 }, () => ({ url: "https://img.example.com/a.png" })), /At most 10/],
    ] as const) {
      const r = await bad(images as unknown[]);
      expect(r.isError, JSON.stringify(images).slice(0, 60)).toBe(true);
      expect(r.output).toMatch(why);
    }
  });

  it("show_map adds a map with markers and a location for the channels", async () => {
    sent.length = 0;
    const reply = await call("show_map", {
      lat: 48.8584,
      lon: 2.2945,
      title: "Eiffel Tower",
      markers: [
        { lat: 48.8584, lon: 2.2945, label: "Tower" },
        { lat: 48.8606, lon: 2.3376, label: "Louvre" },
      ],
    });
    expect(reply.parts.find((p: any) => p.type === "map")).toEqual({
      type: "map",
      lat: 48.8584,
      lon: 2.2945,
      title: "Eiffel Tower",
      markers: [
        { lat: 48.8584, lon: 2.2945, label: "Tower" },
        { lat: 48.8606, lon: 2.3376, label: "Louvre" },
      ],
    });
    const out = await until(() => sent.find((m) => m.media), "the mirrored reply with the map");
    expect(out.media).toEqual([{ kind: "map", lat: 48.8584, lon: 2.2945, title: "Eiffel Tower" }]);

    const bad = (await call("show_map", { lat: 91, lon: 0 })).parts.find((p: any) => p.type === "tool_result");
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/lat must be a number from -90 to 90/);
    const zoom = (await call("show_map", { lat: 1, lon: 2, zoom: 25 })).parts.find((p: any) => p.type === "tool_result");
    expect(zoom.output).toMatch(/zoom must be a number from 1 to 19/);
  });

  it("show_map draws places with symbols and a route along roads, with its length and time", async () => {
    asked.length = 0;
    const reply = await call("show_map", {
      title: "Evening walk",
      markers: [
        { lat: 43.2567, lon: 76.9286, label: "Hotel Kazakhstan", icon: "hotel", note: "Dostyk Ave 52" },
        { lat: 43.2389, lon: 76.9455, label: "Kok-Tobe", icon: "sight" },
        { lat: 43.25, lon: 76.95, label: "Coffee", icon: "cafe" },
      ],
      route: { mode: "walk", stops: [0, 2, 1] },
    });
    const map = reply.parts.find((p: any) => p.type === "map");
    expect(map).toMatchObject({ title: "Evening walk", lat: 43.2478, lon: 76.9393, route: { mode: "walk", stops: [0, 2, 1], distanceM: 2412, durationS: 1830 } });
    expect(map.markers[0]).toEqual({ lat: 43.2567, lon: 76.9286, label: "Hotel Kazakhstan", note: "Dostyk Ave 52", icon: "hotel" });
    // Asked for the foot profile, lon,lat in stop order; the line has the bends between the stops, as [lat, lon].
    expect(asked).toEqual(["/routed-foot/route/v1/driving/76.9286,43.2567;76.95,43.25;76.9455,43.2389?overview=full&geometries=geojson"]);
    expect(map.route.path).toHaveLength(5);
    expect(map.route.path[0]).toEqual([43.2567, 76.9286]);
    expect(reply.parts.find((p: any) => p.type === "tool_result").output).toMatch(/Route: 2\.4 km, about 31 min\.$/);
  });

  it("show_map draws transit, and a route the router could not find, straight between the stops", async () => {
    asked.length = 0;
    const markers = [
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
    ];
    const transit = (await call("show_map", { markers, route: { mode: "transit" } })).parts.find((p: any) => p.type === "map");
    expect(transit.route).toEqual({ mode: "transit", stops: [0, 1], path: [[1, 2], [3, 4]] });
    expect(asked).toEqual([]);

    routerDown = true;
    try {
      const r = await call("show_map", { markers, route: { mode: "drive" } });
      expect(r.parts.find((p: any) => p.type === "map").route).toEqual({ mode: "drive", stops: [0, 1], path: [[1, 2], [3, 4]] });
      expect(r.parts.find((p: any) => p.type === "tool_result").output).toMatch(/No road route \(the router answered 503\): the line is straight between the stops\.$/);
    } finally {
      routerDown = false;
    }
    for (const [args, why] of [
      [{ markers, route: { mode: "fly" } }, /route\.mode must be walk, drive, bike or transit/],
      [{ markers, route: { mode: "walk", stops: [0, 5] } }, /route\.stops are marker indexes from 0 to 1/],
      [{ markers: [markers[0]], route: { mode: "walk" } }, /at least two markers/],
      [{ markers: [{ lat: 1, lon: 2, icon: "dragon" }] }, /markers\[0\]\.icon must be one of: pin, food/],
      [{ title: "nowhere" }, /Give lat and lon, or markers/],
    ] as const) {
      const out = (await call("show_map", args)).parts.find((p: any) => p.type === "tool_result");
      expect(out.isError, JSON.stringify(args)).toBe(true);
      expect(out.output).toMatch(why);
    }
  });

  it("keeps a long route line short enough for a message, ends included", () => {
    const wiggly = Array.from({ length: 5000 }, (_, n) => [43 + n * 0.0001, 76 + Math.sin(n / 3) * 0.0005] as [number, number]);
    const short = simplify(wiggly, 400);
    expect(short.length).toBeLessThanOrEqual(400);
    expect(short.length).toBeGreaterThan(50);
    expect(short[0]).toEqual(wiggly[0]);
    expect(short.at(-1)).toEqual(wiggly.at(-1));
  });

  it("serves proxied images and map tiles to the signed-in UI, with checks", async () => {
    // What the proxy fetched before (no network in tests): the cache answers.
    const url = "https://img.example.com/owl.jpg";
    const key = createHash("sha256").update(url).digest("hex");
    const mediaDir = join(hub.config.dataDir, "cache", "media");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, key), PNG);
    writeFileSync(join(mediaDir, `${key}.type`), "image/png");
    const tileDir = join(hub.config.dataDir, "cache", "tiles", "3", "4");
    mkdirSync(tileDir, { recursive: true });
    writeFileSync(join(tileDir, "2.png"), PNG);

    const img = await req("GET", `/api/media?url=${encodeURIComponent(url)}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
    const tile = await req("GET", "/api/map/tiles/3/4/2.png");
    expect(tile.status).toBe(200);
    expect(Buffer.from(await tile.arrayBuffer())).toEqual(PNG);

    expect((await req("GET", `/api/media?url=${encodeURIComponent(url)}`, undefined, false)).status).toBe(401);
    expect((await req("GET", "/api/map/tiles/3/4/2.png", undefined, false)).status).toBe(401);
    expect((await req("GET", "/api/media?url=ftp%3A%2F%2Fexample.com%2Fa.png")).status).toBe(400);
    expect((await req("GET", "/api/media")).status).toBe(400);
    const priv = await req("GET", `/api/media?url=${encodeURIComponent("http://127.0.0.1:1/x.png")}`);
    expect(priv.status).toBe(403);
    expect((await priv.json()).error).toBe("This image address points into a private network");
    for (const p of ["20/0/0.png", "3/8/0.png", "3/0/8.png", "x/0/0.png", "3/4/2.jpg"]) {
      expect((await req("GET", `/api/map/tiles/${p}`)).status, p).toBe(400);
    }
  });
});
