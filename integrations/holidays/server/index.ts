// Builtin plugin "holidays": public holidays and long weekends of about 120 countries from Nager.Date (no key).
// Each tool shows the dates as a card in the chat (widget "holidays") and lists them for the model.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { ToolResult } from "@piomio/shared";

interface Settings {
  /** Nager.Date's address (tests point it at a fake). */
  apiUrl?: string;
}

export type HolidaysMode = "upcoming" | "year" | "weekends";

export interface HolidayItem {
  /** YYYY-MM-DD; a long weekend's first day. */
  date: string;
  /** A long weekend's last day. */
  end?: string;
  /** English name. */
  name: string;
  /** The name in the country's language. */
  local?: string;
  /** A long weekend's length in days. */
  days?: number;
  /** Working days to take off to get the long weekend. */
  bridge?: string[];
}

/** What the "holidays" card draws. */
export interface HolidaysCard {
  country: string;
  mode: HolidaysMode;
  year?: number;
  /** The hub's today, for "in 3 days" and greying out the past. */
  today: string;
  items: HolidayItem[];
}

const COUNTRY = /^[A-Z]{2}$/;
const MAX_UPCOMING = 20;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

class HolidaysError extends Error {}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Today in the hub's time zone (the plugin runs with TZ set to it). */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Nager.Date's holidays → the card's items: several regional entries of one day and name are one, and days in a
 * row with the same name (the New Year holidays) are one item from `date` to `end`.
 */
export function toItems(list: any[]): HolidayItem[] {
  const seen = new Set<string>();
  const out: HolidayItem[] = [];
  for (const h of [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const key = `${h.date}|${h.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = out[out.length - 1];
    if (prev && prev.name === String(h.name) && nextDay(prev.end ?? prev.date) === String(h.date)) {
      prev.end = String(h.date);
      continue;
    }
    out.push({ date: String(h.date), name: String(h.name), ...(h.localName && h.localName !== h.name ? { local: String(h.localName) } : {}) });
  }
  return out;
}

/** The card as lines for the model. */
export function describe(card: HolidaysCard): string {
  if (card.mode === "weekends") {
    if (!card.items.length) return `No long weekends in ${card.country} in ${card.year}.`;
    return [
      `Long weekends in ${card.country} in ${card.year}:`,
      ...card.items.map(
        (w) => `${w.date} (${weekday(w.date)}) – ${w.end} (${weekday(w.end!)}): ${w.days} days${w.bridge?.length ? `, if you take ${w.bridge.join(", ")} off` : ""}`,
      ),
    ].join("\n");
  }
  const head = card.mode === "upcoming" ? `Upcoming public holidays in ${card.country} (today is ${card.today}):` : `Public holidays in ${card.country} in ${card.year}:`;
  return [
    head,
    ...card.items.map((h) => {
      const d = daysBetween(card.today, h.date);
      const when = d === 0 ? ", today" : d === 1 ? ", tomorrow" : d > 0 && card.mode === "upcoming" ? `, in ${d} days` : "";
      const span = h.end ? `${h.date} (${weekday(h.date)}) – ${h.end} (${weekday(h.end)})` : `${h.date} (${weekday(h.date)})`;
      return `${span} — ${h.name}${h.local ? ` (${h.local})` : ""}${when}`;
    }),
  ].join("\n");
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const base = () => (settings.apiUrl || "https://date.nager.at").replace(/\/+$/, "");

    async function get(path: string, country: string): Promise<any[]> {
      let res: Response;
      try {
        res = await fetch(base() + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      } catch (e: any) {
        throw new HolidaysError(`Nager.Date is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
      }
      if (res.status === 204 || res.status === 404) throw new HolidaysError(`Nager.Date has no public holidays for ${country}; it covers about 120 countries.`);
      if (!res.ok) throw new HolidaysError(`Nager.Date: HTTP ${res.status}`);
      const body = await res.json().catch(() => []);
      return Array.isArray(body) ? body : [];
    }

    function countryOf(v: unknown): string {
      const c = String(v ?? "").trim().toUpperCase();
      if (!COUNTRY.test(c)) throw new HolidaysError(`"${v}" is not a country code: use ISO 3166-1 alpha-2, like RU, US, DE, KZ.`);
      return c;
    }

    function yearOf(v: unknown, today: string): number {
      if (v === undefined || v === null || v === "") return Number(today.slice(0, 4));
      const y = Math.round(Number(v));
      if (!Number.isFinite(y) || y < 1975 || y > 2075) throw new HolidaysError("year must be between 1975 and 2075.");
      return y;
    }

    const finish = (call: any, card: HolidaysCard) => {
      if (card.items.length) ctx.widgets.show(call, "holidays", card);
      return text(`${describe(card)}${card.items.length ? "\nA card with these dates is shown in the chat: answer briefly, without listing them all again." : ""}`);
    };
    const fail = (e: any) => text(e instanceof HolidaysError ? e.message : `Holidays failed: ${e?.message ?? e}`, true);
    const countryProp = { type: "string", description: "ISO 3166-1 alpha-2 country code: RU, US, DE, KZ… (the user's country unless they ask about another)" };

    ctx.tools.register({
      name: "upcoming",
      effect: "read",
      description:
        "The next public holidays (days off) in a country, shown as a card in the chat with how many days are left. " +
        "Use it for \"when is the next day off\", \"is Monday a holiday\", planning around holidays.",
      inputSchema: {
        type: "object",
        properties: { country: countryProp, count: { type: "integer", minimum: 1, maximum: MAX_UPCOMING, description: "How many (default 5)" } },
        required: ["country"],
      },
      handler: async (input, call) => {
        try {
          const country = countryOf(input.country);
          const today = localToday();
          const count = Math.min(MAX_UPCOMING, Math.max(1, Math.round(Number(input.count) || 5)));
          const items = toItems(await get(`/api/v3/NextPublicHolidays/${country}`, country))
            .filter((h) => (h.end ?? h.date) >= today)
            .slice(0, count);
          return finish(call, { country, mode: "upcoming", today, items });
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.tools.register({
      name: "year",
      effect: "read",
      description: "All public holidays of a country in a year (default: this year), shown as a card in the chat.",
      inputSchema: { type: "object", properties: { country: countryProp, year: { type: "integer", description: "Year (default: this year)" } }, required: ["country"] },
      handler: async (input, call) => {
        try {
          const country = countryOf(input.country);
          const today = localToday();
          const year = yearOf(input.year, today);
          return finish(call, { country, mode: "year", year, today, items: toItems(await get(`/api/v3/PublicHolidays/${year}/${country}`, country)) });
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.tools.register({
      name: "long_weekends",
      effect: "read",
      description:
        "Long weekends in a country in a year (default: this year): runs of 3+ days off from holidays next to weekends, and which working days to take off " +
        "to get one (bridge days). Shown as a card in the chat. Use it for planning trips and vacations.",
      inputSchema: { type: "object", properties: { country: countryProp, year: { type: "integer", description: "Year (default: this year)" } }, required: ["country"] },
      handler: async (input, call) => {
        try {
          const country = countryOf(input.country);
          const today = localToday();
          const year = yearOf(input.year, today);
          const list = await get(`/api/v3/LongWeekend/${year}/${country}`, country);
          const items: HolidayItem[] = list.map((w) => ({
            date: String(w.startDate),
            end: String(w.endDate),
            name: "",
            days: Number(w.dayCount),
            ...(Array.isArray(w.bridgeDays) && w.bridgeDays.length ? { bridge: w.bridgeDays.map((d: unknown) => String(d).slice(0, 10)) } : {}),
          }));
          return finish(call, { country, mode: "weekends", year, today, items });
        } catch (e) {
          return fail(e);
        }
      },
    });
  },
};

export default plugin;
