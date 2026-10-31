// Prerendering (scripts/prerender.mjs): the page's markup and its <head> for one language.

import { renderToString } from "react-dom/server";
import { siteConfig, type Lang } from "../site.config";
import { App } from "./App";
import { data } from "./data";
import { translator } from "./i18n";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function render(lang: Lang): { html: string; head: string } {
  const t = translator(lang);
  const page = (l: string) => `${data.origin}${data.base}${l}/`;
  const head = [
    `<title>${esc(t("meta.title"))}</title>`,
    `<meta name="description" content="${esc(t("meta.description"))}" />`,
    `<link rel="canonical" href="${page(lang)}" />`,
    ...siteConfig.languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${page(l)}" />`),
    `<link rel="alternate" hreflang="x-default" href="${page("en")}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Piomio" />`,
    `<meta property="og:locale" content="${lang === "ru" ? "ru_RU" : "en_US"}" />`,
    `<meta property="og:title" content="${esc(t("meta.title"))}" />`,
    `<meta property="og:description" content="${esc(t("meta.description"))}" />`,
    `<meta property="og:url" content="${page(lang)}" />`,
    `<meta property="og:image" content="${data.origin}${data.base}og-${lang}.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(t("meta.ogAlt"))}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(t("meta.title"))}" />`,
    `<meta name="twitter:description" content="${esc(t("meta.description"))}" />`,
    `<meta name="twitter:image" content="${data.origin}${data.base}og-${lang}.png" />`,
  ].join("\n    ");
  return { html: renderToString(<App lang={lang} />), head };
}
