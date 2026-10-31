// How notifications read: a part's kind (parts saved before kinds read by level), source labels, the Inbox's days.

import type { NotificationKind, NotificationSource, NotifyLevel } from "@piomio/shared";

export function partKind(p: { kind?: NotificationKind; level: NotifyLevel }): NotificationKind {
  if (p.kind) return p.kind;
  return p.level === "digest" ? "digest" : p.level === "ask" ? "question" : "alert";
}

export function sourceLabel(s: NotificationSource): string {
  return s.count && s.count > 1 ? `${s.label} · ${s.count}` : s.label;
}

const dayOf = (tz: string | undefined) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

/** Entries by the person's local day (YYYY-MM-DD), keeping their order. */
export function groupByDay<T extends { createdAt: string }>(list: T[], tz?: string): Array<{ day: string; entries: T[] }> {
  const fmt = dayOf(tz);
  const out: Array<{ day: string; entries: T[] }> = [];
  for (const e of list) {
    const day = fmt.format(new Date(e.createdAt));
    const last = out[out.length - 1];
    if (last?.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

/** "Today", "Yesterday", otherwise the date in the interface language. */
export function dayLabel(day: string, now: Date, tz: string | undefined, locale: string, words: { today: string; yesterday: string }): string {
  const fmt = dayOf(tz);
  if (day === fmt.format(now)) return words.today;
  if (day === fmt.format(new Date(now.getTime() - 86_400_000))) return words.yesterday;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}
