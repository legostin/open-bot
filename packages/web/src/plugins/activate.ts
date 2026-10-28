// Find the activate() function in a loaded UI plugin module (pure; unit-tested).

import type { OwlbotUI } from "@owlbot/ui";

export type ActivateFn = (ui: OwlbotUI) => void | (() => void) | Promise<void | (() => void)>;

export function resolveActivate(mod: unknown): ActivateFn | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as Record<string, any>;
  if (typeof m.activate === "function") return m.activate;
  const d = m.default;
  if (d && typeof d === "object" && typeof d.activate === "function") return d.activate.bind(d);
  if (typeof d === "function") return d;
  return undefined;
}
