// Interface language of the web UI. English (en.ts) is the source of truth and the fallback.
//
// The locale is chosen once per page load: this browser's explicit choice (localStorage, then the cookie shared
// with the security console), else the hub language (adopted from /api/auth/state or /api/bootstrap before anything
// localized is rendered), else navigator.language. Switching writes both and reloads the page, so nothing needs to
// re-render reactively; module-level code must not cache translated strings (call t() while rendering).

import { createElement, Fragment, type ReactNode } from "react";
import { DEFAULT_LOCALE, LOCALES, normalizeLocale, translator, type Locale, type Params } from "@owlbot/shared/i18n";
import en from "./en";
import ru from "./ru";

export type MessageKey = keyof typeof en;
export type { Locale, Params };
export { LOCALES };

export const catalog: Record<Locale, Record<MessageKey, string>> = { en, ru };

/**
 * localStorage key and cookie name. localStorage is per origin (port included), so the choice is mirrored into a
 * cookie, which is per host: the security console (another port) reads and writes the same cookie.
 */
const STORAGE_KEY = "owlbot.locale";
const COOKIE_RE = /(?:^|;\s*)owlbot\.locale=([^;]*)/;

function readStored(): Locale | undefined {
  try {
    const l = normalizeLocale(globalThis.localStorage?.getItem(STORAGE_KEY));
    if (l) return l;
  } catch {
    /* storage unavailable */
  }
  try {
    const m = COOKIE_RE.exec(globalThis.document?.cookie ?? "");
    return m ? normalizeLocale(decodeURIComponent(m[1])) : undefined;
  } catch {
    return undefined;
  }
}

function browserLocale(): Locale {
  const lang = typeof navigator !== "undefined" ? navigator.language : undefined;
  return normalizeLocale(lang) ?? DEFAULT_LOCALE;
}

const explicit = readStored();

/** Current interface language (a live binding: it may change once, when the hub language is adopted). */
export let locale: Locale = explicit ?? browserLocale();
let translate = translator(catalog, locale);

function apply(l: Locale): void {
  locale = l;
  translate = translator(catalog, l);
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
apply(locale);

/** The language picked in this browser, or undefined when the UI follows the hub language. */
export function explicitLocale(): Locale | undefined {
  return explicit;
}

/** Follow the hub language unless this browser has its own choice. Call before rendering localized UI. */
export function adoptHubLocale(hubLanguage: unknown): void {
  if (explicit) return;
  const l = normalizeLocale(hubLanguage);
  if (l && l !== locale) apply(l);
}

/**
 * Remember the language for this browser, here and in the security console (null: follow the hub language again),
 * and reload the page.
 */
export function setLocale(l: Locale | null): void {
  try {
    if (l) localStorage.setItem(STORAGE_KEY, l);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: the cookie still carries the choice */
  }
  try {
    document.cookie = l ? `${STORAGE_KEY}=${l}; path=/; max-age=31536000; samesite=lax` : `${STORAGE_KEY}=; path=/; max-age=0; samesite=lax`;
  } catch {
    /* cookies unavailable */
  }
  location.reload();
}

/** Translate a UI message. */
export function t(key: MessageKey, params?: Params): string {
  return translate(key, params);
}

const MARK = "\u0000";

/**
 * Translate a message whose placeholders hold React nodes (links, <code>…), e.g.
 * tRich("brains.codexKey", { id: <Code>openai_api_key</Code> }).
 */
export function tRich(key: MessageKey, params: Record<string, ReactNode>): ReactNode {
  const nodes: ReactNode[] = [];
  const plain: Params = {};
  for (const [name, v] of Object.entries(params)) {
    if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") plain[name] = v;
    else {
      plain[name] = `${MARK}${nodes.length}${MARK}`;
      nodes.push(v);
    }
  }
  const pieces = translate(key, plain).split(MARK);
  return createElement(Fragment, null, ...pieces.map((p, i) => (i % 2 ? nodes[Number(p)] : p)));
}

// ---------- Intl helpers ----------

function toDate(d: Date | string | number): Date | undefined {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A date in the interface language ("" for invalid input). Default: medium date + short time. */
export function formatDate(d: Date | string | number, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  const date = toDate(d);
  return date ? new Intl.DateTimeFormat(locale, opts).format(date) : "";
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, opts).format(n);
}

/** "in 5 minutes", "2 hours ago", "tomorrow"… in the interface language. */
export function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
