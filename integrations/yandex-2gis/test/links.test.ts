import { describe, expect, it } from "vitest";
import type { MapAppRoute } from "@piomio/ui";
import { dgis, yandex } from "../ui/src/links.ts";

const walk: MapAppRoute = {
  mode: "walk",
  stops: [
    { lat: 43.2567, lon: 76.9286 },
    { lat: 43.25, lon: 76.95 },
    { lat: 43.2389, lon: 76.9455 },
  ],
};

describe("Yandex Maps and 2GIS links", () => {
  it("open a route planned, with every stop in Yandex and the ends in 2GIS", () => {
    expect(yandex.route!(walk)).toBe("https://yandex.ru/maps/?rtext=43.2567%2C76.9286%7E43.25%2C76.95%7E43.2389%2C76.9455&rtt=pd");
    expect(yandex.route!({ ...walk, mode: "transit" })).toMatch(/rtt=mt$/);
    expect(dgis.route!(walk)).toBe("https://2gis.ru/routeSearch/rsType/pedestrian/from/76.9286,43.2567/to/76.9455,43.2389");
    expect(dgis.route!({ ...walk, mode: "drive" })).toMatch(/rsType\/car\//);
    expect(dgis.route!({ ...walk, mode: "transit" })).toMatch(/rsType\/ctx\//);
  });

  it("open a place, longitude first", () => {
    expect(yandex.place({ lat: 43.2389, lon: 76.9455, zoom: 17 })).toBe("https://yandex.ru/maps/?pt=76.9455%2C43.2389&z=17&l=map");
    expect(dgis.place({ lat: 43.2389, lon: 76.9455, zoom: 17 })).toBe("https://2gis.ru/geo/76.9455,43.2389");
  });
});
