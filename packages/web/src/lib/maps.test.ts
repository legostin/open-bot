import { describe, expect, it } from "vitest";
import type { MessagePart } from "@owlbot/shared";
import { appLink, BUILTIN_MAP_APPS, formatDistance, formatTravelTime, mapTarget, type MapApp } from "./maps";

type MapPart = Extract<MessagePart, { type: "map" }>;

const walk: MapPart = {
  type: "map",
  lat: 43.25,
  lon: 76.94,
  title: "Evening walk",
  markers: [
    { lat: 43.2567, lon: 76.9286, label: "Hotel" },
    { lat: 43.25, lon: 76.95, label: "Coffee" },
    { lat: 43.2389, lon: 76.9455, label: "Kok-Tobe" },
  ],
  route: { mode: "walk", stops: [0, 1, 2], path: [] },
};

const app = (id: string) => BUILTIN_MAP_APPS.find((a) => a.id === id)!;
const href = (part: MapPart, id: string, selected?: number) => appLink(app(id), mapTarget(part, selected));

describe("open a map in a maps app", () => {
  it("hands a route over with its stops and the way of travel", () => {
    expect(href(walk, "google")).toBe(
      "https://www.google.com/maps/dir/?api=1&origin=43.2567%2C76.9286&destination=43.2389%2C76.9455&waypoints=43.25%2C76.95&travelmode=walking",
    );
    expect(href(walk, "apple")).toBe("https://maps.apple.com/?saddr=43.2567%2C76.9286&daddr=43.2389%2C76.9455&dirflg=w");
    expect(href({ ...walk, route: { ...walk.route!, mode: "transit" } }, "google")).toMatch(/travelmode=transit$/);
    expect(href({ ...walk, route: { ...walk.route!, mode: "drive" } }, "osm")).toBe(
      "https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=43.2567%2C76.9286%3B43.2389%2C76.9455",
    );
  });

  it("opens the chosen place, the only one, or the centre", () => {
    expect(href(walk, "apple", 2)).toBe("https://maps.apple.com/?ll=43.2389%2C76.9455&q=Kok-Tobe");
    expect(href(walk, "osm", 2)).toBe("https://www.openstreetmap.org/?mlat=43.2389&mlon=76.9455#map=17/43.2389/76.9455");
    const one: MapPart = { type: "map", lat: 1, lon: 2, title: "Meeting point" };
    expect(href(one, "google")).toBe("https://www.google.com/maps/search/?api=1&query=1%2C2");
    expect(href(one, "apple")).toBe("https://maps.apple.com/?ll=1%2C2&q=Meeting+point");
  });

  it("opens a route's destination in an app that cannot plan it, and skips an app that fails", () => {
    const placesOnly: MapApp = { id: "x", place: (p) => `x://${p.lat},${p.lon},${p.zoom}` };
    expect(appLink(placesOnly, mapTarget(walk))).toBe("x://43.2389,76.9455,17");
    expect(appLink({ id: "bad", place: () => { throw new Error("no"); } }, mapTarget(walk, 0))).toBeUndefined();
  });

  it("says a route's length and time the way people do", () => {
    expect(formatDistance(847)).toMatch(/^850\s?m$/);
    expect(formatDistance(2412)).toMatch(/^2\.4\s?km$/);
    expect(formatDistance(23_400)).toMatch(/^23\s?km$/);
    expect(formatTravelTime(1830)).toMatch(/^31\s?min$/);
    expect(formatTravelTime(4800)).toMatch(/^1\s?hr 20\s?min$/);
    expect(formatTravelTime(7200)).toMatch(/^2\s?hr$/);
  });
});
