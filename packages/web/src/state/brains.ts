// The hub's brains with their sign-in state, shared by the brain picker in a dialog's header, the agent editor
// and the Brains page. Refreshed on brains.updated (sign-ins, keys saved from the chat, limits).

import { api } from "../lib/api";
import { createStore } from "../lib/store";
import { formatDateTime, type Tone } from "../lib/format";
import { hubEvents, reconnected } from "./app";
import { t } from "../i18n";

export interface BrainRow {
  ref: string;
  label: string;
  host?: string;
  /** Can sign in from here (a CLI brain on the hub). */
  login?: boolean;
  connected: boolean;
  probe?: { available: boolean; authenticated: boolean; version?: string; models?: string[]; detail?: string; checkedAt?: string };
  limitedUntil?: string;
  limitDetail?: string;
}

export const brains = createStore<BrainRow[] | null>(null);

let pending: Promise<BrainRow[]> | null = null;
let wired = false;

/** fresh: probe every brain again instead of using the hub's cached results. */
export function refreshBrains(fresh = false): Promise<BrainRow[]> {
  if (pending && !fresh) return pending;
  const p = api.get<BrainRow[]>(`/api/brains${fresh ? "?probe=1" : ""}`).then((list) => {
    brains.set(list);
    return list;
  });
  pending = p.finally(() => {
    if (pending === p) pending = null;
  });
  return p;
}

export function ensureBrains(): void {
  if (!wired) {
    wired = true;
    hubEvents.on((e) => {
      if (e.type === "brains.updated" || e.type === "plugins.updated") void refreshBrains().catch(() => {});
    });
    reconnected.on(() => void refreshBrains().catch(() => {}));
  }
  if (!brains.get()) void refreshBrains().catch(() => {});
}

/** Mirrors parseBrainRef in @owlbot/shared: a ref without "@machine" runs on the hub ("@local"). */
export function normalizeBrainRef(ref: string): string {
  const r = ref.trim();
  return r.includes("@") ? r : `${r}@local`;
}

export function findBrain(list: BrainRow[] | null, ref: string): BrainRow | undefined {
  const key = normalizeBrainRef(ref);
  return list?.find((b) => normalizeBrainRef(b.ref) === key);
}

/** Can answer right now: connected, signed in, not over a limit. */
export function brainReady(b: BrainRow | undefined): boolean {
  return !!b && b.connected && !b.limitedUntil && !!b.probe?.available && !!b.probe.authenticated;
}

export function brainStatus(b: BrainRow): { label: string; tone: Tone } {
  if (!b.connected) return { label: t("brains.status.notConnected"), tone: "neutral" };
  if (b.limitedUntil) return { label: t("brains.status.limited", { time: formatDateTime(b.limitedUntil) }), tone: "warning" };
  if (!b.probe) return { label: t("brains.status.unchecked"), tone: "neutral" };
  if (!b.probe.available) return { label: t("brains.status.unavailable"), tone: "danger" };
  if (!b.probe.authenticated) return { label: t("brains.status.needsLogin"), tone: "warning" };
  return { label: t("brains.status.ready"), tone: "success" };
}

/** The brain an agent's next turn will run on: the first ready one in its fallback order (the runner does the same). */
export function activeBrain(agentBrains: string[], list: BrainRow[] | null): BrainRow | undefined {
  for (const ref of agentBrains) {
    const b = findBrain(list, ref);
    if (brainReady(b)) return b;
  }
  return undefined;
}

/** A readable name for a ref the hub does not list (an agent may name a brain that is not installed). */
export function brainName(ref: string, list: BrainRow[] | null): string {
  return findBrain(list, ref)?.label ?? ref;
}

/** The agent's order with `ref` moved to the front (added if missing): the chosen brain answers, the rest stay as fallbacks. */
export function preferBrain(agentBrains: string[], ref: string): string[] {
  const key = normalizeBrainRef(ref);
  return [ref, ...agentBrains.filter((b) => normalizeBrainRef(b) !== key)];
}
