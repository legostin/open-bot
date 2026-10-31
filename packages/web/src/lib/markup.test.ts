import { describe, expect, it } from "vitest";
import { addPoint, arrowGeometry, bakeSize, boxOf, constrain, contrastOf, isMeaningful, markedFile, renderMarkup, strokePath, strokeWidth, textLines, textSize, type Ctx, type Shape } from "./markup";

describe("markup geometry", () => {
  it("sizes lines and words by the picture, the highlighter wider", () => {
    const photo = { w: 4032, h: 3024 };
    expect(strokeWidth("pen", 0, photo)).toBeLessThan(strokeWidth("pen", 1, photo));
    expect(strokeWidth("pen", 1, photo)).toBeLessThan(strokeWidth("pen", 2, photo));
    expect(strokeWidth("marker", 1, photo)).toBeCloseTo(strokeWidth("pen", 1, photo) * 3.2, 0);
    // A tiny picture still gets a visible line.
    expect(strokeWidth("pen", 0, { w: 50, h: 50 })).toBeGreaterThanOrEqual(1.5);
    expect(textSize(1, photo)).toBe(169);
    expect(textSize(0, { w: 100, h: 100 })).toBe(12);
  });

  it("outlines light colours in black and dark ones in white", () => {
    expect(contrastOf("#ffcc00")).toBe("#000000");
    expect(contrastOf("#ffffff")).toBe("#000000");
    expect(contrastOf("#111111")).toBe("#ffffff");
    expect(contrastOf("#0a84ff")).toBe("#ffffff");
  });

  it("keeps a stroke's points apart and draws them as a smooth path", () => {
    let pts: number[] = [];
    pts = addPoint(pts, 0, 0, 2);
    pts = addPoint(pts, 1, 1, 2);
    pts = addPoint(pts, 10, 0, 2);
    pts = addPoint(pts, 20, 10, 2);
    expect(pts).toEqual([0, 0, 10, 0, 20, 10]);
    expect(strokePath(pts)).toBe("M0 0Q10 0 15 5L20 10");
    expect(strokePath([5, 5])).toBe("M5 5L5 5");
    expect(strokePath([])).toBe("");
  });

  it("puts the arrow's head at its end, the shaft hidden under it", () => {
    const a = arrowGeometry([0, 0], [100, 0], 4);
    expect(a.head[0]).toEqual([100, 0]);
    // Head 16.8 long and 2 × 10.4 wide; the shaft stops inside it.
    expect(a.head[1][0]).toBeCloseTo(83.2);
    expect(Math.abs(a.head[1][1])).toBeCloseTo(10.416);
    expect(a.head[1][1]).toBeCloseTo(-a.head[2][1]);
    expect(a.shaftEnd[0]).toBeGreaterThan(83.2);
    expect(a.shaftEnd[0]).toBeLessThan(100);
    // A short arrow keeps a head smaller than itself.
    expect(arrowGeometry([0, 0], [10, 0], 4).head[1][0]).toBeCloseTo(4);
  });

  it("holds arrows to 45° and frames to squares with Shift", () => {
    expect(constrain("arrow", [0, 0], [100, 10])).toEqual([100.499, 0]);
    expect(constrain("arrow", [0, 0], [50, 60])[0]).toBeCloseTo(constrain("arrow", [0, 0], [50, 60])[1]);
    expect(constrain("rect", [10, 10], [40, -50])).toEqual([70, -50]);
    expect(constrain("ellipse", [0, 0], [-20, 5])).toEqual([-20, 20]);
  });

  it("spans boxes either way and keeps only shapes worth keeping", () => {
    expect(boxOf([50, 40], [10, 0])).toEqual({ x: 10, y: 0, w: 40, h: 40 });
    expect(isMeaningful({ kind: "pen", color: "#f00", width: 4, points: [1, 1] })).toBe(true);
    expect(isMeaningful({ kind: "arrow", color: "#f00", width: 4, from: [0, 0], to: [3, 3] })).toBe(false);
    expect(isMeaningful({ kind: "rect", color: "#f00", width: 4, from: [0, 0], to: [30, 30] })).toBe(true);
    expect(isMeaningful({ kind: "text", color: "#f00", size: 20, at: [0, 0], text: "  " })).toBe(false);
    expect(textLines("one\ntwo  \n")).toEqual(["one", "two"]);
  });

  it("bakes at the picture's size, smaller past the canvas limit", () => {
    expect(bakeSize({ w: 4032, h: 3024 })).toEqual({ w: 4032, h: 3024, k: 1 });
    const big = bakeSize({ w: 8064, h: 6048 });
    expect(big.w * big.h).toBeLessThanOrEqual(16_000_000);
    expect(big.w / big.h).toBeCloseTo(8064 / 6048, 2);
  });

  it("names the marked copy after the original", () => {
    expect(markedFile("IMG_1.HEIC", "image/heic")).toEqual({ name: "IMG_1.jpg", type: "image/jpeg" });
    expect(markedFile("shot.png", "image/png")).toEqual({ name: "shot.png", type: "image/png" });
    expect(markedFile("anim.gif", "image/gif")).toEqual({ name: "anim.png", type: "image/png" });
    expect(markedFile("", "image/png")).toEqual({ name: "image.png", type: "image/png" });
  });
});

describe("baking marks", () => {
  it("draws every kind of mark, scaled with the picture", () => {
    const calls: string[] = [];
    const rec = new Proxy({} as Record<string, unknown>, {
      get: (target, p: string) => (p in target ? target[p] : (...args: unknown[]) => calls.push(`${p}(${args.map((a) => (typeof a === "number" ? Math.round(a * 10) / 10 : a)).join(",")})`)),
      set: (target, p: string, v) => {
        target[p] = v;
        if (p === "globalAlpha" || p === "font") calls.push(`${p}=${v}`);
        return true;
      },
    }) as unknown as Ctx;
    const shapes: Shape[] = [
      { kind: "marker", color: "#ffcc00", width: 10, points: [0, 0, 10, 0, 20, 10] },
      { kind: "pen", color: "#ff3b30", width: 4, points: [5, 5] },
      { kind: "rect", color: "#ff3b30", width: 4, from: [40, 40], to: [0, 0] },
      { kind: "ellipse", color: "#ff3b30", width: 4, from: [0, 0], to: [20, 10] },
      { kind: "text", color: "#ffffff", size: 20, at: [1, 2], text: "hi\nthere" },
    ];
    renderMarkup(rec, shapes, 0.5);
    expect(calls).toContain("globalAlpha=0.4");
    expect(calls).toContain("quadraticCurveTo(5,0,7.5,2.5)");
    expect(calls).toContain("arc(2.5,2.5,1,0,6.3)");
    expect(calls).toContain("roundRect(0,0,20,20,3)");
    expect(calls).toContain("ellipse(5,2.5,5,2.5,0,0,6.3)");
    expect(calls.some((c) => c.startsWith("font=700 10px"))).toBe(true);
    // Line 2's baseline: (2 + 20 × (0.95 + 1.2)) × 0.5.
    expect(calls).toContain("fillText(there,0.5,22.5)");
  });
});
