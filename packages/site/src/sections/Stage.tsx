// The first screen and "a day with the team" share one live window: on a wide screen it sticks on the right while the
// headline and then the chapters scroll on the left; on a phone it sticks on top and the chapters scroll under it. The
// chapter crossing the reading line plays in the window; the chips jump to a chapter.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { ArrowDown, Lock } from "../components/icons";
import { DownloadButton } from "../components/Download";
import { DemoWindow } from "../demo/DemoWindow";
import { CHAPTERS, type ChapterId } from "../demo/protocol";

function useActiveChapter(): [ChapterId, (id: ChapterId) => void] {
  const [active, setActive] = useState<ChapterId>(CHAPTERS[0]);
  useEffect(() => {
    let raf = 0;
    const pick = () => {
      raf = 0;
      const wide = window.matchMedia("(min-width: 1024px)").matches;
      // The reading line: the middle of the screen beside the window, or the middle of what is left under it.
      const line = wide ? window.innerHeight * 0.5 : window.innerHeight * 0.8;
      // The chapter whose middle is nearest the line; before the story starts, the first one.
      let best: ChapterId = CHAPTERS[0];
      let gap = Infinity;
      for (const id of CHAPTERS) {
        const r = document.getElementById(`chapter-${id}`)?.getBoundingClientRect();
        if (!r) continue;
        const d = Math.abs(r.top + r.height / 2 - line);
        if (d < gap) {
          gap = d;
          best = id;
        }
      }
      setActive(best);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(pick);
    };
    pick();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, []);
  const jump = (id: ChapterId) => {
    setActive(id);
    document.getElementById(`chapter-${id}`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  };
  return [active, jump];
}

function Chips({ active, onPick }: { active: ChapterId; onPick: (id: ChapterId) => void }) {
  const { t } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  // Keep the active chip in sight on narrow screens.
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>(`[data-chip="${active}"]`);
    const r = row.current;
    if (el && r && r.scrollWidth > r.clientWidth) r.scrollTo({ left: el.offsetLeft - r.clientWidth / 2 + el.clientWidth / 2, behavior: "smooth" });
  }, [active]);
  return (
    <div ref={row} className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 py-1" role="tablist" aria-label={t("demo.chapters")}>
      {CHAPTERS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-chip={id}
          aria-selected={id === active}
          onClick={() => onPick(id)}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold whitespace-nowrap transition-all duration-300 ${
            id === active ? "bg-fg text-bg shadow-[var(--shadow)]" : "bg-surface text-fg-2 shadow-[0_0_0_1px_var(--border)] hover:text-fg"
          }`}
        >
          {t(`chapter.${id}.chip`)}
        </button>
      ))}
    </div>
  );
}

function Hero() {
  const { t } = useI18n();
  return (
    <div className="stage-hero flex flex-col justify-center pt-8 pb-8 lg:min-h-[calc(100svh-64px)] lg:py-16">
      <p className="mb-5 inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[13px] font-semibold text-fg-2 shadow-[0_0_0_1px_var(--border)]">
        <span className="live-dot size-1.5 rounded-full" />
        {t("hero.eyebrow")}
      </p>
      <h1 className="font-display text-[clamp(2rem,4.7vw,4.1rem)] leading-[1.04] font-extrabold tracking-[-0.025em] text-balance">
        {t("hero.titleLead")} <span className="marker whitespace-nowrap">{t("hero.titleMarker")}</span>
      </h1>
      <p className="mt-6 max-w-[34rem] text-[clamp(1.05rem,1.4vw,1.2rem)] leading-relaxed text-fg-2 text-pretty">{t("hero.lead")}</p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <DownloadButton />
        <a href="#install" className="ghost inline-flex items-center gap-2 rounded-full px-5 py-3.5 text-[15px] font-semibold">
          {t("hero.secondary")}
        </a>
      </div>
      <p className="mt-5 text-[13.5px] text-muted">{t("hero.fineprint")}</p>
      <a href="#chapter-morning" className="mt-12 hidden w-fit items-center gap-2 text-[14px] font-semibold text-accent-text lg:inline-flex">
        <ArrowDown size={16} />
        {t("hero.scroll")}
      </a>
    </div>
  );
}

function Chapter({ id, active }: { id: ChapterId; active: boolean }) {
  const { t } = useI18n();
  return (
    <article
      id={`chapter-${id}`}
      aria-current={active ? "step" : undefined}
      className={`relative flex min-h-[56svh] flex-col justify-center py-10 pl-8 transition-opacity duration-500 lg:min-h-[72svh] lg:pl-10 ${active ? "opacity-100" : "opacity-100 lg:opacity-35"}`}
    >
      <span
        className={`absolute top-1/2 left-[-6px] size-3.5 -translate-y-[calc(50%+3.2rem)] rounded-full transition-all duration-500 lg:-translate-y-[calc(50%+3.6rem)] ${active ? "bg-accent shadow-[0_0_0_6px_var(--accent-soft)]" : "bg-surface-3"}`}
        aria-hidden="true"
      />
      <p className="font-display text-[14px] font-bold tracking-wide text-accent-text">{t(`chapter.${id}.time`)}</p>
      <h3 className="mt-2 font-display text-[clamp(1.45rem,2.5vw,2.15rem)] leading-[1.12] font-bold tracking-[-0.015em] text-balance">{t(`chapter.${id}.title`)}</h3>
      <p className="mt-4 max-w-[33rem] text-[17px] leading-relaxed text-fg-2 text-pretty">{t(`chapter.${id}.text`)}</p>
      <p className="mt-4 flex max-w-[33rem] items-start gap-2 text-[14px] leading-snug text-muted">
        <Lock size={15} className="mt-0.5 shrink-0 text-accent" />
        {t(`chapter.${id}.under`)}
      </p>
    </article>
  );
}

export function Stage() {
  const { t } = useI18n();
  const [active, jump] = useActiveChapter();
  return (
    <section id="demo" className="relative">
      <div className="stage mx-auto max-w-[1320px] px-4 pb-16 sm:px-6 lg:px-10 lg:pb-28">
        <Hero />
        <div className="stage-window">
          <div className="stage-window-inner flex flex-col gap-3">
            <DemoWindow chapter={active} className="min-h-0 flex-1" />
            <Chips active={active} onPick={jump} />
          </div>
        </div>
        <div id="features" className="stage-story">
          <header className="pt-16 pb-6 lg:pt-28">
            <p className="text-[13px] font-bold tracking-[0.14em] text-accent-text uppercase">{t("story.eyebrow")}</p>
            <h2 className="mt-3 font-display text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.06] font-extrabold tracking-[-0.02em] text-balance">{t("story.title")}</h2>
            <p className="mt-4 max-w-[34rem] text-[17px] leading-relaxed text-fg-2 text-pretty">{t("story.lead")}</p>
          </header>
          <div className="relative border-l-2 border-hairline">
            {CHAPTERS.map((id) => (
              <Chapter key={id} id={id} active={id === active} />
            ))}
          </div>
          <div className="h-[20svh]" />
        </div>
      </div>
    </section>
  );
}
