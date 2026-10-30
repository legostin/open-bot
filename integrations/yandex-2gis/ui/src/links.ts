// Links to Yandex Maps and 2GIS (https, so a phone opens the app when it is installed, else the website).
// Yandex: https://yandex.com/dev/yandex-apps-launch-maps/doc/en/concepts/yandexmaps-web — rtext takes lat,lon stops
// joined with "~", rtt the way of travel. 2GIS: routeSearch from one point to another, longitude first.
import type { MapAppContribution, MapAppPlace, MapAppRoute } from "@owlbot/ui";

type Links = Pick<MapAppContribution, "place" | "route">;
type Mode = MapAppRoute["mode"];

const YANDEX_MODE: Record<Mode, string> = { walk: "pd", drive: "auto", bike: "bc", transit: "mt" };
/** 2GIS has no cycling route in its links: a bike route opens as a walking one. */
const DGIS_MODE: Record<Mode, string> = { walk: "pedestrian", drive: "car", bike: "pedestrian", transit: "ctx" };

const lonLat = (p: { lat: number; lon: number }) => `${p.lon},${p.lat}`;

export const yandex: Links = {
  place: (p: MapAppPlace) => `https://yandex.ru/maps/?${new URLSearchParams({ pt: lonLat(p), z: String(p.zoom), l: "map" })}`,
  route: (r: MapAppRoute) => `https://yandex.ru/maps/?${new URLSearchParams({ rtext: r.stops.map((s) => `${s.lat},${s.lon}`).join("~"), rtt: YANDEX_MODE[r.mode] })}`,
};

export const dgis: Links = {
  place: (p: MapAppPlace) => `https://2gis.ru/geo/${lonLat(p)}`,
  route: (r: MapAppRoute) => `https://2gis.ru/routeSearch/rsType/${DGIS_MODE[r.mode]}/from/${lonLat(r.stops[0])}/to/${lonLat(r.stops[r.stops.length - 1])}`,
};
