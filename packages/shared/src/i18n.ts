// Localization primitives shared by the hub, plugins, the node daemon and the web apps.
// Messages are flat key → string maps per locale; English is the source of truth and the fallback.
// Syntax: "{name}" placeholders and ICU-style plurals / selects:
//   "{count, plural, =0 {no files} one {# file} other {# files}}", "{kind, select, a {…} other {…}}".

export const LOCALES = ["en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Each language's name in itself, for language pickers. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", ru: "Русский" };

export type Messages = Record<string, string>;
export type Catalog = Partial<Record<Locale, Messages>>;
export type Params = Record<string, string | number | boolean | null | undefined>;
export type Translate = (key: string, params?: Params) => string;

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** "ru-RU", "ru_RU.UTF-8", "RU" → "ru"; anything unsupported → undefined. */
export function normalizeLocale(v: unknown): Locale | undefined {
  if (typeof v !== "string") return undefined;
  const base = v.trim().toLowerCase().split(/[-_.@]/)[0];
  return isLocale(base) ? base : undefined;
}

/** Best supported locale from an Accept-Language header ("ru-RU,ru;q=0.9,en;q=0.8"). */
export function localeFromAcceptLanguage(header: string | undefined): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...attrs] = part.trim().split(";");
      const q = Number(attrs.find((a) => a.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { tag, q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) {
    const l = normalizeLocale(r.tag);
    if (l) return l;
  }
  return undefined;
}

/** Locale of a Unix-style environment (OWLBOT_LANG, LC_ALL, LC_MESSAGES, LANG). */
export function localeFromEnv(env: Record<string, string | undefined>): Locale | undefined {
  for (const k of ["OWLBOT_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const l = normalizeLocale(env[k]);
    if (l) return l;
  }
  return undefined;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseOptions(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const selector = s.slice(i, open).trim();
    const close = matchBrace(s, open);
    if (close < 0 || !selector) break;
    out[selector] = s.slice(open + 1, close);
    i = close + 1;
  }
  return out;
}

function expand(body: string, params: Params, locale: Locale): string {
  const comma = body.indexOf(",");
  if (comma < 0) {
    const name = body.trim();
    const v = params[name];
    return v === undefined || v === null ? `{${name}}` : String(v);
  }
  const name = body.slice(0, comma).trim();
  const rest = body.slice(comma + 1);
  const comma2 = rest.indexOf(",");
  const kind = (comma2 < 0 ? rest : rest.slice(0, comma2)).trim();
  if (comma2 < 0 || (kind !== "plural" && kind !== "select")) return `{${body}}`;
  const options = parseOptions(rest.slice(comma2 + 1));
  const raw = params[name];
  if (kind === "select") return format(options[String(raw)] ?? options.other ?? "", params, locale);
  const n = Number(raw ?? 0);
  const branch = options[`=${n}`] ?? options[new Intl.PluralRules(locale).select(n)] ?? options.other ?? "";
  return format(branch.replace(/#/g, new Intl.NumberFormat(locale).format(n)), params, locale);
}

/** Fill a message template. Unknown placeholders are left as "{name}" so missing params are visible. */
export function format(template: string, params: Params = {}, locale: Locale = DEFAULT_LOCALE): string {
  if (!template.includes("{")) return template;
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c !== "{") {
      out += c;
      i++;
      continue;
    }
    const end = matchBrace(template, i);
    if (end < 0) {
      out += template.slice(i);
      break;
    }
    out += expand(template.slice(i + 1, end), params, locale);
    i = end + 1;
  }
  return out;
}

/** Translate function for one locale; falls back to English, then to the key itself. */
export function translator(catalog: Catalog, locale: Locale): Translate {
  const primary = catalog[locale] ?? {};
  const fallback = catalog[DEFAULT_LOCALE] ?? {};
  return (key, params) => {
    const own = primary[key];
    if (own !== undefined) return format(own, params, locale);
    const en = fallback[key];
    return en === undefined ? key : format(en, params, DEFAULT_LOCALE);
  };
}

/** Top-level placeholder names of a template ("{a} {n, plural, …}" → a, n). */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  let i = 0;
  while ((i = template.indexOf("{", i)) >= 0) {
    const end = matchBrace(template, i);
    if (end < 0) break;
    const body = template.slice(i + 1, end);
    const name = body.split(",")[0].trim();
    if (/^[A-Za-z_][\w.]*$/.test(name)) names.add(name);
    if (body.includes(",")) for (const inner of Object.values(parseOptions(body.split(",").slice(2).join(",")))) for (const n of placeholders(inner)) names.add(n);
    i = end + 1;
  }
  return [...names].sort();
}

/** Differences between each translation and English: missing / extra keys and placeholder mismatches. */
export function catalogProblems(catalog: Catalog): string[] {
  const en = catalog[DEFAULT_LOCALE] ?? {};
  const problems: string[] = [];
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const msgs = catalog[locale];
    if (!msgs) {
      problems.push(`${locale}: missing catalog`);
      continue;
    }
    for (const key of Object.keys(en)) {
      if (!(key in msgs)) problems.push(`${locale}: missing "${key}"`);
      else if (placeholders(en[key]).join() !== placeholders(msgs[key]).join())
        problems.push(`${locale}: "${key}" placeholders ${placeholders(msgs[key]).join(",") || "∅"} ≠ en ${placeholders(en[key]).join(",") || "∅"}`);
    }
    for (const key of Object.keys(msgs)) if (!(key in en)) problems.push(`${locale}: extra "${key}"`);
  }
  return problems;
}

const REF = /^%([\w.-]+)%$/;

/**
 * Replace "%key%" strings anywhere inside a JSON value (plugin manifests, settings schemas) with translations.
 * Strings without a translation are kept as they are.
 */
export function localizeValue<T>(value: T, lookup: (key: string) => string | undefined): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = REF.exec(v);
      return m ? (lookup(m[1]) ?? v) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Lookup for localizeValue: the locale's message, else English. */
export function catalogLookup(catalog: Catalog, locale: Locale): (key: string) => string | undefined {
  return (key) => catalog[locale]?.[key] ?? catalog[DEFAULT_LOCALE]?.[key];
}
