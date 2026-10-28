// The one "⋯" in a chat's top bar: what the bar does not need to show all the time. "Show steps" (tool calls and
// service messages, hidden unless on) and, in an agent's dialog, its settings (brains included).

import { useEffect, useRef, useState } from "react";
import { Check, Ellipsis, ListTree, SlidersHorizontal } from "lucide-react";
import { useStore } from "../../lib/store";
import { setShowDetails, showDetails } from "../../state/prefs";
import { cx, IconButton } from "../../components/ui";
import { t } from "../../i18n";

export function ChatMenu({ onSettings }: { onSettings?: () => void }) {
  const on = useStore(showDetails);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const item = "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-surface-2";
  return (
    <div ref={box} className="relative ml-auto shrink-0">
      <IconButton label={t("chat.menu")} onClick={() => setOpen((v) => !v)} active={open} className="size-8">
        <Ellipsis className="size-[18px]" />
      </IconButton>
      {open && (
        <div role="menu" className="animate-zoom absolute top-full right-0 z-30 mt-1.5 w-60 origin-top-right rounded-2xl border border-hairline bg-surface p-1.5 shadow-pop">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            title={on ? t("chat.detailsOff") : t("chat.detailsOn")}
            onClick={() => {
              setShowDetails(!on);
              setOpen(false);
            }}
            className={item}
          >
            <ListTree className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">{t("chat.showSteps")}</span>
            <span className={cx("flex size-4 items-center justify-center", !on && "invisible")}>
              <Check className="size-4 text-accent-text" />
            </span>
          </button>
          {onSettings && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
              className={item}
            >
              <SlidersHorizontal className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">{t("agent.settings")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The chat's top bar menu (the detailed-mode switch lives there now). */
export const DetailsToggle = ChatMenu;
