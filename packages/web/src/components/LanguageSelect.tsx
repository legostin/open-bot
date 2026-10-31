// Interface language pickers for this browser. Choosing a language stores it (shared with the security console)
// and reloads the page.

import { Languages } from "lucide-react";
import { LOCALE_NAMES } from "@piomio/shared/i18n";
import { explicitLocale, locale, LOCALES, setLocale, t, type Locale } from "../i18n";
import { cx, Select } from "./ui";

/** Compact picker for the screens shown before sign-in. */
export function LanguageSwitch({ className }: { className?: string }) {
  return (
    <label className={cx("inline-flex items-center gap-1.5 text-xs text-muted", className)}>
      <Languages className="size-3.5" aria-hidden />
      <select
        aria-label={t("language.label")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="cursor-pointer rounded-md bg-transparent py-0.5 text-xs text-muted transition hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Settings: this browser's language, or "same as the hub" (no own choice). */
export function BrowserLanguageSelect({ hubLanguage }: { hubLanguage: Locale }) {
  return (
    <Select value={explicitLocale() ?? ""} onChange={(e) => setLocale((e.target.value || null) as Locale | null)}>
      <option value="">{t("settings.language.followHub", { language: LOCALE_NAMES[hubLanguage] ?? hubLanguage })}</option>
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </Select>
  );
}
