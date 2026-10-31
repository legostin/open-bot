// The crypto plugin against a fake CoinGecko: tickers to ids (known ones without a search), prices with sparklines,
// the top list, and the free API's rate limit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { thin, type PricesCard } from "../server/index.ts";

const dir = join(import.meta.dirname, "..");

const coin = (id: string, symbol: string, name: string, price: number, rank: number) => ({
  id,
  symbol,
  name,
  image: `https://coin-images.example/${id}.png`,
  current_price: price,
  market_cap_rank: rank,
  price_change_percentage_24h: rank === 1 ? 0.43711 : -2.5,
  price_change_percentage_7d_in_currency: 3.14159,
  sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => price * (1 + i / 1000)) },
});

function fakeGecko() {
  const requests: string[] = [];
  let busy = false;
  const server: Server = createServer((req, res) => {
    requests.push(req.url!);
    const u = new URL(req.url!, "http://x");
    const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (busy) return send(429, { status: { error_code: 429 } });
    if (u.pathname === "/api/v3/search")
      return send(200, {
        coins: [
          { id: "pepe-fake", symbol: "PEPE", name: "Fake Pepe", market_cap_rank: 900 },
          { id: "pepe", symbol: "PEPE", name: "Pepe", market_cap_rank: 30 },
        ],
      });
    if (u.pathname === "/api/v3/coins/markets") {
      const all = [coin("bitcoin", "btc", "Bitcoin", 81283, 1), coin("the-open-network", "ton", "Toncoin", 5.123456, 20), coin("pepe", "pepe", "Pepe", 0.0000123456, 30)];
      const ids = u.searchParams.get("ids");
      return send(200, ids ? all.filter((c) => ids.split(",").includes(c.id)) : all.slice(0, Number(u.searchParams.get("per_page"))));
    }
    send(404, { error: "not found" });
  });
  return { server, requests, setBusy: (b: boolean) => (busy = b) };
}

describe("crypto plugin", () => {
  let api: ReturnType<typeof fakeGecko>;
  let h: PluginHarness;

  beforeAll(async () => {
    api = fakeGecko();
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({ dir, settings: { apiUrl: `http://127.0.0.1:${(api.server.address() as any).port}` } });
  });

  afterAll(async () => {
    await h?.stop();
    api?.server.close();
  });

  it("thins a week of prices to a sparkline, keeping both ends", () => {
    const week = Array.from({ length: 168 }, (_, i) => i);
    const s = thin(week);
    expect(s).toHaveLength(42);
    expect(s[0]).toBe(0);
    expect(s.at(-1)).toBe(167);
  });

  it("prices coins by ticker, in the order asked, searching only unknown tickers", async () => {
    const r = await h.invoke("prices", { coins: ["PEPE", "btc", "TON"], currency: "EUR" }, { callId: "p1" });
    expect(r.isError).toBeFalsy();
    expect(api.requests.filter((u) => u.startsWith("/api/v3/search"))).toEqual(["/api/v3/search?query=pepe"]);
    const markets = api.requests.find((u) => u.startsWith("/api/v3/coins/markets"))!;
    expect(markets).toContain("vs_currency=eur");
    expect(markets).toContain("ids=pepe,bitcoin,the-open-network");
    const card = r._meta!.widgets![0].data as PricesCard;
    expect(card.currency).toBe("eur");
    expect(card.coins.map((c) => c.symbol)).toEqual(["PEPE", "BTC", "TON"]);
    expect(card.coins[1]).toMatchObject({ id: "bitcoin", name: "Bitcoin", rank: 1, price: 81283, change24h: 0.44, change7d: 3.14 });
    expect(card.coins[1].sparkline).toHaveLength(42);
    expect(card.coins[0].price).toBe(0.00001235);
    const text = r.content.map((c: any) => c.text).join("");
    expect(text).toContain("Bitcoin (BTC) #1: 81283 EUR, 24h +0.44%, 7d +3.14%");
    expect(text).toContain("not investment advice");
  });

  it("shows the top coins", async () => {
    const r = await h.invoke("top", { count: 2 }, { callId: "p2" });
    expect((r._meta!.widgets![0].data as PricesCard).coins.map((c) => c.id)).toEqual(["bitcoin", "the-open-network"]);
  });

  it("says when the free API is busy", async () => {
    api.setBusy(true);
    const r = await h.invoke("top", {}, { callId: "p3" });
    api.setBusy(false);
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("try again in a minute") });
  });
});
