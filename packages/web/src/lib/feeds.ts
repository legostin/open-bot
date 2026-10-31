// Channels in the web UI: their paths, the schedules people pick ("morning and evening") and how a schedule reads.
import type { Feed } from "@piomio/shared";

export type Cadence = "morning" | "twice" | "thrice" | "weekly";

/** The schedules the new-channel form offers; anything else (set by an agent) reads as its times. */
export const CADENCES: Record<Cadence, { times: string[]; weekdays: number[] }> = {
  morning: { times: ["08:00"], weekdays: [] },
  twice: { times: ["08:00", "19:00"], weekdays: [] },
  thrice: { times: ["08:00", "13:00", "19:00"], weekdays: [] },
  weekly: { times: ["09:00"], weekdays: [1] },
};

export function cadenceOf(f: Pick<Feed, "times" | "weekdays">): Cadence | undefined {
  return (Object.keys(CADENCES) as Cadence[]).find((c) => CADENCES[c].times.join() === f.times.join() && CADENCES[c].weekdays.join() === f.weekdays.join());
}

export function feedPath(id: string): string {
  return `/channels/${encodeURIComponent(id)}`;
}

/** The channel a path shows, if it shows one. */
export function feedForPath(path: string): string | undefined {
  const m = /^\/channels\/([^/]+)\/?$/.exec(path);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** The local day of a moment ("2026-10-29"), to put posts under their day. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
