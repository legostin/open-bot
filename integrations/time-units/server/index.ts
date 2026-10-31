// Builtin plugin "time-units": world clocks, time zone conversion and unit conversion, all local (no network).
// time_now and time_convert show clocks as a card in the chat (widget "clocks": live for now, fixed for a converted
// time); time_units answers in text, where a card would add nothing.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { ToolResult } from "@piomio/shared";
import { convert } from "./units.ts";

export interface Clock {
  zone: string;
  label: string;
}

/** What the "clocks" card draws. */
export interface ClocksCard {
  /** The instant shown (ISO); with `live` the card runs on from the viewer's clock instead. */
  at: string;
  live: boolean;
  clocks: Clock[];
}

const MAX_CLOCKS = 8;

/** Cities people name that are not in a zone's name. */
const ALIASES: Record<string, string> = {
  "saint petersburg": "Europe/Moscow",
  "st petersburg": "Europe/Moscow",
  petersburg: "Europe/Moscow",
  "san francisco": "America/Los_Angeles",
  "silicon valley": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  washington: "America/New_York",
  boston: "America/New_York",
  miami: "America/New_York",
  atlanta: "America/New_York",
  beijing: "Asia/Shanghai",
  shenzhen: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  delhi: "Asia/Kolkata",
  "new delhi": "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  bangalore: "Asia/Kolkata",
  kiev: "Europe/Kyiv",
  kyiv: "Europe/Kyiv",
  astana: "Asia/Almaty",
  "nur-sultan": "Asia/Almaty",
  minsk: "Europe/Minsk",
  tbilisi: "Asia/Tbilisi",
  yerevan: "Asia/Yerevan",
  "ho chi minh": "Asia/Ho_Chi_Minh",
  saigon: "Asia/Ho_Chi_Minh",
  bali: "Asia/Makassar",
  phuket: "Asia/Bangkok",
  barcelona: "Europe/Madrid",
  munich: "Europe/Berlin",
  milan: "Europe/Rome",
  "tel aviv": "Asia/Jerusalem",
  sochi: "Europe/Moscow",
  kazan: "Europe/Moscow",
  novosibirsk: "Asia/Novosibirsk",
  ekaterinburg: "Asia/Yekaterinburg",
  yekaterinburg: "Asia/Yekaterinburg",
  vladivostok: "Asia/Vladivostok",
  utc: "UTC",
  gmt: "UTC",
};

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

const zones = (() => {
  let list: string[] | undefined;
  return () => (list ??= Intl.supportedValuesOf("timeZone"));
})();

/** "Europe/Lisbon", "Lisbon", "new york", "UTC+3" → an IANA zone (or a fixed offset), or undefined. */
export function zoneOf(q: string): string | undefined {
  const s = q.trim();
  if (!s) return undefined;
  const offset = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (offset) return `${offset[1]}${offset[2].padStart(2, "0")}:${offset[3] ?? "00"}`;
  if (s.includes("/") && validZone(s)) return zones().find((z) => z.toLowerCase() === s.toLowerCase()) ?? s;
  const key = s.toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  if (ALIASES[key]) return ALIASES[key];
  const city = key.replace(/ /g, "_");
  return zones().find((z) => z.toLowerCase().split("/").pop() === city);
}

/** "Europe/Lisbon" → "Lisbon"; "America/Argentina/Buenos_Aires" → "Buenos Aires"; "+03:00" → "UTC+03:00". */
export function cityOf(zone: string): string {
  if (/^[+-]\d{2}:\d{2}$/.test(zone)) return `UTC${zone}`;
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** Minutes the zone is ahead of UTC at `at`. */
export function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time in a zone is ("2026-10-30", "15:00", "Europe/Lisbon"). */
export function instantOf(date: string, time: string, zone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Twice: the offset at the guess may differ from the offset at the answer around a DST change.
  let at = new Date(guess - offsetMinutes(zone, new Date(guess)) * 60_000);
  at = new Date(guess - offsetMinutes(zone, at) * 60_000);
  return at;
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

/** "Wed 2026-10-28 21:45" in the zone. */
function wall(zone: string, at: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function describe(card: ClocksCard): string {
  const at = new Date(card.at);
  const base = offsetMinutes(card.clocks[0].zone, at);
  return card.clocks
    .map((c, i) => {
      const off = offsetMinutes(c.zone, at);
      const diff = (off - base) / 60;
      const rel = i === 0 || diff === 0 ? "" : `, ${Math.abs(diff)} h ${diff > 0 ? "ahead of" : "behind"} ${card.clocks[0].label}`;
      return `${c.label} (${c.zone}): ${wall(c.zone, at)}, ${fmtOffset(off)}${rel}`;
    })
    .join("\n");
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    function clocksOf(list: unknown): { clocks: Clock[]; unknown: string[] } {
      const items = (Array.isArray(list) ? list : [list]).slice(0, MAX_CLOCKS);
      const clocks: Clock[] = [];
      const unknown: string[] = [];
      for (const it of items) {
        const q = typeof it === "string" ? it : String((it as any)?.zone ?? (it as any)?.place ?? "");
        const zone = zoneOf(q);
        if (!zone) {
          if (q) unknown.push(q);
          continue;
        }
        const label = typeof it === "object" && it && (it as any).label ? String((it as any).label) : q.includes("/") || /^(utc|gmt)/i.test(q) ? cityOf(zone) : q.trim();
        clocks.push({ zone, label });
      }
      return { clocks, unknown };
    }
    const unknownNote = (u: string[]) => (u.length ? `\nUnknown places: ${u.join(", ")} (use IANA time zone names like Europe/Lisbon).` : "");
    const placeSchema = {
      type: "array",
      items: {
        anyOf: [
          { type: "string" },
          { type: "object", properties: { zone: { type: "string" }, label: { type: "string" } }, required: ["zone"] },
        ],
      },
    };

    ctx.tools.register({
      name: "now",
      effect: "read",
      description:
        "What time it is now in one or more places, shown as live world clocks in the chat. `places`: IANA time zones (Europe/Lisbon, America/New_York) " +
        "or big cities' names in English; an item can be {zone, label} to name it in the user's language (\"Мама\", \"Office\"). " +
        "Use it for \"what time is it in…\", calls across time zones, or when the user mentions people abroad.",
      inputSchema: { type: "object", properties: { places: { ...placeSchema, description: `1–${MAX_CLOCKS} places` } }, required: ["places"] },
      handler: async (input, call) => {
        const { clocks, unknown } = clocksOf(input.places);
        if (!clocks.length) return text(`No known places.${unknownNote(unknown)}`, true);
        const card: ClocksCard = { at: new Date().toISOString(), live: true, clocks };
        ctx.widgets.show(call, "clocks", card);
        return text(`${describe(card)}${unknownNote(unknown)}\nLive clocks are shown in the chat.`);
      },
    });

    ctx.tools.register({
      name: "convert",
      effect: "read",
      description:
        "Convert a time from one place's time zone to others (\"15:00 in Lisbon is what in Almaty?\"), shown as clocks at that moment in the chat. " +
        "`time` HH:MM (24-hour), `date` YYYY-MM-DD (default: today there), `from` and `to` as in time_now.",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "string", description: "HH:MM, 24-hour" },
          date: { type: "string", description: "YYYY-MM-DD (default: today in `from`)" },
          from: { type: "string", description: "Where that time is: IANA zone or city" },
          to: { ...placeSchema, description: "Where to show it" },
        },
        required: ["time", "from", "to"],
      },
      handler: async (input, call) => {
        const time = String(input.time ?? "").trim();
        if (!/^\d{1,2}:\d{2}$/.test(time) || Number(time.split(":")[0]) > 23 || Number(time.split(":")[1]) > 59) return text("time must be HH:MM, 24-hour.", true);
        const fromZone = zoneOf(String(input.from ?? ""));
        if (!fromZone) return text(`Unknown place "${input.from}": use an IANA time zone like Europe/Lisbon.`, true);
        const date = input.date ? String(input.date) : wall(fromZone, new Date()).slice(4, 14);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return text("date must be YYYY-MM-DD.", true);
        const from = clocksOf([typeof input.from === "string" && !input.from.includes("/") ? input.from : { zone: fromZone, label: cityOf(fromZone) }]).clocks[0];
        const { clocks, unknown } = clocksOf(input.to);
        if (!clocks.length) return text(`No known places to convert to.${unknownNote(unknown)}`, true);
        const card: ClocksCard = { at: instantOf(date, time, fromZone).toISOString(), live: false, clocks: [from, ...clocks.filter((c) => c.zone !== from.zone || c.label !== from.label)] };
        ctx.widgets.show(call, "clocks", card);
        return text(`${describe(card)}${unknownNote(unknown)}\nClocks at that moment are shown in the chat.`);
      },
    });

    ctx.tools.register({
      name: "units",
      effect: "read",
      description:
        "Convert a measurement between units: length (km, mi, ft, in), mass (kg, lb, oz), volume (l, gal, cup, tbsp), speed (km/h, mph, kn), area (m2, ha, acre), " +
        "temperature (C, F, K), data (MB, GiB), pressure (hPa, mmHg, psi), energy (kcal, kWh), duration. Use it instead of doing the arithmetic yourself.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          from: { type: "string", description: "Unit, e.g. mi, °F, lb" },
          to: { type: "string", description: "Unit, e.g. km, °C, kg" },
        },
        required: ["value", "from", "to"],
      },
      handler: async (input) => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return text("value must be a number.", true);
        const r = convert(value, String(input.from ?? ""), String(input.to ?? ""));
        if ("error" in r) return text(r.error, true);
        return text(`${value} ${r.from} = ${r.value} ${r.to}`);
      },
    });
  },
};

export default plugin;
