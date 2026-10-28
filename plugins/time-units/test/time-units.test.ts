// The world clock & units plugin: places to time zones, clocks now and at a converted time, unit conversion.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { cityOf, describe as describeCard, instantOf, offsetMinutes, zoneOf, type ClocksCard } from "../server/index.ts";
import { convert } from "../server/units.ts";

const dir = join(import.meta.dirname, "..");

describe("time zones", () => {
  it("finds zones by IANA name, city, alias or offset", () => {
    expect(zoneOf("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(zoneOf("europe/lisbon")).toBe("Europe/Lisbon");
    expect(zoneOf("Lisbon")).toBe("Europe/Lisbon");
    expect(zoneOf("new york")).toBe("America/New_York");
    expect(zoneOf("San Francisco")).toBe("America/Los_Angeles");
    expect(zoneOf("UTC+3")).toBe("+03:00");
    expect(zoneOf("Atlantis")).toBeUndefined();
    expect(cityOf("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });

  it("knows offsets across a daylight saving change", () => {
    expect(offsetMinutes("Europe/Lisbon", new Date("2026-07-01T12:00:00Z"))).toBe(60);
    expect(offsetMinutes("Europe/Lisbon", new Date("2026-12-01T12:00:00Z"))).toBe(0);
    expect(offsetMinutes("Asia/Kolkata", new Date("2026-12-01T12:00:00Z"))).toBe(330);
    // 15:00 in New York on a summer day is 19:00 UTC; in winter 20:00 UTC.
    expect(instantOf("2026-07-01", "15:00", "America/New_York").toISOString()).toBe("2026-07-01T19:00:00.000Z");
    expect(instantOf("2026-12-01", "15:00", "America/New_York").toISOString()).toBe("2026-12-01T20:00:00.000Z");
  });

  it("describes clocks against the first one", () => {
    const card: ClocksCard = {
      at: "2026-12-01T20:00:00.000Z",
      live: false,
      clocks: [
        { zone: "America/New_York", label: "New York" },
        { zone: "Asia/Tokyo", label: "Tokyo" },
      ],
    };
    expect(describeCard(card)).toBe("New York (America/New_York): Tue 2026-12-01 15:00, UTC-5\nTokyo (Asia/Tokyo): Wed 2026-12-02 05:00, UTC+9, 14 h ahead of New York");
  });
});

describe("units", () => {
  it("converts within a dimension and refuses across", () => {
    expect(convert(10, "mi", "km")).toEqual({ value: 16.09344, from: "mi", to: "km" });
    expect(convert(100, "°F", "celsius")).toMatchObject({ value: 37.77777778, to: "°C" });
    expect(convert(1, "GiB", "MB")).toMatchObject({ value: 1073.741824 });
    expect(convert(2, "cups", "ml")).toMatchObject({ value: 473.176473 });
    expect(convert(1, "kg", "km")).toEqual({ error: "Cannot convert mass (kg) to length (km)." });
    expect(convert(1, "furlong", "m")).toEqual({ error: 'Unknown unit "furlong".' });
  });
});

describe("time-units plugin", () => {
  let h: PluginHarness;
  beforeAll(async () => {
    h = await startPlugin({ dir });
  });
  afterAll(async () => {
    await h?.stop();
  });

  it("exposes its tools", () => {
    expect([...h.tools.keys()].sort()).toEqual(["convert", "now", "units"]);
  });

  it("shows live clocks with the user's labels", async () => {
    const r = await h.invoke("now", { places: ["Tokyo", { zone: "Europe/Moscow", label: "Мама" }, "Narnia"] }, { callId: "t1" });
    const w = r._meta!.widgets![0];
    expect(w.kind).toBe("clocks");
    const card = w.data as ClocksCard;
    expect(card.live).toBe(true);
    expect(card.clocks).toEqual([
      { zone: "Asia/Tokyo", label: "Tokyo" },
      { zone: "Europe/Moscow", label: "Мама" },
    ]);
    expect(r.content.map((c: any) => c.text).join("")).toContain("Unknown places: Narnia");
  });

  it("converts a meeting time between places", async () => {
    const r = await h.invoke("convert", { time: "15:00", date: "2026-12-01", from: "New York", to: ["Asia/Tokyo"] }, { callId: "t2" });
    const card = r._meta!.widgets![0].data as ClocksCard;
    expect(card).toMatchObject({ at: "2026-12-01T20:00:00.000Z", live: false });
    expect(card.clocks.map((c) => c.label)).toEqual(["New York", "Tokyo"]);
    expect((await h.invoke("convert", { time: "25:00", from: "Tokyo", to: ["Lisbon"] })).isError).toBe(true);
  });

  it("converts units in text, without a card", async () => {
    const r = await h.invoke("units", { value: 5, from: "lb", to: "kg" }, { callId: "t3" });
    expect(r.content[0]).toMatchObject({ text: "5 lb = 2.26796185 kg" });
    expect(r._meta?.widgets).toBeUndefined();
  });
});
