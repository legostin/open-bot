// The day as stories, full screen on a phone: one chapter after another in the live app, a bar per chapter on top
// (tap one to go there), the next chapter coming by itself when one ends. Here the app takes touches: the visitor may
// tap around in it. The page underneath stays where it was.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { ChevronLeft, ChevronRight, Close } from "../components/icons";
import { DemoWindow } from "./DemoWindow";
import { CHAPTERS, type ChapterId } from "./protocol";

/** After a chapter ends, the next one starts this much later. */
const NEXT_MS = 1600;

export function Story({ start, onClose }: { start: ChapterId; onClose: () => void }) {
  const { t } = useI18n();
  const [at, setAt] = useState(Math.max(0, CHAPTERS.indexOf(start)));
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const id = CHAPTERS[at];
  const last = CHAPTERS.length - 1;
  const go = (n: number) => setAt(Math.max(0, Math.min(last, n)));

  // The page holds still under the story; Escape and the arrow keys work too.
  useEffect(() => {
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setAt((n) => Math.min(last, n + 1));
      if (e.key === "ArrowLeft") setAt((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", key);
    return () => {
      html.style.overflow = overflow;
      window.removeEventListener("keydown", key);
    };
  }, [onClose, last]);

  // A chapter that ended moves on to the next one, unless the visitor already went elsewhere.
  const [ended, setEnded] = useState<{ n: number; at: number } | null>(null);
  useEffect(() => {
    if (!ended) return;
    setDone((d) => new Set(d).add(ended.n));
    if (ended.n >= last) return;
    const timer = setTimeout(() => setAt((n) => (n === ended.n ? n + 1 : n)), NEXT_MS);
    return () => clearTimeout(timer);
  }, [ended, last]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("demo.story", { n: at + 1, total: CHAPTERS.length })} className="story fixed inset-0 z-[100] flex flex-col bg-canvas">
      <div className="px-3 pt-[max(10px,env(safe-area-inset-top))]">
        <div className="flex gap-1">
          {CHAPTERS.map((c, n) => (
            <button key={c} type="button" onClick={() => go(n)} aria-label={t(`chapter.${c}.chip`)} className="h-6 flex-1 py-2.5">
              <span className="block h-1 overflow-hidden rounded-full bg-fg/15">
                <span className={`block h-full rounded-full bg-fg ${n < at || done.has(n) ? "w-full" : n === at ? "story-progress" : "w-0"}`} />
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 pt-1 pb-2.5">
          <div className="min-w-0 flex-1">
            <p className="font-display text-[12px] font-bold tracking-wide text-accent-text">
              {t(`chapter.${id}.time`)} · {t(`chapter.${id}.chip`)}
            </p>
            <p className="truncate font-display text-[16.5px] leading-tight font-bold">{t(`chapter.${id}.title`)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("demo.close")} className="grid size-10 shrink-0 place-items-center rounded-full bg-surface shadow-[var(--shadow)]">
            <Close size={18} />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 px-2">
        <DemoWindow key={id} chapter={id} bare className="h-full rounded-[22px]" onEnded={() => setEnded({ n: at, at: Date.now() })} />
      </div>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))]">
        <button type="button" onClick={() => go(at - 1)} disabled={at === 0} aria-label={t("demo.prev")} className="grid size-11 place-items-center rounded-full bg-surface shadow-[var(--shadow)] disabled:opacity-35">
          <ChevronLeft size={20} />
        </button>
        <p className="flex-1 text-center text-[12.5px] leading-snug text-muted">{t("demo.touchHint")}</p>
        <button type="button" onClick={() => go(at + 1)} disabled={at === last} aria-label={t("demo.next")} className="candy grid size-11 place-items-center rounded-full disabled:opacity-35">
          <ChevronRight size={20} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
