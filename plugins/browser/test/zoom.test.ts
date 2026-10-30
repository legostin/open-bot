import { describe, expect, it } from "vitest";
import { MAX_ZOOM, NO_ZOOM, clampZoom, pan, pinch, zoomAt } from "../ui/src/zoom.ts";

const W = 400;
const H = 300;

describe("zooming the live picture", () => {
  it("never shows less than the whole box nor zooms past the limit", () => {
    expect(clampZoom({ s: 0.5, x: 10, y: 10 }, W, H)).toEqual(NO_ZOOM);
    expect(clampZoom({ s: 2, x: 50, y: -1000 }, W, H)).toEqual({ s: 2, x: 0, y: -300 });
    expect(clampZoom({ s: 9, x: 0, y: 0 }, W, H).s).toBe(MAX_ZOOM);
  });

  it("fills the area around a letterboxed picture once it is large enough, and stays centered until then", () => {
    // A 400×300 picture in the middle of a 400×900 phone area: 300 px of letterbox above and below.
    const area = { x0: 0, y0: -300, x1: 400, y1: 600 };
    expect(clampZoom({ s: 2, x: -100, y: 0 }, W, H, area)).toEqual({ s: 2, x: -100, y: -150 });
    expect(clampZoom({ s: 4, x: -100, y: 200 }, W, H, area)).toEqual({ s: 4, x: -100, y: -300 });
    expect(clampZoom({ s: 4, x: -100, y: -2000 }, W, H, area)).toEqual({ s: 4, x: -100, y: -600 });
  });

  it("keeps the point under the cursor in place", () => {
    const z = zoomAt(NO_ZOOM, 2, { x: 100, y: 100 }, W, H);
    expect(z).toEqual({ s: 2, x: -100, y: -100 });
    // The content point under (100, 100) is still (100 - x) / s = 100.
    expect((100 - z.x) / z.s).toBe(100);
    expect(zoomAt(z, 1, { x: 0, y: 0 }, W, H)).toEqual(NO_ZOOM);
  });

  it("follows two fingers: their distance zooms, their midpoint moves the picture", () => {
    const z = pinch(NO_ZOOM, { x: 200, y: 150 }, 100, { x: 200, y: 150 }, 200, W, H);
    expect(z).toEqual({ s: 2, x: -200, y: -150 });
    const moved = pinch(NO_ZOOM, { x: 200, y: 150 }, 100, { x: 220, y: 140 }, 200, W, H);
    expect(moved).toEqual({ s: 2, x: -180, y: -160 });
  });

  it("pans a zoomed picture and hands the rest to the page at its edge", () => {
    const z = { s: 2, x: -100, y: -100 };
    expect(pan(z, 30, -20, W, H)).toEqual({ z: { s: 2, x: -70, y: -120 }, rest: { x: 0, y: 0 } });
    expect(pan(z, 150, -250, W, H)).toEqual({ z: { s: 2, x: 0, y: -300 }, rest: { x: 50, y: -50 } });
    expect(pan(NO_ZOOM, 10, -10, W, H)).toEqual({ z: NO_ZOOM, rest: { x: 10, y: -10 } });
  });
});
