// The catalog's entries: whether one is on, what its switch and button do, search, and each situation's colour.

import type { CatalogSection, IntegrationView } from "@owlbot/shared";

type Entry = Pick<IntegrationView, "connect" | "status">;

/** On: turned on, connected or not yet. */
export function isOn(v: Entry): boolean {
  return v.status !== "off" && v.status !== "unavailable";
}

/** Has a switch: everything but access from anywhere (its own steps, in the chat) and what this build lacks. */
export function hasSwitch(v: Entry): boolean {
  return v.connect !== "remote" && v.status !== "unavailable";
}

/**
 * What continues in the chat, if anything: "connect" for something on but not connected yet (and access from
 * anywhere until it runs), "fix" for a broken one, "settings" for a working one that has setup (keys, a channel).
 */
export function chatStep(v: Entry): "connect" | "fix" | "settings" | undefined {
  if (v.status === "unavailable") return undefined;
  if (v.connect === "remote") return v.status === "connected" ? "settings" : "connect";
  if (v.status === "off") return undefined;
  if (v.status === "broken") return "fix";
  if (v.status === "needs-setup") return "connect";
  return v.connect === "setup" ? "settings" : undefined;
}

/** Entries matching the query (name, line, situation or id), in their sections; empty sections are left out. */
export function filterCatalog(sections: CatalogSection[], query: string): CatalogSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter((v) => {
        const hay = `${v.name} ${v.summary} ${s.title} ${v.id}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((s) => s.items.length);
}

/** Each situation's colour: the tint of its entries' icons. */
export const SITUATION_HUE: Record<string, string> = {
  everyday: "#e9a23b",
  travel: "#18a99a",
  money: "#2f9e5b",
  work: "#5b6ee1",
  reading: "#e2733a",
  communication: "#2a92d6",
  home: "#d9579a",
  other: "#8a6fd8",
};

export function hueOf(situation: string): string {
  return SITUATION_HUE[situation] ?? SITUATION_HUE.other;
}
