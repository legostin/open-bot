// A place worth going to: its picture, why go, hours, price and rating, with a route in a maps app, its site, and a
// question to the agent about it. And a small number with a label (Stat).
import type { ReactNode } from "react";
import { ArrowUpRight, Clock, MapPin, MessageCircle, Navigation, Sparkles, Star, Wallet } from "lucide-react";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { t } from "../i18n";
import { ask, openLink, proxied } from "../runtime";

export interface PlaceProps {
  name: string;
  /** Its number in a list or on the map. */
  index?: number;
  image?: string;
  description?: ReactNode;
  /** Why it is worth it: one or two lines, shown highlighted. */
  why?: ReactNode;
  address?: string;
  hours?: string;
  price?: string;
  /** 0–5. */
  rating?: number;
  tags?: string[];
  lat?: number;
  lon?: number;
  url?: string;
  /** Highlighted (e.g. chosen on the map). */
  active?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
}

const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);

export function directionsUrl(lat: number, lon: number, name?: string): string {
  return apple
    ? `https://maps.apple.com/?daddr=${lat},${lon}${name ? `&q=${encodeURIComponent(name)}` : ""}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function Place({ name, index, image, description, why, address, hours, price, rating, tags, lat, lon, url, active, onClick, children, className }: PlaceProps) {
  const hasSpot = typeof lat === "number" && typeof lon === "number";
  return (
    <Card
      onClick={onClick}
      className={cn("gap-0 overflow-hidden py-0 transition", onClick && "cursor-pointer hover:shadow-md", active && "ring-2 ring-primary", className)}
    >
      {image && (
        <div className="relative aspect-[16/9] bg-muted">
          <img src={proxied(image)} alt="" loading="lazy" className="size-full object-cover" />
          {index !== undefined && (
            <span className="absolute top-3 left-3 flex size-8 items-center justify-center rounded-full bg-background text-sm font-semibold shadow">{index}</span>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-start gap-3">
          {!image && index !== undefined && (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{index}</span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-lg leading-tight font-semibold">{name}</h3>
            {(rating !== undefined || tags?.length) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {rating !== undefined && (
                  <span className="inline-flex items-center gap-1 text-sm font-medium">
                    <Star className="size-4 fill-amber-400 text-amber-400" />
                    {rating.toFixed(1)}
                  </span>
                )}
                {tags?.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
        {description && <div className="text-sm leading-relaxed">{description}</div>}
        {why && (
          <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div>{why}</div>
          </div>
        )}
        {(address || hours || price) && (
          <div className="flex flex-col gap-1.5">
            {address && <Row icon={<MapPin />}>{address}</Row>}
            {hours && <Row icon={<Clock />}>{hours}</Row>}
            {price && <Row icon={<Wallet />}>{price}</Row>}
          </div>
        )}
        {children}
        <div className="flex flex-wrap gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          {hasSpot && (
            <Button size="sm" onClick={() => openLink(directionsUrl(lat, lon, name))}>
              <Navigation />
              {t("place.route")}
            </Button>
          )}
          {url && (
            <Button size="sm" variant="outline" onClick={() => openLink(url)}>
              <ArrowUpRight />
              {t("place.site")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => ask(t("place.ask", { name }))}>
            <MessageCircle />
            {t("place.more")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function Stat({ label, value, hint, icon, className }: StatProps) {
  return (
    <Card className={cn("gap-1 px-5 py-4", className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground [&_svg]:size-4">
        {icon}
        {label}
      </div>
      <div className="text-xl leading-tight font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}
