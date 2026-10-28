// Pictures an agent shows (an `images` part): one image as a card, more as a swipeable carousel; both open a
// full-screen viewer. Sources go through the hub (lib/media.ts), so the page CSP stays strict.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, X } from "lucide-react";
import type { ImageItem } from "@owlbot/shared";
import { activeSlide, mediaSrc, originalHref, wrapIndex } from "../../lib/media";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

type Shown = ImageItem & { url: string };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An image that fades in once loaded, with a quiet placeholder while it loads and when it cannot. */
function Picture({ src, alt, fit, className }: { src: string; alt: string; fit: "contain" | "cover"; className?: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setState("loading");
    // Already in the browser cache: the load event may have fired before React listened.
    if (img.current?.complete && img.current.naturalWidth > 0) setState("ok");
  }, [src]);
  if (state === "error") {
    return (
      <div className={cx("flex min-h-40 flex-col items-center justify-center gap-1.5 bg-surface-2 p-4 text-center text-xs text-muted", className)}>
        <ImageOff className="size-5" />
        {t("message.images.failed")}
      </div>
    );
  }
  return (
    <div className={cx("relative overflow-hidden bg-surface-2", state === "loading" && "min-h-40 min-w-56 animate-pulse", className)}>
      <img
        ref={img}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
        className={cx(
          "block transition-opacity duration-300 ease-out",
          fit === "cover" ? "h-full w-full object-cover" : "max-h-[420px] w-auto max-w-full object-contain",
          state === "ok" ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function SingleImage({ item, onOpen }: { item: Shown; onOpen: () => void }) {
  return (
    <figure className="inline-flex max-w-full flex-col overflow-hidden rounded-[22px] border border-hairline bg-surface shadow-card sm:max-w-md">
      <button type="button" onClick={onOpen} aria-label={item.alt || item.caption || t("message.images.open")} className="group block cursor-zoom-in overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Picture src={item.url} alt={item.alt ?? item.caption ?? ""} fit="contain" className="transition-transform duration-300 ease-out group-hover:scale-[1.01]" />
      </button>
      {item.caption && <figcaption className="px-3.5 py-2.5 text-[13px] leading-snug text-muted">{item.caption}</figcaption>}
    </figure>
  );
}

function Carousel({ items, onOpen }: { items: Shown[]; onOpen: (i: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [active, setActive] = useState(0);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const lefts = Array.from(el.children, (c) => (c as HTMLElement).offsetLeft);
    setActive(activeSlide(lefts, el.scrollLeft, max));
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    measure();
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [measure, items.length]);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  const go = (i: number) => {
    const el = strip.current;
    const slide = el?.children[Math.max(0, Math.min(items.length - 1, i))] as HTMLElement | undefined;
    if (el && slide) el.scrollTo({ left: slide.offsetLeft, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(active + (e.key === "ArrowRight" ? 1 : -1));
    }
  };

  const arrow = "glass absolute top-1/2 z-10 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-hairline text-fg shadow-card transition duration-200 hover:bg-surface focus-visible:opacity-100";
  return (
    <div className="group/carousel relative max-w-full sm:max-w-xl" role="region" aria-roledescription="carousel" aria-label={t("message.images.carousel", { n: items.length })}>
      <div className="relative">
        <div
          ref={strip}
          onScroll={onScroll}
          onKeyDown={onKey}
          tabIndex={0}
          className="no-scrollbar relative flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {items.map((it, i) => (
            <figure key={`${i}-${it.src}`} className="w-[82%] shrink-0 snap-start sm:w-[68%]" aria-roledescription="slide" aria-label={t("message.images.slide", { n: i + 1, total: items.length })}>
              <button
                type="button"
                onClick={() => onOpen(i)}
                aria-label={it.alt || it.caption || t("message.images.open")}
                className="group block w-full cursor-zoom-in overflow-hidden rounded-[20px] border border-hairline bg-surface shadow-card outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Picture src={it.url} alt={it.alt ?? it.caption ?? ""} fit="cover" className="aspect-[4/3] w-full transition-transform duration-300 ease-out group-hover:scale-[1.015]" />
              </button>
              {it.caption && <figcaption className="mt-1.5 truncate px-1 text-[13px] text-muted" title={it.caption}>{it.caption}</figcaption>}
            </figure>
          ))}
        </div>
        {!edges.start && (
          <button type="button" aria-label={t("message.images.prev")} onClick={() => go(active - 1)} className={cx(arrow, "left-2 opacity-0 group-hover/carousel:opacity-100 max-md:hidden")}>
            <ChevronLeft className="size-4" />
          </button>
        )}
        {!edges.end && (
          <button type="button" aria-label={t("message.images.next")} onClick={() => go(active + 1)} className={cx(arrow, "right-2 opacity-0 group-hover/carousel:opacity-100 max-md:hidden")}>
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-2 flex justify-center gap-1.5">
        {items.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={t("message.images.goto", { n: i + 1 })}
            aria-current={i === active}
            onClick={() => go(i)}
            className={cx("h-1.5 rounded-full transition-all duration-300 ease-out", i === active ? "w-5 bg-accent" : "w-1.5 bg-surface-3 hover:bg-muted")}
          />
        ))}
      </div>
    </div>
  );
}

/** Full-screen viewer: Esc or a click on the backdrop closes it, arrows and swipes move between the images. */
function Lightbox({ items, index, onIndex, onClose }: { items: Shown[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number } | undefined>(undefined);
  // A swipe must not end as a click on the backdrop (which closes the viewer).
  const swiped = useRef(false);
  const [dragX, setDragX] = useState(0);
  const item = items[index];
  const many = items.length > 1;
  const step = useCallback((d: number) => onIndex(wrapIndex(index, d, items.length)), [index, items.length, onIndex]);

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtn.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      restore?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (many && e.key === "ArrowRight") step(1);
      else if (many && e.key === "ArrowLeft") step(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, onClose, step]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse") return;
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (swipe.current && many) setDragX(e.clientX - swipe.current.x);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = swipe.current;
    swipe.current = undefined;
    setDragX(0);
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    swiped.current = Math.abs(dx) > 10 || Math.abs(dy) > 10;
    if (many && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) onClose();
  };
  const onCancel = () => {
    swipe.current = undefined;
    setDragX(0);
  };
  const onBackdrop = () => {
    if (swiped.current) swiped.current = false;
    else onClose();
  };

  if (!item) return null;
  const original = originalHref(item.src);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const tool = "inline-flex size-10 items-center justify-center rounded-full text-fg transition hover:bg-surface-2";
  const side = "absolute top-1/2 z-10 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface/90 text-fg shadow-card backdrop-blur transition hover:bg-surface max-sm:hidden";
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.caption || t("message.images.viewer")}
      onClick={onBackdrop}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onCancel}
      className="animate-fade fixed inset-0 z-[70] flex touch-none flex-col bg-bg/95 backdrop-blur-md select-none"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2" onClick={stop}>
        <span className="px-2 text-sm text-muted tabular-nums">{many ? t("message.images.slide", { n: index + 1, total: items.length }) : ""}</span>
        <div className="flex items-center gap-1">
          {original && (
            <a
              href={original.href}
              {...(original.download ? { download: "" } : { target: "_blank", rel: "noopener noreferrer nofollow" })}
              aria-label={original.download ? t("message.images.download") : t("message.images.original")}
              title={original.download ? t("message.images.download") : t("message.images.original")}
              className={tool}
            >
              {original.download ? <Download className="size-5" /> : <ExternalLink className="size-5" />}
            </a>
          )}
          <button ref={closeBtn} type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className={tool}>
            <X className="size-5" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 sm:px-20">
        <img
          key={index}
          src={item.url}
          alt={item.alt ?? item.caption ?? ""}
          draggable={false}
          onClick={stop}
          style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : undefined}
          className="animate-zoom max-h-full max-w-full rounded-xl object-contain shadow-card transition-transform duration-200"
        />
        {many && (
          <>
            <button type="button" aria-label={t("message.images.prev")} onClick={(e) => (stop(e), step(-1))} className={cx(side, "left-4")}>
              <ChevronLeft className="size-5" />
            </button>
            <button type="button" aria-label={t("message.images.next")} onClick={(e) => (stop(e), step(1))} className={cx(side, "right-4")}>
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
      </div>
      <div className="min-h-12 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-sm text-fg" onClick={stop}>
        {item.caption}
      </div>
    </div>,
    document.body,
  );
}

export function ImagesCard({ items }: { items: ImageItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown: Shown[] = items.flatMap((it) => {
    const url = mediaSrc(it.src);
    return url ? [{ ...it, url }] : [];
  });
  const close = useCallback(() => setOpen(null), []);
  if (!shown.length) return null;
  return (
    <div className="my-2">
      {shown.length === 1 ? <SingleImage item={shown[0]} onOpen={() => setOpen(0)} /> : <Carousel items={shown} onOpen={setOpen} />}
      {open !== null && <Lightbox items={shown} index={open} onIndex={setOpen} onClose={close} />}
    </div>
  );
}
