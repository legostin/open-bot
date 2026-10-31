// The weather plugin against a fake Open-Meteo: finding the place, the forecast card it shows, the text for the model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import type { ForecastCard } from "../server/index.ts";

const dir = join(import.meta.dirname, "..");

function hours(from: string, n: number): string[] {
  const start = Date.parse(`${from}:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(start + i * 3600_000).toISOString().slice(0, 16));
}

function fakeOpenMeteo() {
  const requests: URL[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    requests.push(u);
    const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (u.pathname === "/v1/search") {
      const name = u.searchParams.get("name");
      if (name === "Paris")
        return send(200, {
          results: [
            { name: "Paris", latitude: 48.85, longitude: 2.35, country: "France", country_code: "FR", admin1: "Île-de-France" },
            { name: "Paris", latitude: 33.66, longitude: -95.55, country: "United States", country_code: "US", admin1: "Texas" },
          ],
        });
      return send(200, {});
    }
    if (u.pathname === "/v1/forecast") {
      const time = hours("2026-10-28T00:00", 72);
      return send(200, {
        timezone: "Europe/Paris",
        current: { time: "2026-10-28T14:45", temperature_2m: 17.4, apparent_temperature: 16.2, relative_humidity_2m: 71, weather_code: 2, wind_speed_10m: 3.6, is_day: 1 },
        hourly: {
          time,
          temperature_2m: time.map((_, i) => 10 + (i % 24) / 2),
          weather_code: time.map((_, i) => (i === 18 ? 61 : 1)),
          precipitation_probability: time.map((_, i) => (i === 18 ? 70 : 5)),
          is_day: time.map((t) => (Number(t.slice(11, 13)) >= 7 && Number(t.slice(11, 13)) < 19 ? 1 : 0)),
        },
        daily: {
          time: ["2026-10-28", "2026-10-29", "2026-10-30"],
          weather_code: [2, 61, 0],
          temperature_2m_max: [19.2, 15.1, 21.0],
          temperature_2m_min: [9.8, 8.4, 11.3],
          precipitation_probability_max: [10, 80, 0],
          sunrise: ["2026-10-28T08:21", "2026-10-29T08:23", "2026-10-30T08:24"],
          sunset: ["2026-10-28T18:19", "2026-10-29T18:17", "2026-10-30T18:15"],
        },
      });
    }
    send(404, { error: true, reason: "not found" });
  });
  return { server, requests };
}

describe("weather plugin", () => {
  let api: ReturnType<typeof fakeOpenMeteo>;
  let h: PluginHarness;

  beforeAll(async () => {
    api = fakeOpenMeteo();
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(api.server.address() as any).port}`;
    h = await startPlugin({ dir, settings: { forecastUrl: base, geocodingUrl: base }, locale: "ru" });
  });

  afterAll(async () => {
    await h?.stop();
    api?.server.close();
  });

  it("registers the forecast tool", () => {
    expect([...h.tools.keys()]).toEqual(["forecast"]);
    expect(h.tools.get("forecast")!.effect).toBe("read");
  });

  it("finds the place in the hub language, shows the card and tells the model the numbers", async () => {
    const r = await h.invoke("forecast", { place: "Paris, Texas", days: 3 }, { callId: "c1" });
    expect(r.isError).toBeFalsy();
    const search = api.requests.find((u) => u.pathname === "/v1/search")!;
    expect(search.searchParams.get("name")).toBe("Paris");
    expect(search.searchParams.get("language")).toBe("ru");
    const forecast = api.requests.find((u) => u.pathname === "/v1/forecast")!;
    expect(forecast.searchParams.get("latitude")).toBe("33.66");
    expect(forecast.searchParams.get("wind_speed_unit")).toBe("ms");

    const widgets = r._meta?.widgets ?? [];
    expect(widgets).toHaveLength(1);
    expect(widgets[0].kind).toBe("forecast");
    const card = widgets[0].data as ForecastCard;
    expect(card.place).toEqual({ name: "Paris", country: "United States", region: "Texas" });
    expect(card.current).toMatchObject({ temp: 17.4, feels: 16.2, code: 2, day: true, humidity: 71 });
    // The next 24 hours start at the current hour.
    expect(card.hourly).toHaveLength(24);
    expect(card.hourly[0].time).toBe("2026-10-28T14:00");
    expect(card.daily.map((d) => d.date)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);

    const text = r.content.map((c: any) => c.text).join("");
    expect(text).toContain("Now: 17.4°C, feels like 16.2°C, partly cloudy, wind 3.6 m/s, humidity 71%");
    expect(text).toContain("2026-10-29: light rain, 8.4…15.1°C, precipitation chance 80%");
    expect(text).toContain("Precipitation likely in the next 24 hours at 18:00 (70%)");
    expect(text).toContain("forecast card");
  });

  it("takes coordinates and a label, in imperial units when set", async () => {
    const base = `http://127.0.0.1:${(api.server.address() as any).port}`;
    h.setSettings({ forecastUrl: base, geocodingUrl: base, units: "imperial" });
    api.requests.length = 0;
    const r = await h.invoke("forecast", { lat: 48.1, lon: 11.6, label: "Home", days: 1 }, { callId: "c2" });
    expect(api.requests.map((u) => u.pathname)).toEqual(["/v1/forecast"]);
    expect(api.requests[0].searchParams.get("temperature_unit")).toBe("fahrenheit");
    const card = r._meta!.widgets![0].data as ForecastCard;
    expect(card.place.name).toBe("Home");
    expect(card.units).toEqual({ temp: "°F", wind: "mph" });
    expect(card.daily).toHaveLength(1);
  });

  it("says when the place is unknown or missing, without a card", async () => {
    const r = await h.invoke("forecast", { place: "Atlantis" }, { callId: "c3" });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining('No place called "Atlantis"') });
    expect(r._meta?.widgets).toBeUndefined();
    expect((await h.invoke("forecast", {}, { callId: "c4" })).isError).toBe(true);
  });
});
