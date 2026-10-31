// Marks a person draws on a picture before sending it: pen and highlighter strokes, arrows, frames, ovals and words,
// in the picture's own pixels. The viewer draws them live as SVG; `renderMarkup` bakes them into the picture with the
// same geometry.

export type Tool = "pen" | "marker" | "arrow" | "rect" | "ellipse" | "text";
export type Point = [number, number];

export type Shape =
  | { kind: "pen" | "marker"; color: string; width: number; points: number[] }
  | { kind: "arrow" | "rect" | "ellipse"; color: string; width: number; from: Point; to: Point }
  | { kind: "text"; color: string; size: number; at: Point; text: string };

export const TOOLS: Tool[] = ["pen", "marker", "arrow", "rect", "ellipse", "text"];

export const COLORS = [
  { id: "red", value: "#ff3b30" },
  { id: "yellow", value: "#ffcc00" },
  { id: "green", value: "#34c759" },
  { id: "blue", value: "#0a84ff" },
  { id: "white", value: "#ffffff" },
  { id: "black", value: "#111111" },
] as const;

export type ColorId = (typeof COLORS)[number]["id"];
export type SizeIndex = 0 | 1 | 2;

export const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
export const MARKER_OPACITY = 0.4;
export const TEXT_LINE = 1.2;

/** Line `i`'s baseline under the words' top: the same in the live SVG and in the baked picture. */
export function textBaseline(size: number, i: number): number {
  return size * (0.95 + i * TEXT_LINE);
}

/** The outline around words, so they read on any picture. */
export function textOutline(size: number): number {
  return Math.max(2, size * 0.14);
}

/** A line's width in the picture's pixels: three steps that look the same on a phone photo and on a screenshot. */
export function strokeWidth(tool: Tool, size: SizeIndex, natural: { w: number; h: number }): number {
  const base = Math.max(1.5, Math.hypot(natural.w, natural.h) / 420);
  const w = base * [1.1, 2, 3.6][size];
  return Math.round((tool === "marker" ? w * 3.2 : w) * 10) / 10;
}

/** Words' size in the picture's pixels. */
export function textSize(size: SizeIndex, natural: { w: number; h: number }): number {
  return Math.round(Math.max(12, Math.max(natural.w, natural.h) * [0.028, 0.042, 0.064][size]));
}

/** The outline around words and the halo that keeps a mark visible: dark under light colours, light under dark ones. */
export function contrastOf(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return "#000000";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#000000" : "#ffffff";
}

/** A stroke's points without the ones closer than `min` to the last kept (a slow hand adds hundreds). */
export function addPoint(points: number[], x: number, y: number, min: number): number[] {
  const n = points.length;
  if (n >= 2 && Math.hypot(x - points[n - 2], y - points[n - 1]) < min) return points;
  return [...points, x, y];
}

/** A smooth SVG path through a stroke's points: quadratic curves between the midpoints. */
export function strokePath(points: number[]): string {
  const n = points.length / 2;
  if (n === 0) return "";
  const r = (v: number) => Math.round(v * 10) / 10;
  if (n === 1) return `M${r(points[0])} ${r(points[1])}L${r(points[0])} ${r(points[1])}`;
  let d = `M${r(points[0])} ${r(points[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    d += `Q${r(x)} ${r(y)} ${r((x + points[i * 2 + 2]) / 2)} ${r((y + points[i * 2 + 3]) / 2)}`;
  }
  return d + `L${r(points[n * 2 - 2])} ${r(points[n * 2 - 1])}`;
}

/** An arrow from `from` to `to`: the shaft's end (under the head) and the head's three corners. */
export function arrowGeometry(from: Point, to: Point, width: number): { shaftEnd: Point; head: [Point, Point, Point] } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return { shaftEnd: to, head: [to, to, to] };
  const ux = dx / len;
  const uy = dy / len;
  const headLen = Math.min(Math.max(width * 4.2, 10), len * 0.6);
  const half = headLen * 0.62;
  const base: Point = [to[0] - ux * headLen, to[1] - uy * headLen];
  return {
    shaftEnd: [to[0] - ux * headLen * 0.7, to[1] - uy * headLen * 0.7],
    head: [to, [base[0] - uy * half, base[1] + ux * half], [base[0] + uy * half, base[1] - ux * half]],
  };
}

/** The box two corners span, whichever way it was drawn. */
export function boxOf(from: Point, to: Point): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), w: Math.abs(to[0] - from[0]), h: Math.abs(to[1] - from[1]) };
}

/** A frame's corner radius: soft, never more than a quarter of its shorter side. */
export function cornerRadius(box: { w: number; h: number }, width: number): number {
  return Math.min(width * 1.5, box.w / 4, box.h / 4);
}

/** With Shift held: an arrow at a multiple of 45°, a frame or an oval with equal sides. */
export function constrain(kind: "arrow" | "rect" | "ellipse", from: Point, to: Point): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (kind === "arrow") {
    const step = Math.PI / 4;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    return [from[0] + Math.round(Math.cos(a) * len * 1000) / 1000, from[1] + Math.round(Math.sin(a) * len * 1000) / 1000];
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + (dx < 0 ? -side : side), from[1] + (dy < 0 ? -side : side)];
}

/** Words as lines, without trailing blanks. */
export function textLines(text: string): string[] {
  return text.replace(/\s+$/, "").split("\n");
}

/** A shape worth keeping: a line that went somewhere, a box with size, words. A pen tap is a dot and counts. */
export function isMeaningful(s: Shape): boolean {
  if (s.kind === "text") return !!s.text.trim();
  if ("points" in s) return s.points.length >= 2;
  return Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) >= s.width * 1.5;
}

/** The part of CanvasRenderingContext2D the baking needs (a parameter, so tests hand in a recorder). */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "closePath"
  | "stroke"
  | "fill"
  | "arc"
  | "ellipse"
  | "roundRect"
  | "strokeText"
  | "fillText"
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textBaseline: CanvasTextBaseline;
};

function strokePoints(ctx: Ctx, points: number[]): void {
  const n = points.length / 2;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    ctx.quadraticCurveTo(x, y, (x + points[i * 2 + 2]) / 2, (y + points[i * 2 + 3]) / 2);
  }
  ctx.lineTo(points[n * 2 - 2], points[n * 2 - 1]);
  ctx.stroke();
}

/** Draws the marks onto a context sized like the picture (scaled by `k` when the picture was made smaller). */
export function renderMarkup(ctx: Ctx, shapes: Shape[], k = 1): void {
  for (const s of shapes) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 1;
    if (s.kind === "text") {
      const size = s.size * k;
      ctx.font = `700 ${size}px ${FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.lineWidth = textOutline(size);
      ctx.strokeStyle = contrastOf(s.color);
      ctx.fillStyle = s.color;
      textLines(s.text).forEach((line, i) => {
        const y = (s.at[1] + textBaseline(s.size, i)) * k;
        ctx.strokeText(line, s.at[0] * k, y);
        ctx.fillText(line, s.at[0] * k, y);
      });
      ctx.restore();
      continue;
    }
    const w = s.width * k;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = w;
    if ("points" in s) {
      if (s.kind === "marker") ctx.globalAlpha = MARKER_OPACITY;
      const pts = s.points.map((v) => v * k);
      if (pts.length === 2) {
        ctx.beginPath();
        ctx.arc(pts[0], pts[1], w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else strokePoints(ctx, pts);
    } else {
      const from: Point = [s.from[0] * k, s.from[1] * k];
      const to: Point = [s.to[0] * k, s.to[1] * k];
      if (s.kind === "arrow") {
        const a = arrowGeometry(from, to, w);
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(a.shaftEnd[0], a.shaftEnd[1]);
        ctx.stroke();
        ctx.lineWidth = w * 0.5;
        ctx.beginPath();
        ctx.moveTo(a.head[0][0], a.head[0][1]);
        ctx.lineTo(a.head[1][0], a.head[1][1]);
        ctx.lineTo(a.head[2][0], a.head[2][1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (s.kind === "rect") {
        const b = boxOf(from, to);
        ctx.beginPath();
        ctx.roundRect(b.x, b.y, b.w, b.h, cornerRadius(b, w));
        ctx.stroke();
      } else {
        const b = boxOf(from, to);
        ctx.beginPath();
        ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** Most pixels a canvas may have everywhere (iOS Safari refuses more than 16.7 million). */
export const MAX_CANVAS_PIXELS = 16_000_000;

/** The size the marked picture is baked at: its own, or smaller to stay within the canvas limit. */
export function bakeSize(natural: { w: number; h: number }): { w: number; h: number; k: number } {
  const k = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, natural.w * natural.h)));
  if (k === 1) return { w: natural.w, h: natural.h, k };
  return { w: Math.max(1, Math.floor(natural.w * k)), h: Math.max(1, Math.floor(natural.h * k)), k };
}

/** The marked copy's type and name: a photo stays a JPEG, anything else becomes a PNG (sharp lines, transparency). */
export function markedFile(name: string, type: string): { name: string; type: "image/jpeg" | "image/png" } {
  const jpeg = /^image\/(jpe?g|heic|heif|webp|avif)$/i.test(type);
  const out = jpeg ? "image/jpeg" : "image/png";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name || "image";
  return { name: `${stem}${jpeg ? ".jpg" : ".png"}`, type: out };
}
