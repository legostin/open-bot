import type { MapIcon } from "./types.ts";

// A record, so the compiler checks that every symbol is listed.
const ICONS: Record<MapIcon, true> = {
  pin: true,
  food: true,
  cafe: true,
  bar: true,
  hotel: true,
  sight: true,
  museum: true,
  park: true,
  shop: true,
  transport: true,
  parking: true,
  fuel: true,
  hospital: true,
  home: true,
  work: true,
  photo: true,
  star: true,
  start: true,
  finish: true,
  user: true,
};

/** Every marker symbol a map can show, for the show_map tool's schema and the web UI. */
export const MAP_ICONS = Object.keys(ICONS) as MapIcon[];
