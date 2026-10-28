// A Leaflet map on OpenStreetMap tiles (through the page's tile route): numbered places, a route along roads or
// paths (the hub's router) or a given line, fitted to what it shows.
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "../lib/utils";
import { t } from "../i18n";

export interface MapPlace {
  lat: number;
  lon: number;
  label?: string;
  note?: string;
  /** A CSS colour for this place's pin. */
  color?: string;
}

export interface MapProps {
  places?: MapPlace[];
  /** "walk" | "drive" | "bike": along roads and paths through the places in order; or your own line of [lat, lon]. */
  route?: "walk" | "drive" | "bike" | Array<[number, number]>;
  center?: [number, number];
  zoom?: number;
  /** Pins show their number (1, 2, …) instead of a dot. */
  numbered?: boolean;
  /** The place to highlight and bring into view. */
  selected?: number;
  onSelect?: (index: number) => void;
  height?: number | string;
  className?: string;
}

interface RouteInfo {
  path: Array<[number, number]>;
  distanceM?: number;
  durationS?: number;
}

const pin = (n: number | undefined, color: string | undefined, active: boolean) =>
  L.divIcon({
    className: "",
    html: `<div class="owl-pin${active ? " owl-pin-active" : ""}"${color ? ` style="--pin:${color.replace(/["<>]/g, "")}"` : ""}>${n ?? ""}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

export function Map({ places = [], route, center, zoom, numbered = true, selected, onSelect, height = 320, className }: MapProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fit = useRef<() => void>(() => {});
  const [line, setLine] = useState<RouteInfo>();
  const placesKey = JSON.stringify(places);
  const routeKey = JSON.stringify(route ?? null);

  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, { zoomControl: true, attributionControl: false, scrollWheelZoom: false });
    L.control.attribution({ prefix: false }).addTo(m);
    L.tileLayer("tiles/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // The box may get its size after the map (the page's styles arrive a moment later): fit again then.
    let had = box.current.clientHeight > 0;
    const resize = new ResizeObserver(() => {
      m.invalidateSize();
      const has = (box.current?.clientHeight ?? 0) > 0;
      if (has && !had) fit.current();
      had = has;
    });
    resize.observe(box.current);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  // The route: the hub's road route through the places, or the line given.
  useEffect(() => {
    if (!route) return setLine(undefined);
    if (Array.isArray(route)) return setLine({ path: route });
    if (places.length < 2) return setLine(undefined);
    let live = true;
    const points = places.map((p) => `${p.lat},${p.lon}`).join(";");
    fetch(`route?mode=${route}&points=${encodeURIComponent(points)}`)
      .then((r) => (r.ok ? (r.json() as Promise<RouteInfo>) : Promise.reject()))
      .then((r) => live && setLine(r))
      .catch(() => live && setLine({ path: places.map((p) => [p.lat, p.lon] as [number, number]) }));
    return () => {
      live = false;
    };
  }, [routeKey, placesKey]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: Array<[number, number]> = [];
    if (line?.path.length) {
      L.polyline(line.path, { className: "owl-route", color: "#2563eb", weight: 5, opacity: 0.85, lineJoin: "round" }).addTo(g);
      bounds.push(...line.path);
    }
    places.forEach((p, i) => {
      const marker = L.marker([p.lat, p.lon], { icon: pin(numbered ? i + 1 : undefined, p.color, i === selected), zIndexOffset: i === selected ? 1000 : 0 }).addTo(g);
      if (p.label || p.note) {
        const tip = document.createElement("div");
        const b = document.createElement("b");
        b.textContent = p.label ?? "";
        tip.append(b);
        if (p.note) tip.append(document.createElement("br"), p.note);
        marker.bindTooltip(tip, { direction: "top", offset: [0, -12] });
      }
      if (onSelect) marker.on("click", () => onSelect(i));
      bounds.push([p.lat, p.lon]);
    });
    fit.current = () => {
      if (center) m.setView(center, zoom ?? 14);
      else if (bounds.length > 1) m.fitBounds(L.latLngBounds(bounds), { padding: [28, 28], maxZoom: zoom ?? 17 });
      else if (bounds.length === 1) m.setView(bounds[0], zoom ?? 15);
      else m.setView([0, 0], 2);
    };
    fit.current();
  }, [placesKey, line, selected, center?.[0], center?.[1], zoom, numbered]);

  // A chosen place comes into view.
  useEffect(() => {
    const p = selected !== undefined ? places[selected] : undefined;
    if (p && map.current) map.current.panTo([p.lat, p.lon], { animate: true });
  }, [selected]);

  const km = line?.distanceM !== undefined ? (line.distanceM / 1000).toFixed(1) : undefined;
  const min = line?.durationS !== undefined ? Math.max(1, Math.round(line.durationS / 60)) : undefined;
  return (
    // Inline positions: Leaflet reads them when it starts, before Tailwind has styled the page.
    <div className={cn("isolate overflow-hidden rounded-xl border bg-muted", className)} style={{ position: "relative", height }}>
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {km && min !== undefined && (
        <div className="pointer-events-none absolute top-3 right-3 z-[500] rounded-full bg-background/90 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur">
          {t("map.route", { km, min })}
        </div>
      )}
    </div>
  );
}
