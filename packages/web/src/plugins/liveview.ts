// Live view: when the floating window shows, which view and how (pure logic, unit-tested).
// The window itself is components/LiveViewWindow.tsx; views are registered in registry.ts (ui.liveView.register).

import type { LiveViewActivity } from "@openbot/ui";
import { createStore } from "../lib/store";

/** After the work stops the compact window stays this long (short gaps between tool calls do not flicker). */
export const LIVE_GRACE_MS = 20_000;
/** Then a pill stays this long before the view disappears. */
export const PILL_LINGER_MS = 60_000;

export interface LiveViewState {
  activity: LiveViewActivity;
  /** When the view was last busy (0: never). */
  lastBusyAt: number;
  /**
   * A stretch of work: starts when an idle view gets busy, or when it starts asking for the user. The user's
   * minimize / close apply to one burst, so the next one shows the window again.
   */
  burst: number;
}

export const IDLE_VIEW: LiveViewState = { activity: { active: false }, lastBusyAt: 0, burst: 0 };

export function isBusy(a: LiveViewActivity): boolean {
  return a.active || !!a.attention || !!a.userControl;
}

export type LivePhase = "live" | "linger" | "gone";

export function phaseOf(v: LiveViewState, now: number): LivePhase {
  if (isBusy(v.activity)) return "live";
  if (!v.lastBusyAt) return "gone";
  const idle = now - v.lastBusyAt;
  return idle < LIVE_GRACE_MS ? "live" : idle < LIVE_GRACE_MS + PILL_LINGER_MS ? "linger" : "gone";
}

export function applyActivity(v: LiveViewState, patch: Partial<LiveViewActivity>, now: number): LiveViewState {
  const activity: LiveViewActivity = { ...v.activity, ...patch, active: !!(patch.active ?? v.activity.active) };
  const busy = isBusy(activity);
  const startsBurst = (busy && phaseOf(v, now) !== "live") || (!!activity.attention && !v.activity.attention);
  return {
    activity,
    lastBusyAt: busy || isBusy(v.activity) ? now : v.lastBusyAt,
    burst: startsBurst ? v.burst + 1 : v.burst,
  };
}

/** When the next time-driven change happens (grace or pill over), for a timer; undefined if none is pending. */
export function nextChangeAt(views: LiveViewState[], now: number): number | undefined {
  let next: number | undefined;
  for (const v of views) {
    if (isBusy(v.activity) || !v.lastBusyAt) continue;
    for (const at of [v.lastBusyAt + LIVE_GRACE_MS, v.lastBusyAt + LIVE_GRACE_MS + PILL_LINGER_MS]) {
      if (at > now && (next === undefined || at < next)) next = at;
    }
  }
  return next;
}

// ---------- the user's choices (this page only) ----------

export interface LiveWindowChoices {
  /** The view open in the large overlay. */
  expanded?: string;
  /** The view picked in the switcher. */
  selected?: string;
  /** view key → the burst it was minimized / closed in. */
  minimized: Record<string, number>;
  closed: Record<string, number>;
}

export const liveWindow = createStore<LiveWindowChoices>({ minimized: {}, closed: {} });

type Keyed = { key: string; burst: number };

const without = (m: Record<string, number>, key: string) => {
  if (!(key in m)) return m;
  const next = { ...m };
  delete next[key];
  return next;
};

export const liveWindowActions = {
  expand: (key: string) => liveWindow.set((s) => ({ ...s, expanded: key, selected: key, minimized: without(s.minimized, key), closed: without(s.closed, key) })),
  collapse: () => liveWindow.set((s) => (s.expanded ? { ...s, expanded: undefined } : s)),
  /** Show a view in the compact window (from a pill or the switcher). */
  show: (key: string) => liveWindow.set((s) => ({ ...s, selected: key, minimized: without(s.minimized, key), closed: without(s.closed, key) })),
  minimize: (v: Keyed) => liveWindow.set((s) => ({ ...s, minimized: { ...s.minimized, [v.key]: v.burst } })),
  close: (v: Keyed) =>
    liveWindow.set((s) => ({ ...s, expanded: s.expanded === v.key ? undefined : s.expanded, closed: { ...s.closed, [v.key]: v.burst } })),
};

// ---------- what to show ----------

export type LiveWindowMode = "hidden" | "pill" | "mini" | "expanded";

export interface LiveWindowView<V> {
  mode: LiveWindowMode;
  /** The view in the compact window or the overlay. */
  current?: V;
  /** Views that are not gone or closed (pills, the switcher), most relevant first. */
  visible: V[];
}

export function liveWindowView<V extends LiveViewState & { key: string }>(views: V[], ui: LiveWindowChoices, now: number): LiveWindowView<V> {
  const rank = (v: V) => (v.activity.attention ? 2 : 0) + (isBusy(v.activity) ? 1 : 0);
  const visible = views
    .filter((v) => phaseOf(v, now) !== "gone" && ui.closed[v.key] !== v.burst)
    .sort((a, b) => rank(b) - rank(a) || b.lastBusyAt - a.lastBusyAt);
  const expanded = ui.expanded ? views.find((v) => v.key === ui.expanded) : undefined;
  if (expanded) return { mode: "expanded", current: expanded, visible };
  const open = visible.filter((v) => phaseOf(v, now) === "live" && ui.minimized[v.key] !== v.burst);
  if (open.length) {
    const current = open.find((v) => v.activity.attention) ?? open.find((v) => v.key === ui.selected) ?? open[0];
    return { mode: "mini", current, visible };
  }
  return { mode: visible.length ? "pill" : "hidden", visible };
}
