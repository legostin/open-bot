// Builtin plugin "weather": forecasts from Open-Meteo (free, no key). weather_forecast finds the place, shows the
// forecast as a card in the chat (widget "forecast": now, the next hours, the days ahead) and gives the model the same
// numbers in a few lines, so it can answer the actual question ("do I need an umbrella?") in a sentence.

import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import type { ToolResult } from "@owlbot/shared";
import { CONDITION_TEXT, conditionOf } from "./codes.ts";

interface Settings {
  units?: "metric" | "imperial";
  /** Open-Meteo's addresses (tests point them at a fake). */
  forecastUrl?: string;
  geocodingUrl?: string;
}

export interface Place {
  name: string;
  country?: string;
  region?: string;
  lat: number;
  lon: number;
}

/** What the "forecast" card draws (all times are the place's local time, ISO without an offset). */
export interface ForecastCard {
  place: { name: string; country?: string; region?: string };
  units: { temp: "°C" | "°F"; wind: "m/s" | "mph" };
  timezone: string;
  current: { time: string; temp: number; feels: number; code: number; day: boolean; wind: number; humidity: number };
  hourly: Array<{ time: string; temp: number; code: number; day: boolean; pop?: number }>;
  daily: Array<{ date: string; code: number; max: number; min: number; pop?: number; sunrise?: string; sunset?: string }>;
}

const MAX_DAYS = 7;
const HOURS = 24;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

class WeatherError extends Error {}

async function getJson<T>(url: URL, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (e: any) {
    throw new WeatherError(`${what} is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
  }
  const body = (await res.json().catch(() => undefined)) as any;
  if (!res.ok) throw new WeatherError(`${what}: ${body?.reason ?? `HTTP ${res.status}`}`);
  return body as T;
}

const round = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);

/** The forecast response → the card (the next HOURS hours from now, `days` days). */
export function toCard(f: any, place: Place, days: number, imperial: boolean): ForecastCard {
  const c = f.current ?? {};
  const now = String(c.time ?? "");
  const h = f.hourly ?? {};
  const times: string[] = Array.isArray(h.time) ? h.time : [];
  // The hour the current conditions fall in, and the hours after it.
  const start = Math.max(0, times.findIndex((t) => t.slice(0, 13) >= now.slice(0, 13)));
  const hourly = times.slice(start, start + HOURS).map((time, i) => ({
    time,
    temp: round(h.temperature_2m?.[start + i]),
    code: Number(h.weather_code?.[start + i] ?? 0),
    day: h.is_day?.[start + i] !== 0,
    ...(typeof h.precipitation_probability?.[start + i] === "number" ? { pop: h.precipitation_probability[start + i] } : {}),
  }));
  const d = f.daily ?? {};
  const daily = (Array.isArray(d.time) ? (d.time as string[]) : []).slice(0, days).map((date, i) => ({
    date,
    code: Number(d.weather_code?.[i] ?? 0),
    max: round(d.temperature_2m_max?.[i]),
    min: round(d.temperature_2m_min?.[i]),
    ...(typeof d.precipitation_probability_max?.[i] === "number" ? { pop: d.precipitation_probability_max[i] } : {}),
    ...(d.sunrise?.[i] ? { sunrise: String(d.sunrise[i]) } : {}),
    ...(d.sunset?.[i] ? { sunset: String(d.sunset[i]) } : {}),
  }));
  return {
    place: { name: place.name, ...(place.country ? { country: place.country } : {}), ...(place.region ? { region: place.region } : {}) },
    units: { temp: imperial ? "°F" : "°C", wind: imperial ? "mph" : "m/s" },
    timezone: String(f.timezone ?? "UTC"),
    current: {
      time: now,
      temp: round(c.temperature_2m),
      feels: round(c.apparent_temperature),
      code: Number(c.weather_code ?? 0),
      day: c.is_day !== 0,
      wind: round(c.wind_speed_10m),
      humidity: Math.round(Number(c.relative_humidity_2m ?? 0)),
    },
    hourly,
    daily,
  };
}

/** The card in a few lines for the model. */
export function describe(card: ForecastCard): string {
  const { temp, wind } = card.units;
  const where = [card.place.name, card.place.region, card.place.country].filter(Boolean).join(", ");
  const cur = card.current;
  const lines = [
    `Weather for ${where} (${card.timezone}), local time ${cur.time.replace("T", " ")}.`,
    `Now: ${cur.temp}${temp}, feels like ${cur.feels}${temp}, ${CONDITION_TEXT[conditionOf(cur.code)]}, wind ${cur.wind} ${wind}, humidity ${cur.humidity}%.`,
  ];
  const wet = card.hourly.filter((h) => (h.pop ?? 0) >= 40);
  if (wet.length) lines.push(`Precipitation likely in the next 24 hours at ${wet.map((h) => `${h.time.slice(11, 16)} (${h.pop}%)`).slice(0, 8).join(", ")}.`);
  for (const d of card.daily) {
    const sun = d.sunrise && d.sunset ? `, sunrise ${d.sunrise.slice(11, 16)}, sunset ${d.sunset.slice(11, 16)}` : "";
    lines.push(`${d.date}: ${CONDITION_TEXT[conditionOf(d.code)]}, ${d.min}…${d.max}${temp}${d.pop !== undefined ? `, precipitation chance ${d.pop}%` : ""}${sun}.`);
  }
  return lines.join("\n");
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const forecastBase = () => (settings.forecastUrl || "https://api.open-meteo.com").replace(/\/+$/, "");
    const geocodingBase = () => (settings.geocodingUrl || "https://geocoding-api.open-meteo.com").replace(/\/+$/, "");

    /** "Lisbon", "Paris, Texas": the best match, its country and region in the hub language. */
    async function findPlace(query: string): Promise<Place> {
      const [name, ...rest] = query.split(",").map((s) => s.trim());
      const hint = rest.join(" ").toLowerCase();
      const url = new URL(geocodingBase() + "/v1/search");
      url.searchParams.set("name", name);
      url.searchParams.set("count", "10");
      url.searchParams.set("language", ctx.i18n.locale());
      url.searchParams.set("format", "json");
      const found = (await getJson<{ results?: any[] }>(url, "Open-Meteo geocoding")).results ?? [];
      const pick = (hint && found.find((r) => [r.country, r.country_code, r.admin1].some((v) => typeof v === "string" && (v.toLowerCase().includes(hint) || hint.includes(v.toLowerCase()))))) || found[0];
      if (!pick) throw new WeatherError(`No place called "${query}" was found. Try the city's name in English, or pass lat/lon.`);
      return { name: pick.name, country: pick.country, region: pick.admin1 && pick.admin1 !== pick.name ? pick.admin1 : undefined, lat: pick.latitude, lon: pick.longitude };
    }

    ctx.tools.register({
      name: "forecast",
      effect: "read",
      description:
        "Weather now, for the next 24 hours and for up to 7 days at a place (Open-Meteo), shown to the user as a forecast card in the chat. " +
        "Give `place` (a city or town, optionally with its country: \"Paris, France\") or `lat`/`lon` (for \"here\", use the user's location if you know it, with `label`). " +
        "Use it whenever the user asks about the weather, what to wear, rain or snow, or plans outdoors. Then answer the question itself in a sentence or two: the card shows the numbers.",
      inputSchema: {
        type: "object",
        properties: {
          place: { type: "string", description: "City or town, e.g. \"Lisbon\" or \"Paris, France\"" },
          lat: { type: "number", description: "Latitude, instead of place" },
          lon: { type: "number", description: "Longitude, instead of place" },
          label: { type: "string", description: "The name to show for lat/lon, e.g. \"Home\"" },
          days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: "Days ahead to show (default 5)" },
        },
      },
      handler: async (input, call) => {
        try {
          const days = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(input.days) || 5)));
          let place: Place;
          if (typeof input.lat === "number" && typeof input.lon === "number") {
            if (Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180) return text("lat must be within ±90 and lon within ±180.", true);
            place = { name: String(input.label || `${input.lat.toFixed(2)}, ${input.lon.toFixed(2)}`), lat: input.lat, lon: input.lon };
          } else if (typeof input.place === "string" && input.place.trim()) {
            place = await findPlace(input.place.trim());
          } else {
            return text("Give a place (city name) or lat and lon.", true);
          }
          const imperial = settings.units === "imperial";
          const url = new URL(forecastBase() + "/v1/forecast");
          const q: Record<string, string> = {
            latitude: String(place.lat),
            longitude: String(place.lon),
            current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
            hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
            daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
            timezone: "auto",
            // One more day than shown: the next 24 hours run into tomorrow.
            forecast_days: String(Math.max(2, days)),
            wind_speed_unit: imperial ? "mph" : "ms",
            temperature_unit: imperial ? "fahrenheit" : "celsius",
          };
          for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
          const card = toCard(await getJson(url, "Open-Meteo"), place, days, imperial);
          ctx.widgets.show(call, "forecast", card);
          return text(`${describe(card)}\n\nA forecast card with these numbers is shown in the chat: answer the user's question in a sentence or two instead of repeating them.`);
        } catch (e: any) {
          return text(e instanceof WeatherError ? e.message : `Weather failed: ${e?.message ?? e}`, true);
        }
      },
    });
  },
};

export default plugin;
