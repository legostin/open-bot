// A map card's "Open in…" links: the place, or the route with its stops and way of travel, in a maps app (on a phone
// each link opens the app when it is installed). Apple Maps, Google Maps and OpenStreetMap are built in; plugins add
// more (ui.maps.addApp: Yandex Maps and 2GIS come with the yandex-2gis plugin). And a route's length and time.
import type { MapMarker, MessagePart, RouteMode } from "@owlbot/shared";
import type { MapAppContribution, MapAppPlace, MapAppRoute } from "@owlbot/ui";
import { formatNumber } from "../i18n";
import { osmLink } from "./media";

type MapPart = Extract<MessagePart, { type: "map" }>;

/** A maps app without its title (the card names the built-in ones in the interface language). */
export type MapApp = Omit<MapAppContribution, "title">;

const ll = (p: { lat: number; lon: number }) => `${p.lat},${p.lon}`;

function url(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const APPLE: Record<RouteMode, string> = { walk: "w", drive: "d", bike: "w", transit: "r" };
const GOOGLE: Record<RouteMode, string> = { walk: "walking", drive: "driving", bike: "bicycling", transit: "transit" };
const OSM: Record<RouteMode, string> = { walk: "fossgis_osrm_foot", drive: "fossgis_osrm_car", bike: "fossgis_osrm_bike", transit: "fossgis_osrm_foot" };

/** Apple Maps and OpenStreetMap take only the start and the end of a route; Google Maps takes the stops between. */
export const BUILTIN_MAP_APPS: MapApp[] = [
  {
    id: "apple",
    place: (p) => url("https://maps.apple.com/", { ll: ll(p), q: p.label ?? ll(p) }),
    route: (r) => url("https://maps.apple.com/", { saddr: ll(r.stops[0]), daddr: ll(r.stops[r.stops.length - 1]), dirflg: APPLE[r.mode] }),
  },
  {
    id: "google",
    place: (p) => url("https://www.google.com/maps/search/", { api: "1", query: ll(p) }),
    route: (r) => {
      const via = r.stops.slice(1, -1);
      return url("https://www.google.com/maps/dir/", {
        api: "1",
        origin: ll(r.stops[0]),
        destination: ll(r.stops[r.stops.length - 1]),
        waypoints: via.length ? via.map(ll).join("|") : undefined,
        travelmode: GOOGLE[r.mode],
      });
    },
  },
  {
    id: "osm",
    place: (p) => osmLink(p.lat, p.lon, p.zoom),
    route: (r) => url("https://www.openstreetmap.org/directions", { engine: OSM[r.mode], route: `${ll(r.stops[0])};${ll(r.stops[r.stops.length - 1])}` }),
  },
];

/**
 * What "Open in…" opens for a map: the chosen place (`selected`, a marker index), else the route through its stops,
 * else the only marker or the centre.
 */
export function mapTarget(part: MapPart, selected?: number): { route: MapAppRoute } | { place: MapAppPlace } {
  const markers = part.markers ?? [];
  const stops = part.route?.stops.map((i) => markers[i]).filter((m): m is MapMarker => !!m) ?? [];
  if (selected === undefined && part.route && stops.length >= 2) return { route: { mode: part.route.mode, stops: stops.map(({ lat, lon, label }) => ({ lat, lon, ...(label ? { label } : {}) })) } };
  const one = selected !== undefined ? markers[selected] : markers.length === 1 ? markers[0] : undefined;
  const p = one ?? { lat: part.lat, lon: part.lon };
  const label = one?.label ?? (markers.length <= 1 ? part.title : undefined);
  return { place: { lat: p.lat, lon: p.lon, ...(label ? { label } : {}), zoom: Math.max(1, Math.min(19, Math.round(one ? 17 : (part.zoom ?? 15)))) } };
}

/** An app's link for the target; an app that cannot plan a route opens its destination. */
export function appLink(app: MapApp, target: ReturnType<typeof mapTarget>): string | undefined {
  try {
    if ("place" in target) return app.place(target.place);
    const routed = app.route?.(target.route);
    if (routed) return routed;
    const end = target.route.stops[target.route.stops.length - 1];
    return app.place({ ...end, zoom: 17 });
  } catch {
    return undefined;
  }
}

/** "850 m", "2.4 km" in the interface language. */
export function formatDistance(m: number): string {
  return m < 1000
    ? formatNumber(Math.round(m / 10) * 10, { style: "unit", unit: "meter", unitDisplay: "short" })
    : formatNumber(m / 1000, { style: "unit", unit: "kilometer", unitDisplay: "short", maximumFractionDigits: m < 10_000 ? 1 : 0 });
}

/** "31 min", "1 h 20 min" in the interface language. */
export function formatTravelTime(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  const h = Math.floor(min / 60);
  const rest = min % 60;
  const minutes = formatNumber(rest, { style: "unit", unit: "minute", unitDisplay: "short" });
  if (!h) return minutes;
  const hours = formatNumber(h, { style: "unit", unit: "hour", unitDisplay: "short" });
  return rest ? `${hours} ${minutes}` : hours;
}
