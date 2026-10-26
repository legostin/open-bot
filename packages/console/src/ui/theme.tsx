import type { ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { setPrefs, usePrefs, type ThemePref } from "../prefs.ts";
import { cx } from "./kit.tsx";
import { t } from "../i18n/index.ts";

export function ThemeSwitch() {
  const prefs = usePrefs();
  const opts: Array<{ v: ThemePref; label: string; icon: ReactNode }> = [
    { v: "system", label: t("theme.system"), icon: <Monitor className="size-4" /> },
    { v: "light", label: t("theme.light"), icon: <Sun className="size-4" /> },
    { v: "dark", label: t("theme.dark"), icon: <Moon className="size-4" /> },
  ];
  return (
    <div className="flex rounded-lg border border-line bg-inset p-0.5" role="radiogroup" aria-label={t("theme.label")}>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={prefs.theme === o.v}
          title={o.label}
          aria-label={o.label}
          onClick={() => setPrefs({ theme: o.v })}
          className={cx("flex flex-1 items-center justify-center rounded-md py-1.5", prefs.theme === o.v ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-faint hover:text-fg")}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

