// The media viewer's geometry: how a picture fits the screen, how far it zooms, where a zoom keeps the point under the
// fingers, how far it may be dragged. A view is the picture's transform around its fitted box's centre: `scale` over
// the fitted size, `x`/`y` in screen pixels.

export interface Size {
  w: number;
  h: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

/** The picture's size on screen at scale 1: all of it inside `box`, never blown up past its own pixels. */
export function fitSize(natural: Size, box: Size): Size {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return { w: Math.max(0, box.w), h: Math.max(0, box.h) };
  const k = Math.min(1, box.w / natural.w, box.h / natural.h);
  return { w: natural.w * k, h: natural.h * k };
}

/** How far the picture zooms in: four times its fitted size, or twice its own pixels when that is more (at most 16). */
export function maxScale(natural: Size, fitted: Size): number {
  if (fitted.w <= 0) return 4;
  return Math.min(16, Math.max(4, (2 * natural.w) / fitted.w));
}

/** A double tap's zoom: the picture filling the screen when that is a real step, otherwise 2.5×. */
export function doubleTapScale(fitted: Size, screen: Size, max: number): number {
  if (fitted.w <= 0 || fitted.h <= 0) return 2.5;
  const cover = Math.max(screen.w / fitted.w, screen.h / fitted.h);
  return Math.min(max, cover > 1.3 ? cover : 2.5);
}

/** How far the picture may move from the centre at `scale`: none along a side where it is smaller than the screen. */
export function panLimit(fitted: Size, scale: number, screen: Size): { x: number; y: number } {
  return { x: Math.max(0, (fitted.w * scale - screen.w) / 2), y: Math.max(0, (fitted.h * scale - screen.h) / 2) };
}

/** The view moved back inside its limits. */
export function clampView(v: View, fitted: Size, screen: Size): View {
  const lim = panLimit(fitted, v.scale, screen);
  return { scale: v.scale, x: Math.max(-lim.x, Math.min(lim.x, v.x)), y: Math.max(-lim.y, Math.min(lim.y, v.y)) };
}

/** `v` at a new scale, keeping the picture's point under `at` (screen pixels from the box's centre) where it is. */
export function zoomAt(v: View, scale: number, at: { x: number; y: number }): View {
  const k = scale / v.scale;
  return { scale, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k };
}

/** A drag past a limit: it follows less and less the further it goes (as iOS scroll views do). */
export function rubber(over: number, dim: number): number {
  if (dim <= 0) return 0;
  const s = Math.sign(over);
  const a = Math.abs(over);
  return s * (1 - 1 / ((a * 0.55) / dim + 1)) * dim;
}

/** A value past [min, max] pulled back with rubber, measured against `dim`. */
export function rubberClamp(value: number, min: number, max: number, dim: number): number {
  if (value < min) return min + rubber(value - min, dim);
  if (value > max) return max + rubber(value - max, dim);
  return value;
}

/** A pinch's scale past the limits, held back the same way (a ratio, so the resistance works in log space). */
export function rubberScale(scale: number, min: number, max: number): number {
  if (scale >= min && scale <= max) return scale;
  const edge = scale < min ? min : max;
  return edge * Math.exp(rubber(Math.log(scale / edge), 1));
}

/** Where a fling ends: the release speed (px/ms) carried on while it slows down. */
export function project(velocity: number, deceleration = 0.995): number {
  return (velocity * deceleration) / (1 - deceleration);
}

/** A swipe between items is done when it went a quarter of the way, or was flicked. */
export function swipeCommits(dx: number, vx: number, width: number): -1 | 0 | 1 {
  if (Math.abs(dx) > width * 0.25 || (Math.abs(vx) > 0.35 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 10)) return dx < 0 ? 1 : -1;
  return 0;
}

/** A drag down that closes the viewer: far enough, or fast enough. */
export function dismissCommits(dy: number, vy: number): boolean {
  return Math.abs(dy) > 120 || (Math.abs(vy) > 0.6 && Math.sign(vy) === Math.sign(dy) && Math.abs(dy) > 20);
}

/** The view that shows a picture laid out at `box` (centre and size) where `target` is, cropped to it (object-fit: cover). */
export function coverTransform(
  box: { cx: number; cy: number; w: number; h: number },
  target: { cx: number; cy: number; w: number; h: number },
): { view: View; clip: { x: number; y: number } } {
  if (box.w <= 0 || box.h <= 0) return { view: IDENTITY, clip: { x: 0, y: 0 } };
  const scale = Math.max(target.w / box.w, target.h / box.h);
  return {
    view: { scale, x: target.cx - box.cx, y: target.cy - box.cy },
    // What is cut off each side, in the box's own pixels.
    clip: { x: Math.max(0, (box.w - target.w / scale) / 2), y: Math.max(0, (box.h - target.h / scale) / 2) },
  };
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
