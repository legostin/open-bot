// An OpenStreetMap map an agent shows (a `map` part). Leaflet loads on demand, once the card scrolls into view, so
// the main bundle stays small; tiles come through the hub (/api/map/tiles), which caches them. The map ignores the
// scroll wheel (and, on touch screens, one-finger drags) until it is clicked, so the chat scrolls past it freely.

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Map as MapIcon, MapPin } from "lucide-react";
import type { MessagePart } from "@owlbot/shared";
import type * as Leaflet from "leaflet";
import { formatCoords, OSM_COPYRIGHT, osmLink, TILE_URL } from "../../lib/media";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

type MapPart = Extract<MessagePart, { type: "map" }>;

let leaflet: Promise<typeof Leaflet> | undefined;
function loadLeaflet(): Promise<typeof Leaflet> {
  leaflet ??= Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([m]) => ((m as unknown as { default?: typeof Leaflet }).default ?? m) as typeof Leaflet);
  return leaflet;
}

/** Text in a tooltip as a DOM node: Leaflet would put a string in as HTML, and labels come from the model. */
function label(text: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

export function MapCard({ part }: { part: MapPart }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "ready" | "error">("idle");
  const [active, setActive] = useState(false);
  const [nudge, setNudge] = useState(false);
  const place = part.title ?? formatCoords(part.lat, part.lon);
  const key = JSON.stringify([part.lat, part.lon, part.zoom, part.title, part.markers]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let map: Leaflet.Map | undefined;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const start = async () => {
      let L: typeof Leaflet;
      try {
        L = await loadLeaflet();
      } catch {
        if (!cancelled) setState("error");
        return;
      }
      if (cancelled) return;
      const touch = matchMedia("(pointer: coarse)").matches;
      const m = L.map(el, { scrollWheelZoom: false, dragging: !touch, attributionControl: false, zoomSnap: 0.5, worldCopyJump: true });
      map = m;
      L.control.attribution({ prefix: false, position: "bottomright" }).addTo(m);
      const link = document.createElement("a");
      link.href = OSM_COPYRIGHT;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = t("message.map.attribution");
      L.tileLayer(TILE_URL, { maxZoom: 19, minZoom: 1, attribution: link.outerHTML }).addTo(m);

      const icon = L.divIcon({ className: "owl-pin", html: '<span class="owl-pin-dot"></span>', iconSize: [22, 22], iconAnchor: [11, 11], tooltipAnchor: [0, -10] });
      // Without markers the centre gets one; its label is the title, which the caption already shows.
      const own = !!part.markers?.length;
      const points = own ? part.markers! : [{ lat: part.lat, lon: part.lon, label: part.title }];
      for (const p of points) {
        const mk = L.marker([p.lat, p.lon], { icon, keyboard: false }).addTo(m);
        if (p.label) mk.bindTooltip(label(p.label), { permanent: own && points.length <= 6, direction: "top", className: "owl-map-label", opacity: 1 });
      }
      if (part.zoom) m.setView([part.lat, part.lon], part.zoom);
      else if (points.length > 1) m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number])), { padding: [40, 40], maxZoom: 16 });
      else m.setView([part.lat, part.lon], 15);

      // Interactive after a click; leaving the map (or touching outside it) makes the page scroll again.
      const on = () => {
        m.scrollWheelZoom.enable();
        m.dragging.enable();
        setActive(true);
      };
      const off = () => {
        m.scrollWheelZoom.disable();
        if (touch) m.dragging.disable();
        setActive(false);
      };
      m.on("click", on);
      m.on("zoomstart", () => setNudge(false));
      const outside = (e: PointerEvent) => !el.contains(e.target as Node) && off();
      el.addEventListener("mouseleave", off);
      document.addEventListener("pointerdown", outside);
      cleanups.push(() => {
        el.removeEventListener("mouseleave", off);
        document.removeEventListener("pointerdown", outside);
      });
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => m.invalidateSize());
        ro.observe(el);
        cleanups.push(() => ro.disconnect());
      }
      setState("ready");
    };

    if (typeof IntersectionObserver === "undefined") void start();
    else {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          void start();
        },
        { rootMargin: "300px" },
      );
      io.observe(el);
      cleanups.push(() => io.disconnect());
    }
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
      map?.remove();
      setState("idle");
      setActive(false);
    };
    // The part's content is the dependency: a new object with the same content must not rebuild the map.
  }, [key]);

  // A touch on an inactive map says how to use it, for a moment.
  useEffect(() => {
    if (!nudge) return;
    const id = setTimeout(() => setNudge(false), 1800);
    return () => clearTimeout(id);
  }, [nudge]);

  return (
    <figure className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-xl" aria-label={t("message.map.label", { place })}>
      <div className="group/map relative isolate h-[260px]" onTouchStart={() => !active && setNudge(true)}>
        <div ref={box} className="owl-map absolute inset-0" />
        {state !== "ready" && (
          <div className={cx("pointer-events-none absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 bg-surface-2 text-sm text-muted", state === "idle" && "animate-pulse")}>
            <MapIcon className="size-6" />
            {state === "error" && t("message.map.failed")}
          </div>
        )}
        {state === "ready" && !active && (
          <div
            className={cx(
              "pointer-events-none absolute inset-x-0 bottom-3 z-[1000] flex justify-center transition-opacity duration-300",
              nudge ? "opacity-100" : "opacity-0 group-hover/map:opacity-100",
            )}
          >
            <span className="rounded-full border border-border bg-surface/90 px-3 py-1 text-xs text-fg shadow-card backdrop-blur">{t("message.map.hint")}</span>
          </div>
        )}
      </div>
      <figcaption className="flex items-center gap-2 border-t border-border px-3 py-2 text-sm">
        <MapPin className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={place}>
          {place}
        </span>
        <a
          href={osmLink(part.lat, part.lon, part.zoom ?? 16)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          {t("message.map.open")} <ExternalLink className="size-3.5" />
        </a>
      </figcaption>
    </figure>
  );
}
