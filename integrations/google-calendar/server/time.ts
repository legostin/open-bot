// Local times in the user's timezone ↔ the instants Google Calendar takes, and how events read for the model.

/** Minutes the zone is ahead of UTC at an instant. */
export function zoneOffsetMin(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000);
}

/** The instant whose wall time in `timezone` is y-m-d h:mi:s. */
export function zonedInstant(y: number, m: number, d: number, h: number, mi: number, s: number, timezone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let at = guess - zoneOffsetMin(guess, timezone) * 60_000;
  // Around a DST change the first guess can be an hour off.
  at = guess - zoneOffsetMin(at, timezone) * 60_000;
  return at;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** RFC 3339 with the zone's offset, e.g. 2026-10-28T10:00:00+05:00. */
export function rfc3339(at: number, timezone: string): string {
  const off = zoneOffsetMin(at, timezone);
  const local = new Date(at + off * 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export type When = { date: string } | { at: number };

/** What the agent wrote: a date (YYYY-MM-DD), a local time (YYYY-MM-DDTHH:MM[:SS]) or an instant with an offset. */
export function parseWhen(v: unknown, timezone: string): When | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return { date: s };
  const local = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(s);
  if (local) {
    const [y, m, d, h, mi, sec] = local.slice(1).map((x) => Number(x ?? 0));
    return { at: zonedInstant(y, m, d, h, mi, sec, timezone) };
  }
  const at = Date.parse(s);
  return /^\d{4}-\d\d-\d\dT.*(Z|[+-]\d\d:?\d\d)$/i.test(s) && Number.isFinite(at) ? { at } : undefined;
}

/** A date plus days, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Today's date in the zone. */
export function today(timezone: string, at = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** The instant a local date starts at. */
export function dayStart(date: string, timezone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return zonedInstant(y, m, d, 0, 0, 0, timezone);
}

/** An event's start or end as Google gives it. */
export interface GTime {
  date?: string;
  dateTime?: string;
}

/** "Tue 28 Oct" for a date. */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T00:00:00Z`));
}

/** "10:00" in the zone. */
export function clock(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

/** "Tue 28 Oct 10:00–11:00", "Tue 28 Oct, all day", "Tue 28 Oct 22:00 – Wed 29 Oct 01:00". */
export function span(start: GTime, end: GTime, timezone: string): string {
  if (start.date) {
    const last = end.date ? addDays(end.date, -1) : start.date;
    return last === start.date ? `${dayLabel(start.date)}, all day` : `${dayLabel(start.date)} – ${dayLabel(last)}, all day`;
  }
  const a = Date.parse(start.dateTime!);
  const b = end.dateTime ? Date.parse(end.dateTime) : a;
  const da = today(timezone, a);
  const db = today(timezone, b);
  return da === db ? `${dayLabel(da)} ${clock(a, timezone)}–${clock(b, timezone)}` : `${dayLabel(da)} ${clock(a, timezone)} – ${dayLabel(db)} ${clock(b, timezone)}`;
}
