// Installer text (Windows tray and setup, macOS package and uninstaller): packaging/desktop/locales/{en,ru}.json,
// English is the source of truth. Build scripts turn it into each tool's own format.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCALES = ["en", "ru"];

/** `{ en: {key: text}, ru: {...} }` */
export function loadCatalogs() {
  return Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readFileSync(join(import.meta.dirname, "locales", `${l}.json`), "utf8"))]));
}

/** The text in `locale`, English when it has none. */
export function text(catalogs, locale, key) {
  const s = catalogs[locale]?.[key] ?? catalogs.en[key];
  if (s === undefined) throw new Error(`no installer message ${key}`);
  return s;
}

export function format(s, params = {}) {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
