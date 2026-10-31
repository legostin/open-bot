// Hub localization: the core's own messages (locales/*.ts), the hub language (Settings → language)
// for messages without a request (notifications, channels, logs), and per-request locales for HTTP errors.
// Model-facing text (tool results, system notes, task prompts) stays in English and is not translated.

import type { FastifyRequest } from "fastify";
import {
  DEFAULT_LOCALE,
  catalogLookup,
  localeFromAcceptLanguage,
  localizeValue,
  normalizeLocale,
  translator,
  type Catalog,
  type Locale,
  type Params,
  type PluginLayout,
  type Translate,
} from "@piomio/shared";
import en from "./locales/en.ts";
import ru from "./locales/ru.ts";

export const coreCatalog: Catalog = { en, ru };

let current: () => Locale = () => DEFAULT_LOCALE;
const cache = new Map<Locale, Translate>();

/** Where the hub language comes from (the settings store, once it exists). */
export function configureHubLocale(get: () => Locale): void {
  current = get;
}

export function hubLocale(): Locale {
  return current();
}

/** Translator for the core's messages in a locale. */
export function tFor(locale: Locale): Translate {
  let t = cache.get(locale);
  if (!t) cache.set(locale, (t = translator(coreCatalog, locale)));
  return t;
}

/** Translate a core message into the hub language. */
export function t(key: string, params?: Params): string {
  return tFor(hubLocale())(key, params);
}

/** An error whose text is a core message: English in logs, the reader's language over HTTP. */
export class LocalizedError extends Error {
  key: string;
  params?: Params;
  /** HTTP status when the error reaches an API caller (500 when unset). */
  status?: number;
  constructor(key: string, params?: Params, status?: number) {
    super(tFor(DEFAULT_LOCALE)(key, params));
    this.key = key;
    this.params = params;
    this.status = status;
  }
  localized(locale: Locale): string {
    return tFor(locale)(this.key, this.params);
  }
  /** Sent with the error over JSON-RPC (plugins, machines): the message key and its text in the hub language. */
  get rpcData(): { key: string; params?: Params; text: string } {
    return { key: this.key, params: this.params, text: this.localized(hubLocale()) };
  }
}

/** Locale of an HTTP request: the UI's explicit choice, then Accept-Language, then the hub language. */
export function requestLocale(req: Pick<FastifyRequest, "headers">): Locale {
  return normalizeLocale(req.headers["x-piomio-locale"]) ?? localeFromAcceptLanguage(String(req.headers["accept-language"] ?? "")) ?? hubLocale();
}

/** Text of any error for a reader in `locale`. */
export function errorText(err: unknown, locale: Locale): string {
  if (err instanceof LocalizedError) return err.localized(locale);
  return String((err as { message?: string })?.message ?? err ?? "error");
}

/** A plugin manifest (or any value from it) with "%key%" strings resolved from the plugin's locales. */
export function localizePluginValue<T>(layout: PluginLayout | undefined, value: T, locale: Locale): T {
  if (!layout?.messages) return value;
  return localizeValue(value, catalogLookup(layout.messages, locale));
}

export type { Catalog, Locale };
