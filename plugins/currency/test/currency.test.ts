// The currency plugin against fake Frankfurter and ExchangeRate-API: ECB rates with history, other currencies
// from the fallback, the card and the text for the model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { describe as describeCard, roundMoney, roundTo, type RatesCard } from "../server/index.ts";

const dir = join(import.meta.dirname, "..");

function fakeRates() {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    requests.push(u.pathname + u.search);
    const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (u.pathname === "/v1/currencies") return send(200, { USD: "United States Dollar", EUR: "Euro", GBP: "British Pound" });
    if (u.pathname === "/v1/latest") return send(200, { amount: 1, base: u.searchParams.get("base"), date: "2026-10-28", rates: { EUR: 0.89823, GBP: 0.75258 } });
    if (u.pathname.startsWith("/v1/2026-")) {
      return send(200, {
        base: "USD",
        rates: { "2026-09-28": { EUR: 0.85, GBP: 0.76 }, "2026-10-15": { EUR: 0.87, GBP: 0.755 }, "2026-10-28": { EUR: 0.89823, GBP: 0.75258 } },
      });
    }
    if (u.pathname === "/v6/latest/USD") return send(200, { result: "success", time_last_update_unix: 1793145751, rates: { RUB: 81.5, EUR: 0.9, KZT: 520.1 } });
    if (u.pathname === "/v6/latest/ZZZ") return send(200, { result: "error", "error-type": "unsupported-code" });
    send(404, {});
  });
  return { server, requests };
}

describe("currency plugin", () => {
  let api: ReturnType<typeof fakeRates>;
  let h: PluginHarness;

  beforeAll(async () => {
    api = fakeRates();
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(api.server.address() as any).port}`;
    h = await startPlugin({ dir, settings: { frankfurterUrl: base, erApiUrl: base } });
  });

  afterAll(async () => {
    await h?.stop();
    api?.server.close();
  });

  it("rounds to what people read", () => {
    expect(roundMoney(89.8234)).toBe(89.82);
    expect(roundTo(89.8234)).toBe(89.8234);
    expect(roundTo(0.898234)).toBe(0.898234);
    expect(roundTo(1.234567)).toBe(1.2346);
  });

  it("converts at ECB rates with the last month's history", async () => {
    const r = await h.invoke("convert", { amount: 100, from: "usd", to: ["eur", "GBP", "USD"] }, { callId: "c1" });
    expect(r.isError).toBeFalsy();
    expect(api.requests).toContain("/v1/latest?base=USD&symbols=EUR,GBP");
    const card = r._meta!.widgets![0].data as RatesCard;
    expect(r._meta!.widgets![0].kind).toBe("rates");
    expect(card).toMatchObject({ amount: 100, from: "USD", date: "2026-10-28", source: "ecb", days: 30 });
    expect(card.rows.map((x) => x.code)).toEqual(["EUR", "GBP"]);
    expect(card.rows[0]).toMatchObject({ rate: 0.89823, value: 89.82, history: [0.85, 0.87, 0.89823] });
    expect(card.rows[0].change).toBeCloseTo(5.67, 2);
    const text = r.content.map((c: any) => c.text).join("");
    expect(text).toContain("100 USD = 89.82 EUR (1 USD = 0.89823 EUR; 30 days: +5.67%)");
    expect(text).toContain("European Central Bank reference rates of 2026-10-28");
  });

  it("takes currencies the ECB does not publish from ExchangeRate-API, without history", async () => {
    const r = await h.invoke("convert", { amount: 2, from: "USD", to: ["RUB", "KZT"] }, { callId: "c2" });
    const card = r._meta!.widgets![0].data as RatesCard;
    expect(card).toMatchObject({ source: "exchangerate-api", days: 0 });
    expect(card.rows).toEqual([
      { code: "RUB", rate: 81.5, value: 163 },
      { code: "KZT", rate: 520.1, value: 1040.2 },
    ]);
    expect(describeCard(card)).toContain("Source: ExchangeRate-API rates of");
  });

  it("refuses what is not a currency, without a card", async () => {
    const bad = await h.invoke("convert", { from: "dollars", to: ["EUR"] }, { callId: "c3" });
    expect(bad.isError).toBe(true);
    expect(bad._meta?.widgets).toBeUndefined();
    const unknown = await h.invoke("convert", { from: "ZZZ", to: ["EUR"] }, { callId: "c4" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]).toMatchObject({ text: "ExchangeRate-API: no rates for ZZZ" });
  });
});
