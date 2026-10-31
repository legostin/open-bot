// The catalog's entries: whether one is on, what its switch and button do, search, the popular ones, and each
// situation's colour.

import type { CatalogSection, CatalogView, IntegrationView } from "@piomio/shared";

type Entry = Pick<IntegrationView, "connect" | "status" | "plugin">;

/** On: turned on, connected or not yet. */
export function isOn(v: Entry): boolean {
  return v.status !== "off" && v.status !== "unavailable";
}

/**
 * Has a switch: everything but access from anywhere (its own steps, in the chat), what this build lacks, and a
 * plugin's entries (Composio's Slack…): their state is whether they are signed in, and their plugin has the switch.
 */
export function hasSwitch(v: Entry): boolean {
  return v.connect !== "remote" && v.status !== "unavailable" && !v.plugin;
}

/**
 * What continues in the chat, if anything: "connect" for something on but not connected yet (and access from
 * anywhere until it runs), "fix" for a broken one, "settings" for a working one that has setup (keys, a channel).
 */
export function chatStep(v: Entry): "connect" | "fix" | "settings" | undefined {
  if (v.status === "unavailable") return undefined;
  if (v.connect === "remote") return v.status === "connected" ? "settings" : "connect";
  // A plugin's entry has no switch: connecting it in the chat turns its plugin on too.
  if (v.status === "off") return v.plugin ? "connect" : undefined;
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

/** What a catalog row shows of an entry's state: on, waiting for the person, broken; nothing when it is off. */
export function rowState(v: Entry): "on" | "attention" | "broken" | undefined {
  if (v.status === "connected") return "on";
  if (v.status === "needs-setup") return "attention";
  if (v.status === "broken") return "broken";
  return undefined;
}

/** The popular entries, in their order (ids the catalog no longer has are skipped). */
export function popularEntries(c: CatalogView): Array<{ entry: IntegrationView; situation: string }> {
  return (c.popular ?? []).flatMap((id) => {
    const found = findEntry(c, id);
    return found ? [found] : [];
  });
}

/** An entry and the situation it is listed under. */
export function findEntry(c: CatalogView, id: string): { entry: IntegrationView; situation: string } | undefined {
  for (const s of c.sections) {
    const entry = s.items.find((v) => v.id === id);
    if (entry) return { entry, situation: s.id };
  }
  return undefined;
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
  assistant: "#c9822b",
  brains: "#8a6fd8",
  other: "#7d8590",
};

export function hueOf(situation: string): string {
  return SITUATION_HUE[situation] ?? SITUATION_HUE.other;
}
