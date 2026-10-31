import { describe, expect, it } from "vitest";
import { clampView, coverTransform, dismissCommits, doubleTapScale, fitSize, maxScale, panLimit, project, rubber, rubberClamp, rubberScale, swipeCommits, zoomAt } from "./zoom";

describe("fitting", () => {
  it("fits a picture inside the box without blowing it up", () => {
    expect(fitSize({ w: 4000, h: 3000 }, { w: 800, h: 800 })).toEqual({ w: 800, h: 600 });
    expect(fitSize({ w: 1000, h: 4000 }, { w: 800, h: 800 })).toEqual({ w: 200, h: 800 });
    expect(fitSize({ w: 300, h: 200 }, { w: 800, h: 800 })).toEqual({ w: 300, h: 200 });
    expect(fitSize({ w: 0, h: 0 }, { w: 800, h: 600 })).toEqual({ w: 800, h: 600 });
  });

  it("zooms in at least four times, more for a big picture shown small", () => {
    expect(maxScale({ w: 800, h: 600 }, { w: 800, h: 600 })).toBe(4);
    expect(maxScale({ w: 8000, h: 6000 }, { w: 800, h: 600 })).toBe(16);
    expect(maxScale({ w: 4000, h: 3000 }, { w: 800, h: 600 })).toBe(10);
  });

  it("double tap fills the screen when that is a real step, else zooms 2.5×", () => {
    // A tall screenshot on a wide screen: filling the width.
    expect(doubleTapScale({ w: 300, h: 800 }, { w: 1200, h: 800 }, 10)).toBe(4);
    expect(doubleTapScale({ w: 800, h: 600 }, { w: 800, h: 640 }, 10)).toBe(2.5);
    expect(doubleTapScale({ w: 100, h: 800 }, { w: 1600, h: 800 }, 6)).toBe(6);
  });
});

describe("moving", () => {
  it("lets a zoomed picture move only as far as its edges", () => {
    expect(panLimit({ w: 800, h: 600 }, 1, { w: 800, h: 800 })).toEqual({ x: 0, y: 0 });
    expect(panLimit({ w: 800, h: 600 }, 2, { w: 800, h: 800 })).toEqual({ x: 400, y: 200 });
    expect(clampView({ scale: 2, x: 999, y: -999 }, { w: 800, h: 600 }, { w: 800, h: 800 })).toEqual({ scale: 2, x: 400, y: -200 });
  });

  it("keeps the point under the fingers in place while zooming", () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: -50 });
    expect(v).toEqual({ scale: 2, x: -100, y: 50 });
    // The picture point that was under (100, -50) is still there: (100 - x) / scale is unchanged.
    expect((100 - v.x) / v.scale).toBe(100);
    expect(zoomAt(v, 1, { x: 100, y: -50 })).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("pulls back past the limits with growing resistance", () => {
    expect(rubber(0, 500)).toBe(0);
    expect(rubber(100, 500)).toBeGreaterThan(0);
    expect(rubber(100, 500)).toBeLessThan(100);
    expect(rubber(10_000, 500)).toBeLessThan(500);
    expect(rubber(-100, 500)).toBe(-rubber(100, 500));
    expect(rubberClamp(50, 0, 100, 500)).toBe(50);
    expect(rubberClamp(150, 0, 100, 500)).toBeLessThan(150);
    expect(rubberScale(2, 1, 4)).toBe(2);
    expect(rubberScale(0.5, 1, 4)).toBeGreaterThan(0.5);
    expect(rubberScale(0.5, 1, 4)).toBeLessThan(1);
    expect(rubberScale(8, 1, 4)).toBeLessThan(8);
  });

  it("carries a fling on and decides swipes and dismissals", () => {
    expect(project(0)).toBe(0);
    expect(project(1)).toBeCloseTo(199);
    expect(swipeCommits(-300, 0, 1000)).toBe(1);
    expect(swipeCommits(300, 0, 1000)).toBe(-1);
    expect(swipeCommits(-60, -0.8, 1000)).toBe(1);
    expect(swipeCommits(-60, 0.8, 1000)).toBe(0);
    expect(swipeCommits(-100, 0, 1000)).toBe(0);
    expect(dismissCommits(150, 0)).toBe(true);
    expect(dismissCommits(40, 1)).toBe(true);
    expect(dismissCommits(40, -1)).toBe(false);
    expect(dismissCommits(60, 0.1)).toBe(false);
  });
});

describe("opening from a thumbnail", () => {
  it("scales the picture onto the thumbnail and crops it like object-fit: cover", () => {
    const { view, clip } = coverTransform({ cx: 500, cy: 400, w: 800, h: 600 }, { cx: 100, cy: 50, w: 100, h: 100 });
    expect(view).toEqual({ scale: 1 / 6, x: -400, y: -350 });
    // 100 px of thumbnail at 1/6 is 600 px of the box: 100 px cut off each side horizontally, nothing vertically.
    expect(clip.x).toBeCloseTo(100);
    expect(clip.y).toBeCloseTo(0);
  });
});
