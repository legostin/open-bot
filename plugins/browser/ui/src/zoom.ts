// Zooming the live picture with the fingers (or a trackpad pinch): a scale and an offset in the picture's box,
// applied as `translate(x, y) scale(s)` with the origin at the top left. Pure, so it is tested on its own.

export interface Zoom {
  s: number;
  x: number;
  y: number;
}

export const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 };
export const MAX_ZOOM = 4;

interface Point {
  x: number;
  y: number;
}

/**
 * What the zoomed picture may fill, in its box's coordinates: the whole area around the box (the letterbox of a
 * wide page on a tall phone included). By default the box itself.
 */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Keep the scale in 1…MAX_ZOOM and the zoomed picture (w × h at scale 1) covering the bounds where it is larger than
 * them, centered where it is smaller.
 */
export function clampZoom(z: Zoom, w: number, h: number, b: Bounds = { x0: 0, y0: 0, x1: w, y1: h }): Zoom {
  const s = Math.min(MAX_ZOOM, Math.max(1, z.s));
  if (s === 1) return NO_ZOOM;
  const fit = (pos: number, size: number, lo: number, hi: number) => (size >= hi - lo ? Math.min(lo, Math.max(hi - size, pos)) : (lo + hi - size) / 2);
  return { s, x: fit(z.x, w * s, b.x0, b.x1), y: fit(z.y, h * s, b.y0, b.y1) };
}

/** Zoom to `s`, keeping the point `at` of the box (where the fingers or the cursor are) on the same spot. */
export function zoomAt(z: Zoom, s: number, at: Point, w: number, h: number, b?: Bounds): Zoom {
  const next = Math.min(MAX_ZOOM, Math.max(1, s));
  const cx = (at.x - z.x) / z.s;
  const cy = (at.y - z.y) / z.s;
  return clampZoom({ s: next, x: at.x - cx * next, y: at.y - cy * next }, w, h, b);
}

/**
 * Two fingers from the start (zoom `z0`, midpoint `m0`, distance `d0`) to now (`m`, `d`): the picture grows with the
 * distance and the point under the fingers follows them.
 */
export function pinch(z0: Zoom, m0: Point, d0: number, m: Point, d: number, w: number, h: number, b?: Bounds): Zoom {
  const s = Math.min(MAX_ZOOM, Math.max(1, (z0.s * d) / Math.max(1, d0)));
  const cx = (m0.x - z0.x) / z0.s;
  const cy = (m0.y - z0.y) / z0.s;
  return clampZoom({ s, x: m.x - cx * s, y: m.y - cy * s }, w, h, b);
}

/** Move the zoomed picture by (dx, dy); `rest` is what was left at its edge (the page scrolls by it). */
export function pan(z: Zoom, dx: number, dy: number, w: number, h: number, b?: Bounds): { z: Zoom; rest: Point } {
  const want = { s: z.s, x: z.x + dx, y: z.y + dy };
  const got = clampZoom(want, w, h, b);
  return { z: got, rest: { x: want.x - got.x, y: want.y - got.y } };
}
