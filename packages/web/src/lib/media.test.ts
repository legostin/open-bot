import { describe, expect, it } from "vitest";
import { activeSlide, formatCoords, isLocalSrc, mediaSrc, osmLink } from "./media";

describe("mediaSrc", () => {
  it("sends web images through the hub's proxy", () => {
    expect(mediaSrc("https://upload.wikimedia.org/a b.jpg?w=1&h=2")).toBe(`/api/media?url=${encodeURIComponent("https://upload.wikimedia.org/a b.jpg?w=1&h=2")}`);
    expect(mediaSrc("HTTP://example.com/x.png")).toBe("/api/media?url=HTTP%3A%2F%2Fexample.com%2Fx.png");
  });

  it("serves workspace files from /api/files", () => {
    expect(mediaSrc("file:assistant/conv_1/chart & co.png")).toBe("/api/files?path=assistant%2Fconv_1%2Fchart%20%26%20co.png");
    expect(mediaSrc("file:")).toBeUndefined();
  });

  it("keeps same-origin and inline sources and drops everything else", () => {
    expect(mediaSrc("/api/files?path=x.png")).toBe("/api/files?path=x.png");
    expect(mediaSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    for (const bad of ["//evil.example/x.png", "javascript:alert(1)", "ftp://example.com/x.png", "data:text/html,<b>", "x.png"]) expect(mediaSrc(bad), bad).toBeUndefined();
    expect(isLocalSrc("blob:https://hub/123")).toBe(true);
    expect(isLocalSrc("//cdn.example/x")).toBe(false);
  });
});

describe("maps", () => {
  it("links to openstreetmap.org with a marker", () => {
    expect(osmLink(48.8584, 2.2945)).toBe("https://www.openstreetmap.org/?mlat=48.8584&mlon=2.2945#map=16/48.8584/2.2945");
    expect(osmLink(1, 2, 25)).toBe("https://www.openstreetmap.org/?mlat=1&mlon=2#map=19/1/2");
    expect(formatCoords(55.755826, 37.6173)).toBe("55.75583, 37.6173");
  });
});

describe("carousel", () => {
  it("finds the slide in view", () => {
    const lefts = [0, 310, 620, 930];
    expect(activeSlide(lefts, 0, 900)).toBe(0);
    expect(activeSlide(lefts, 300, 900)).toBe(1);
    expect(activeSlide(lefts, 480, 900)).toBe(2);
    // Scrolled to the end: the last slide, even though its left edge is out of reach.
    expect(activeSlide(lefts, 899, 900)).toBe(3);
    expect(activeSlide([], 10, 0)).toBe(0);
  });
});
