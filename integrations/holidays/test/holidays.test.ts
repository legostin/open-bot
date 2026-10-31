// The holidays plugin against a fake Nager.Date: upcoming holidays, a year, long weekends, unknown countries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { describe as describeCard, localToday, toItems, type HolidaysCard } from "../server/index.ts";

const dir = join(import.meta.dirname, "..");
const today = localToday();
const plus = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function fakeNager() {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url!);
    const send = (status: number, v?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(v === undefined ? "" : JSON.stringify(v));
    if (req.url === "/api/v3/NextPublicHolidays/RU")
      return send(200, [
        { date: plus(1), localName: "День народного единства", name: "Unity Day", countryCode: "RU" },
        { date: plus(58), localName: "Новый год", name: "New Year's Day", countryCode: "RU" },
        { date: plus(58), localName: "Новый год", name: "New Year's Day", countryCode: "RU", counties: ["RU-MOW"] },
      ]);
    if (req.url === "/api/v3/PublicHolidays/2027/DE")
      return send(200, [
        { date: "2027-01-01", localName: "Neujahr", name: "New Year's Day" },
        { date: "2027-10-03", localName: "Tag der Deutschen Einheit", name: "German Unity Day" },
      ]);
    if (req.url === "/api/v3/LongWeekend/2027/DE")
      return send(200, [
        { startDate: "2027-01-01", endDate: "2027-01-03", dayCount: 3, needBridgeDay: false, bridgeDays: [] },
        { startDate: "2027-05-13", endDate: "2027-05-16", dayCount: 4, needBridgeDay: true, bridgeDays: ["2027-05-14"] },
      ]);
    if (req.url?.includes("/AE")) return send(204);
    send(404, { title: "Unknown country code" });
  });
  return { server, requests };
}

describe("holidays plugin", () => {
  let api: ReturnType<typeof fakeNager>;
  let h: PluginHarness;

  beforeAll(async () => {
    api = fakeNager();
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({ dir, settings: { apiUrl: `http://127.0.0.1:${(api.server.address() as any).port}` } });
  });

  afterAll(async () => {
    await h?.stop();
    api?.server.close();
  });

  it("merges a holiday listed per region, and days in a row with one name", () => {
    expect(toItems([{ date: "2027-01-01", name: "A", localName: "A" }, { date: "2027-01-01", name: "A", localName: "A" }])).toEqual([{ date: "2027-01-01", name: "A" }]);
    const items = toItems([
      { date: "2027-01-03", name: "New Year holiday", localName: "Новогодние каникулы" },
      { date: "2027-01-01", name: "New Year's Day", localName: "Новый год" },
      { date: "2027-01-02", name: "New Year holiday", localName: "Новогодние каникулы" },
      { date: "2027-01-04", name: "New Year holiday", localName: "Новогодние каникулы" },
      { date: "2027-01-07", name: "Christmas", localName: "Рождество" },
    ]);
    expect(items).toEqual([
      { date: "2027-01-01", name: "New Year's Day", local: "Новый год" },
      { date: "2027-01-02", end: "2027-01-04", name: "New Year holiday", local: "Новогодние каникулы" },
      { date: "2027-01-07", name: "Christmas", local: "Рождество" },
    ]);
    expect(describeCard({ country: "RU", mode: "year", year: 2027, today: "2026-12-01", items })).toContain("2027-01-02 (Sat) – 2027-01-04 (Mon) — New Year holiday (Новогодние каникулы)");
  });

  it("shows the next holidays with how soon they are", async () => {
    const r = await h.invoke("upcoming", { country: "ru", count: 5 }, { callId: "h1" });
    const card = r._meta!.widgets![0].data as HolidaysCard;
    expect(r._meta!.widgets![0].kind).toBe("holidays");
    expect(card).toMatchObject({ country: "RU", mode: "upcoming", today });
    expect(card.items).toEqual([
      { date: plus(1), name: "Unity Day", local: "День народного единства" },
      { date: plus(58), name: "New Year's Day", local: "Новый год" },
    ]);
    const text = r.content.map((c: any) => c.text).join("");
    expect(text).toContain(`Unity Day (День народного единства), tomorrow`);
    expect(text).toContain(`New Year's Day (Новый год), in 58 days`);
  });

  it("lists a year and its long weekends with the days to take off", async () => {
    const year = await h.invoke("year", { country: "DE", year: 2027 }, { callId: "h2" });
    expect((year._meta!.widgets![0].data as HolidaysCard).items).toHaveLength(2);
    expect(year.content.map((c: any) => c.text).join("")).toContain("2027-10-03 (Sun) — German Unity Day (Tag der Deutschen Einheit)");

    const weekends = await h.invoke("long_weekends", { country: "DE", year: 2027 }, { callId: "h3" });
    const card = weekends._meta!.widgets![0].data as HolidaysCard;
    expect(card.items[1]).toEqual({ date: "2027-05-13", end: "2027-05-16", name: "", days: 4, bridge: ["2027-05-14"] });
    expect(describeCard(card)).toContain("2027-05-13 (Thu) – 2027-05-16 (Sun): 4 days, if you take 2027-05-14 off");
  });

  it("says when a country is unknown or not covered", async () => {
    const bad = await h.invoke("upcoming", { country: "Russia" }, { callId: "h4" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ text: expect.stringContaining("ISO 3166-1 alpha-2") });
    const none = await h.invoke("upcoming", { country: "AE" }, { callId: "h5" });
    expect(none.isError).toBe(true);
    expect(none.content[0]).toMatchObject({ text: expect.stringContaining("no public holidays for AE") });
    expect(none._meta?.widgets).toBeUndefined();
  });
});
