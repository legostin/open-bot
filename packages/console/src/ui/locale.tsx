import { LOCALE_NAMES, LOCALES, setLocale, t, useLocale } from "../i18n/index.ts";
import { cx } from "./kit.tsx";

/** RU/EN switch. The choice is stored per host and shared with the main web UI. */
export function LocaleSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  return (
    <div className={cx("flex rounded-lg border border-line bg-inset p-0.5", className)} role="radiogroup" aria-label={t("locale.label")}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          lang={l}
          aria-checked={locale === l}
          aria-label={LOCALE_NAMES[l]}
          title={LOCALE_NAMES[l]}
          onClick={() => setLocale(l)}
          className={cx(
            "min-w-9 flex-1 rounded-md px-2 py-1 text-xs font-semibold tracking-wide",
            locale === l ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-faint hover:text-fg",
          )}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
