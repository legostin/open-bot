// Per-device console preferences (theme, sound, notifications). localStorage only; nothing secret here.

import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";

export interface Prefs {
  theme: ThemePref;
  sound: boolean;
  notify: boolean;
}

const KEY = "piomio-console-prefs";
const DEFAULTS: Prefs = { theme: "system", sound: true, notify: true };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULTS;
}

let current = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
  applyTheme();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getPrefs,
    getPrefs,
  );
}

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;

export function applyTheme(): void {
  const dark = current.theme === "dark" || (current.theme === "system" && !!media?.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b1416" : "#0f766e");
}

media?.addEventListener("change", applyTheme);
