// The badge of the outside service an integration goes through (Composio) and its note: where the account's keys are
// kept and who sees the calls. On a catalog row the badge sits inside the row's button, so it is a span that keeps its
// click to itself. The note is fixed to the window (catalog lists clip what overflows them) and closes on a click
// elsewhere, a scroll or Escape.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ExternalLink, Plug } from "lucide-react";
import type { IntegrationVia } from "@owlbot/shared";
import { openExternal } from "../lib/external";
import { t } from "../i18n";
import { cx } from "./ui";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ViaBadge({ via, className }: { via: IntegrationVia; className?: string }) {
  const [open, setOpen] = useState<{ top: number; left: number }>();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(undefined);
    };
    // Escape closes the note only, not the panel around it.
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(undefined);
    };
    const scrolled = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(undefined);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [open]);

  const toggle = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (open) return setOpen(undefined);
    const r = ref.current!.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 24);
    setOpen({ top: r.bottom + 6, left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)) });
  };

  return (
    <span ref={ref} className={cx("relative inline-flex shrink-0", className)}>
      <span
        role="button"
        tabIndex={0}
        aria-expanded={!!open}
        aria-label={t("via.badgeLabel", { name: via.name })}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(e)}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-px text-[10.5px] leading-4 font-medium text-muted transition-colors hover:text-fg"
      >
        <Plug className="size-3" aria-hidden />
        {via.name}
      </span>
      {open && (
        <span
          role="dialog"
          aria-label={t("via.title", { name: via.name })}
          onClick={(e) => e.stopPropagation()}
          style={{ top: open.top, left: open.left }}
          className="fixed z-50 flex w-72 max-w-[calc(100vw-24px)] cursor-auto flex-col gap-1.5 rounded-xl border border-border bg-surface p-3 text-left text-xs leading-relaxed font-normal whitespace-normal text-fg shadow-card"
        >
          <span className="font-semibold">{t("via.title", { name: via.name })}</span>
          <span className="text-muted">{via.about}</span>
          {via.link && (
            <a
              href={via.link}
              onClick={(e) => {
                e.preventDefault();
                openExternal(via.link!);
              }}
              className="inline-flex items-center gap-1 font-medium text-accent-text"
            >
              {hostOf(via.link)}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </span>
      )}
    </span>
  );
}
