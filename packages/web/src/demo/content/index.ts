import type { Locale } from "@piomio/shared";
import { en } from "./en";
import { ru } from "./ru";
import type { Content } from "./types";

export const CONTENT: Record<Locale, Content> = { en, ru };

export function contentFor(locale: string | null | undefined): Content {
  return CONTENT[locale as Locale] ?? en;
}
