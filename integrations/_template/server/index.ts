// The integration template (integrations/_template), a complete integration to start from: sunrise, sunset and day
// length for any place from sunrise-sunset.org, no key. sun_times shows a card in the chat (widget "day") and gives
// the model the times as text. A new integration replaces the API and the card and keeps the shape: see SKILL.md.

import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import type { ToolResult } from "@owlbot/shared";

interface Settings {
  /** The API's address (tests point it at a fake). */
  apiUrl?: string;
}

/** What the "day" card draws. Times are local to the place, as "HH:MM". */
export interface DayCard {
  place: string;
  /** "today" or YYYY-MM-DD. */
  date: string;
  sunrise: string;
  sunset: string;
  dayLengthSec: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT = "Owlbot/0.1 (self-hosted personal agent; sun integration)";

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** The date the API takes: YYYY-MM-DD, or "today" when none is given; undefined for anything else. */
export function dateOf(v: unknown): string | undefined {
  const d = String(v ?? "").trim().toLowerCase();
  if (!d || d === "today") return "today";
  return DATE.test(d) ? d : undefined;
}

/** "05:42" from the API's local ISO time ("2026-06-21T05:42:10+01:00"). */
export function clock(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
}

/** "14 h 51 min" for the model (the card says it in the reader's language). */
export function duration(sec: number): string {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const api = () => (settings.apiUrl || "https://api.sunrise-sunset.org").replace(/\/+$/, "");

    ctx.tools.register({
      name: "times",
      effect: "read",
      source: true,
      description:
        "Sunrise, sunset and day length for a place and date, shown to the user as a card in the chat. " +
        "Give the place's coordinates (`lat`, `lon`) and its IANA time zone (`timezone`, e.g. Europe/Lisbon) so the times are local; " +
        "`date` is YYYY-MM-DD (default: today). Then answer briefly: the card shows the times.",
      inputSchema: {
        type: "object",
        properties: {
          place: { type: "string", description: "The place's name, as the user would say it" },
          lat: { type: "number", description: "Latitude in degrees" },
          lon: { type: "number", description: "Longitude in degrees" },
          timezone: { type: "string", description: "IANA time zone of the place, e.g. Europe/Lisbon" },
          date: { type: "string", description: "YYYY-MM-DD (default: today)" },
        },
        required: ["place", "lat", "lon", "timezone"],
      },
      handler: async (input, call) => {
        const lat = Number(input.lat);
        const lon = Number(input.lon);
        if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) return text("lat and lon must be coordinates in degrees.", true);
        const date = dateOf(input.date);
        if (!date) return text("date must be YYYY-MM-DD.", true);
        const timezone = String(input.timezone ?? "").trim() || "UTC";
        const place = String(input.place ?? "").trim() || `${lat}, ${lon}`;

        let body: any;
        try {
          const res = await fetch(`${api()}/json?lat=${lat}&lng=${lon}&date=${date}&formatted=0&tzid=${encodeURIComponent(timezone)}`, {
            headers: { accept: "application/json", "user-agent": USER_AGENT },
            signal: AbortSignal.timeout(15_000),
          });
          body = await res.json().catch(() => undefined);
          if (!res.ok) return text(`sunrise-sunset.org: HTTP ${res.status}`, true);
        } catch (e: any) {
          return text(`sunrise-sunset.org is unreachable (${e?.cause?.code ?? e?.name ?? "network error"}).`, true);
        }
        const r = body?.results;
        if (body?.status !== "OK" || !r?.sunrise || !r?.sunset) return text(`sunrise-sunset.org could not answer: ${body?.status ?? "no data"}.`, true);

        const card: DayCard = { place, date, sunrise: clock(r.sunrise), sunset: clock(r.sunset), dayLengthSec: Number(r.day_length) || 0 };
        ctx.widgets.show(call, "day", card);
        return text(
          `${place}, ${date} (${timezone}): sunrise ${card.sunrise}, sunset ${card.sunset}, day length ${duration(card.dayLengthSec)}. ` +
            "A card with these times is shown in the chat: answer in a sentence, without repeating it.",
        );
      },
    });
  },
};

export default plugin;
