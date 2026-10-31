// Tiny self-contained i18n: flat key → string maps with {name} placeholders.
// Plural messages hold the forms separated by "|" in the locale's order (en: one|other, ru: one|few|many).

import { useSyncExternalStore } from "react";
import { en, type MessageKey } from "./en.ts";
import { ru } from "./ru.ts";

export type { MessageKey };
export type Locale = "en" | "ru";
export type Params = Record<string, string | number>;

export const LOCALES: readonly Locale[] = ["en", "ru"];
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", ru: "Русский" };

const DICTS: Record<Locale, Record<MessageKey, string>> = { en, ru };
/** Shared with the main web UI. localStorage is per origin (port included), so the choice is mirrored to a cookie, which is per host. */
export const LOCALE_KEY = "piomio.locale";
export const LOCALE_HEADER = "x-piomio-locale";

const PLURAL_ORDER: Record<Locale, string[]> = { en: ["one", "other"], ru: ["one", "few", "many"] };
const pluralRules: Partial<Record<Locale, Intl.PluralRules>> = {};

/** "ru", "ru-RU" → ru; "en…" → en; anything else → undefined. */
export function normalizeLocale(v: unknown): Locale | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s.startsWith("ru")) return "ru";
  if (s.startsWith("en")) return "en";
  return undefined;
}

function readStored(): Locale | undefined {
  try {
    const v = normalizeLocale(globalThis.localStorage?.getItem(LOCALE_KEY));
    if (v) return v;
  } catch {
    /* storage unavailable */
  }
  try {
    const m = /(?:^|;\s*)piomio\.locale=([^;]*)/.exec(globalThis.document?.cookie ?? "");
    return m ? normalizeLocale(decodeURIComponent(m[1])) : undefined;
  } catch {
    return undefined;
  }
}

function fromNavigator(): Locale {
  const lang = globalThis.navigator?.language ?? "";
  return lang.toLowerCase().startsWith("ru") ? "ru" : "en";
}

let current: Locale = readStored() ?? fromNavigator();
let chosen = readStored() !== undefined;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

function set(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  applyLocale();
  listeners.forEach((l) => l());
}

/** Explicit user choice: remembered for this host (shared with the main web UI). */
export function setLocale(locale: Locale): void {
  chosen = true;
  try {
    globalThis.localStorage?.setItem(LOCALE_KEY, locale);
  } catch {
    /* ignore */
  }
  try {
    if (globalThis.document) document.cookie = `${LOCALE_KEY}=${locale}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* ignore */
  }
  set(locale);
}

/** Hub-wide default (`language` from the auth state); only used while the user has not chosen a locale here. */
export function applyServerLanguage(language: unknown): void {
  if (chosen) return;
  const l = normalizeLocale(language);
  if (l) set(l);
}

/** Keep <html lang> and the base title in sync with the locale. */
export function applyLocale(): void {
  if (!globalThis.document) return;
  document.documentElement.lang = current;
  if (!/^\(\d+\) /.test(document.title)) document.title = t("app.title");
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLocale,
    getLocale,
  );
}

function fill(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function t(key: MessageKey, params?: Params): string {
  return fill(DICTS[current][key] ?? en[key] ?? key, params);
}

/** Plural message: forms separated by "|"; {n} is filled with the count. */
export function tn(key: MessageKey, n: number, params?: Params): string {
  const forms = (DICTS[current][key] ?? en[key] ?? key).split("|");
  const rules = (pluralRules[current] ??= new Intl.PluralRules(current));
  const i = PLURAL_ORDER[current].indexOf(rules.select(n));
  const form = forms[Math.min(i < 0 ? forms.length - 1 : i, forms.length - 1)];
  return fill(form, { n, ...params });
}

/** Test hook: switch locale without touching storage. */
export function setLocaleForTests(locale: Locale): void {
  set(locale);
}
