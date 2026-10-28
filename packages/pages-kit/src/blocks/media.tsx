// Pictures and video: a swipeable gallery, a video (YouTube and Vimeo open in their apps, files play here), a hero
// header with a picture.
import { useEffect, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, type CarouselApi } from "../ui/carousel";
import { cn } from "../lib/utils";
import { t } from "../i18n";
import { openLink, proxied } from "../runtime";

export type GalleryImage = string | { src: string; alt?: string; caption?: string };

export interface GalleryProps {
  images: GalleryImage[];
  /** Width / height of a slide (default 16 / 10). */
  aspect?: number;
  className?: string;
}

export function Gallery({ images, aspect = 16 / 10, className }: GalleryProps) {
  const [api, setApi] = useState<CarouselApi>();
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!api) return;
    const on = () => setAt(api.selectedScrollSnap());
    api.on("select", on);
    return () => void api.off("select", on);
  }, [api]);
  const items = images.map((i) => (typeof i === "string" ? { src: i } : i));
  if (!items.length) return null;
  return (
    <Carousel setApi={setApi} className={cn("group relative w-full", className)} opts={{ loop: items.length > 1 }}>
      <CarouselContent>
        {items.map((img, i) => (
          <CarouselItem key={i}>
            <figure className="relative overflow-hidden rounded-xl bg-muted" style={{ aspectRatio: aspect }}>
              <img src={proxied(img.src)} alt={img.alt ?? img.caption ?? ""} loading="lazy" className="size-full object-cover" />
              {img.caption && (
                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pt-10 pb-3 text-sm text-white">{img.caption}</figcaption>
              )}
            </figure>
          </CarouselItem>
        ))}
      </CarouselContent>
      {items.length > 1 && (
        <>
          <CarouselPrevious className="left-3 opacity-0 transition group-hover:opacity-100 max-sm:hidden" />
          <CarouselNext className="right-3 opacity-0 transition group-hover:opacity-100 max-sm:hidden" />
          <div className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/50 px-2 py-0.5 text-xs font-medium text-white tabular-nums backdrop-blur">
            {at + 1} / {items.length}
          </div>
        </>
      )}
    </Carousel>
  );
}

export interface VideoProps {
  /** A YouTube or Vimeo link, or a video file's URL. */
  src: string;
  title?: string;
  poster?: string;
  className?: string;
}

function youTubeId(url: string): string | undefined {
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/i.exec(url);
  return m?.[1];
}

export function Video({ src, title, poster, className }: VideoProps) {
  const yt = youTubeId(src);
  const external = yt || /vimeo\.com\//i.test(src);
  if (!external) {
    return <video src={src} poster={proxied(poster)} controls playsInline preload="metadata" className={cn("aspect-video w-full rounded-xl bg-black", className)} title={title} />;
  }
  const cover = poster ?? (yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : undefined);
  return (
    <button
      type="button"
      onClick={() => openLink(src)}
      aria-label={title ? `${t("video.watch")}: ${title}` : t("video.watch")}
      className={cn("group relative block aspect-video w-full overflow-hidden rounded-xl bg-neutral-900 text-left", className)}
    >
      {cover && <img src={proxied(cover)} alt="" loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" />}
      <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
      <span className="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-neutral-900 shadow-lg transition group-hover:scale-105">
        <Play className="ml-1 size-7 fill-current" />
      </span>
      {title && <span className="absolute inset-x-0 bottom-0 line-clamp-2 px-4 pb-3 text-sm font-medium text-white">{title}</span>}
    </button>
  );
}

export interface HeroProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A small line above the title: a date, a place, a kind. */
  eyebrow?: ReactNode;
  image?: string;
  children?: ReactNode;
  className?: string;
}

export function Hero({ title, subtitle, eyebrow, image, children, className }: HeroProps) {
  if (!image) {
    return (
      <header className={cn("space-y-3 py-2", className)}>
        {eyebrow && <div className="text-sm font-medium text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {subtitle && <p className="text-lg text-pretty text-muted-foreground">{subtitle}</p>}
        {children}
      </header>
    );
  }
  return (
    <header className={cn("relative isolate overflow-hidden rounded-2xl bg-neutral-900 text-white", className)}>
      <img src={proxied(image)} alt="" className="absolute inset-0 -z-10 size-full object-cover" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/30 to-black/5" />
      <div className="flex min-h-72 flex-col justify-end gap-2 p-6 sm:min-h-96 sm:p-8">
        {eyebrow && <div className="text-sm font-medium text-white/80">{eyebrow}</div>}
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">{title}</h1>
        {subtitle && <p className="max-w-2xl text-base text-pretty text-white/85 sm:text-lg">{subtitle}</p>}
        {children}
      </div>
    </header>
  );
}
