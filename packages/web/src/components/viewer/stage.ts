// The media viewer's motion, outside React: pointers, wheel and keys move the current picture, the strip of items and
// the backdrop by writing transforms straight to the DOM, and animations run on requestAnimationFrame from wherever
// things are, so a gesture can catch an animation midway. React lays the slides out and tells the stage where the
// current picture sits (`setCurrent`); the stage tells React what happened (StageHost).

import {
  clampView,
  coverTransform,
  dismissCommits,
  doubleTapScale,
  easeInOutCubic,
  easeOutCubic,
  easeOutQuart,
  IDENTITY,
  maxScale,
  panLimit,
  project,
  rubber,
  rubberClamp,
  rubberScale,
  swipeCommits,
  zoomAt,
  type Size,
  type View,
} from "../../lib/zoom";

/** Room between items while swiping. */
export const GAP = 24;

export interface StageHost {
  canStep(dir: -1 | 1): boolean;
  /** The strip has moved one item over: show the next one as the current. */
  step(dir: -1 | 1): void;
  /** The closing animation is done. */
  closed(): void;
  /** Where the current item's thumbnail is in the chat, to close into it. */
  origin(): { rect: DOMRect; radius: number } | undefined;
  /** A single tap (touch): show or hide the controls. */
  tap(): void;
  /** The picture's scale changed (for the zoom read-out). */
  zoomed(scale: number): void;
  /** A drag down to close started or ended (the controls step aside). */
  dragging(on: boolean): void;
  /** Marking up: one finger, the mouse or the pen draws, in the picture's pixels. */
  draw?: {
    start(x: number, y: number): void;
    move(x: number, y: number): void;
    end(): void;
    cancel(): void;
  };
}

/** Where the current item is laid out, relative to the stage: its box's centre and size, and its own pixel size. */
export interface Current {
  el: HTMLElement;
  box: { cx: number; cy: number; w: number; h: number };
  natural: Size;
  zoomable: boolean;
}

interface State {
  scale: number;
  x: number;
  y: number;
  track: number;
  bg: number;
  clipX: number;
  clipY: number;
  radius: number;
  alpha: number;
}

type Gesture =
  | { kind: "pending" | "pan" | "swipe" | "dismiss" | "none"; sx: number; sy: number; t0: number; view: View; type: string; moved: boolean }
  | { kind: "pinch"; dist: number; mid: { x: number; y: number }; view: View }
  | { kind: "draw" };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const REST: State = { ...IDENTITY, track: 0, bg: 1, clipX: 0, clipY: 0, radius: 0, alpha: 1 };

export class Stage {
  private root: HTMLElement;
  private track: HTMLElement;
  private host: StageHost;
  private cur: State = { ...REST };
  private current?: Current;
  private size: Size = { w: 0, h: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private g?: Gesture;
  private samples: { t: number; x: number; y: number }[] = [];
  private raf = 0;
  private animDone?: () => void;
  private lastTap?: { t: number; x: number; y: number };
  private tapTimer?: ReturnType<typeof setTimeout>;
  private wheelTarget?: View;
  private wheelPage = { acc: 0, locked: false, reset: undefined as ReturnType<typeof setTimeout> | undefined };
  private stillTimer?: ReturnType<typeof setTimeout>;
  private stepping = false;
  private closing = false;
  private lastScale = 1;
  /** Marking up: one pointer draws; panning needs two fingers, the middle button or Space. */
  edit = false;
  space = false;

  constructor(root: HTMLElement, track: HTMLElement, host: StageHost) {
    this.root = root;
    this.track = track;
    this.host = host;
    this.size = { w: root.clientWidth, h: root.clientHeight };
    root.addEventListener("pointerdown", this.onDown);
    root.addEventListener("pointermove", this.onMove);
    root.addEventListener("pointerup", this.onUp);
    root.addEventListener("pointercancel", this.onCancel);
    root.addEventListener("lostpointercapture", this.onCancel);
    root.addEventListener("wheel", this.onWheel, { passive: false });
    // Safari's own pinch would zoom the whole page.
    root.addEventListener("gesturestart", prevent);
    root.addEventListener("gesturechange", prevent);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.tapTimer);
    clearTimeout(this.wheelPage.reset);
    clearTimeout(this.stillTimer);
    const r = this.root;
    r.removeEventListener("pointerdown", this.onDown);
    r.removeEventListener("pointermove", this.onMove);
    r.removeEventListener("pointerup", this.onUp);
    r.removeEventListener("pointercancel", this.onCancel);
    r.removeEventListener("lostpointercapture", this.onCancel);
    r.removeEventListener("wheel", this.onWheel);
    r.removeEventListener("gesturestart", prevent);
    r.removeEventListener("gesturechange", prevent);
  }

  // ---------- layout ----------

  resize(size: Size): void {
    this.size = size;
    if (!this.current) return;
    this.cur = { ...this.cur, ...clampView(this.view(), this.fitted(), size) };
    this.apply();
  }

  /**
   * The current item, laid out. A new element starts at rest (the previous one is let go); the same element in a new
   * box (marking up makes room for the tools) moves there smoothly when `animate`.
   */
  setCurrent(next: Current | undefined, animate = false): void {
    const prev = this.current;
    if (prev && prev.el !== next?.el) clearStyles(prev.el);
    this.current = next;
    if (!next) return;
    if (prev && prev.el === next.el && animate && !this.closing) {
      // Where it is on screen now, in the new box's terms; then home.
      const k = prev.box.w > 0 && next.box.w > 0 ? prev.box.w / next.box.w : 1;
      this.stop();
      this.cur = { ...this.cur, scale: this.cur.scale * k, x: prev.box.cx + this.cur.x - next.box.cx, y: prev.box.cy + this.cur.y - next.box.cy };
      this.apply();
      // Whatever else was in motion (an opening) comes to rest with it.
      this.animate({ ...REST }, 320, easeInOutCubic);
      return;
    }
    if (prev?.el !== next.el) this.cur = { ...this.cur, ...IDENTITY, clipX: 0, clipY: 0, radius: 0, alpha: 1 };
    else this.cur = { ...this.cur, ...clampView(this.view(), this.fitted(), this.size) };
    this.apply();
  }

  /** After React showed the next item as the current one: the strip is back at rest under it. */
  stepped(): void {
    this.stepping = false;
    this.stop();
    this.cur = { ...REST };
    this.apply();
  }

  // ---------- opening and closing ----------

  /** Grows out of the thumbnail when there is one, otherwise fades in. */
  open(origin?: { rect: DOMRect; radius: number }): void {
    const c = this.current;
    const from = c && origin ? this.coverOf(origin) : undefined;
    if (from && !reducedMotion()) {
      this.cur = { ...REST, ...from, bg: 0 };
      this.apply();
      this.animate({ ...IDENTITY, clipX: 0, clipY: 0, radius: 0, bg: 1 }, 380, easeOutQuart);
    } else {
      this.cur = { ...REST, scale: 0.94, bg: 0, alpha: 0 };
      this.apply();
      this.animate({ scale: 1, bg: 1, alpha: 1 }, 240, easeOutCubic);
    }
  }

  /** Back into the thumbnail when it is on screen; flung away after a drag down; otherwise fades out. */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.stop();
    this.g = undefined;
    this.pointers.clear();
    const done = () => this.host.closed();
    if (reducedMotion()) return done();
    const origin = this.host.origin();
    const to = this.current && origin && onScreen(origin.rect) ? this.coverOf(origin) : undefined;
    if (to) return this.animate({ ...to, track: 0, bg: 0 }, 320, easeOutCubic, done);
    if (Math.abs(this.cur.y) > 8 && this.cur.scale <= 1) {
      const dir = Math.sign(this.cur.y);
      return this.animate({ y: this.cur.y + dir * this.size.h * 0.6, bg: 0, alpha: 0 }, 240, easeOutCubic, done);
    }
    this.animate({ scale: this.cur.scale * 0.94, bg: 0, alpha: 0 }, 200, easeOutCubic, done);
  }

  // ---------- commands (keys and buttons) ----------

  /** Slides to the item before or after. */
  go(dir: -1 | 1): void {
    if (this.stepping || this.closing || !this.host.canStep(dir)) return;
    this.stepping = true;
    this.animate({ track: -dir * (this.size.w + GAP) }, 300, easeInOutCubic, () => this.host.step(dir));
  }

  /** Zooms by `factor` around the centre of the screen. */
  zoomBy(factor: number): void {
    const c = this.current;
    if (!c?.zoomable || this.closing) return;
    const base = this.wheelTarget ?? this.view();
    const s = Math.min(this.max(), Math.max(1, base.scale * factor));
    const center = { x: this.size.w / 2 - c.box.cx, y: this.size.h / 2 - c.box.cy };
    this.wheelTarget = clampView(zoomAt(base, s, center), this.fitted(), this.size);
    this.animate(this.wheelTarget, 240, easeOutCubic, () => (this.wheelTarget = undefined));
  }

  /** The whole picture again. */
  fit(): void {
    if (this.closing) return;
    this.wheelTarget = undefined;
    this.animate({ ...IDENTITY }, 280, easeInOutCubic);
  }

  /** The picture at its own pixels (or the whole picture when it is already there). */
  actualSize(): void {
    const c = this.current;
    if (!c?.zoomable || c.box.w <= 0) return;
    const s = Math.min(this.max(), Math.max(1, c.natural.w / c.box.w));
    if (Math.abs(this.cur.scale - s) < 0.01) return this.fit();
    this.animate(clampView(zoomAt(this.view(), s, { x: 0, y: 0 }), this.fitted(), this.size), 280, easeInOutCubic);
  }

  /** A point on the screen in the current picture's pixels. */
  toImage(clientX: number, clientY: number): [number, number] {
    const c = this.current;
    if (!c) return [0, 0];
    const r = this.root.getBoundingClientRect();
    const u = (clientX - r.left - c.box.cx - this.cur.x) / this.cur.scale;
    const v = (clientY - r.top - c.box.cy - this.cur.y) / this.cur.scale;
    return [(u / c.box.w + 0.5) * c.natural.w, (v / c.box.h + 0.5) * c.natural.h];
  }

  scale(): number {
    return this.cur.scale;
  }

  // ---------- pointers ----------

  private onDown = (e: PointerEvent) => {
    if (this.closing) return;
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    // The controls, the words being typed and a video's own controls keep their pointers.
    if (e.target instanceof Element && e.target.closest("[data-viewer-ui]")) return;
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser already let go of.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.button === 1) e.preventDefault();
    this.wheelTarget = undefined;
    if (this.pointers.size === 1) {
      // A slide in flight finishes first: the next gesture starts on the new item.
      if (this.stepping) return;
      this.stop();
      this.samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
      const draws = this.edit && !!this.host.draw && e.button === 0 && !this.space;
      if (draws) {
        // No mouse events after it: the field being typed in keeps the focus until the drawing says otherwise.
        e.preventDefault();
        this.g = { kind: "draw" };
        const [x, y] = this.toImage(e.clientX, e.clientY);
        this.host.draw!.start(x, y);
        return;
      }
      this.g = { kind: e.button === 1 || (this.edit && this.space) ? "pan" : "pending", sx: e.clientX, sy: e.clientY, t0: e.timeStamp, view: this.view(), type: e.pointerType, moved: false };
    } else if (this.pointers.size === 2 && this.current?.zoomable && !this.stepping) {
      if (this.g?.kind === "draw") this.host.draw?.cancel();
      if (this.g && "kind" in this.g && this.g.kind === "dismiss") this.host.dragging(false);
      clearTimeout(this.tapTimer);
      this.lastTap = undefined;
      this.stop();
      const [a, b] = [...this.pointers.values()];
      this.g = { kind: "pinch", dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: this.local((a.x + b.x) / 2, (a.y + b.y) / 2), view: this.view() };
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.g;
    if (!g) return;
    if (g.kind === "draw") {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const [x, y] = this.toImage(ev.clientX, ev.clientY);
        this.host.draw?.move(x, y);
      }
      return;
    }
    if (g.kind === "pinch") {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = this.local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const s = rubberScale((g.view.scale * dist) / g.dist, 1, this.max());
      // The picture point that was under the fingers' midpoint stays under it, wherever the fingers go.
      const k = s / g.view.scale;
      this.cur.scale = s;
      this.cur.x = mid.x - (g.mid.x - g.view.x) * k;
      this.cur.y = mid.y - (g.mid.y - g.view.y) * k;
      // Pinching away from a half-done swipe or dismissal brings those back.
      this.cur.track = 0;
      this.cur.bg = 1;
      this.apply();
      return;
    }
    this.sample(e);
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.kind === "pending") {
      if (Math.hypot(dx, dy) < (g.type === "mouse" ? 4 : 8)) return;
      g.kind = this.decide(dx, dy, g.view, g.type);
      g.moved = true;
      clearTimeout(this.tapTimer);
      this.lastTap = undefined;
      if (g.kind === "dismiss") this.host.dragging(true);
    }
    const c = this.current;
    switch (g.kind) {
      case "pan": {
        if (!c) return;
        const lim = panLimit(c.box, this.cur.scale, this.size);
        this.cur.x = rubberClamp(g.view.x + dx, -lim.x, lim.x, this.size.w);
        this.cur.y = rubberClamp(g.view.y + dy, -lim.y, lim.y, this.size.h);
        break;
      }
      case "swipe":
        this.cur.track = this.host.canStep(dx < 0 ? 1 : -1) ? dx : rubber(dx, this.size.w);
        break;
      case "dismiss": {
        const p = Math.min(1, Math.abs(dy) / this.size.h);
        this.cur.x = dx;
        this.cur.y = dy;
        this.cur.scale = 1 - p * 0.35;
        this.cur.bg = 1 - Math.min(1, Math.abs(dy) / (this.size.h * 0.4));
        break;
      }
      default:
        return;
    }
    this.apply();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g) return;
    if (g.kind === "pinch") {
      if (this.pointers.size === 1) {
        // One finger stays: it carries on moving the picture.
        const [p] = [...this.pointers.values()];
        this.samples = [{ t: e.timeStamp, x: p.x, y: p.y }];
        this.g = { kind: "pan", sx: p.x, sy: p.y, t0: e.timeStamp, view: this.view(), type: "touch", moved: true };
      } else if (this.pointers.size === 0) {
        this.g = undefined;
        this.settle(g.mid);
      }
      return;
    }
    if (this.pointers.size > 0) return;
    this.g = undefined;
    if (g.kind === "draw") return this.host.draw?.end();
    const v = this.velocity(e.timeStamp);
    switch (g.kind) {
      case "pending":
        return this.tapped(e, g.type);
      case "none":
        return;
      case "pan":
        return this.fling(v);
      case "swipe": {
        const dir = swipeCommits(this.cur.track, v.x, this.size.w);
        if (dir && this.host.canStep(dir)) {
          this.stepping = true;
          const left = Math.abs(-dir * (this.size.w + GAP) - this.cur.track);
          return this.animate({ track: -dir * (this.size.w + GAP) }, Math.max(160, Math.min(320, left / Math.max(0.8, Math.abs(v.x)))), easeOutCubic, () => this.host.step(dir));
        }
        return this.animate({ track: 0 }, 300, easeOutCubic);
      }
      case "dismiss":
        this.host.dragging(false);
        if (dismissCommits(this.cur.y, v.y)) return this.close();
        return this.animate({ ...IDENTITY, bg: 1 }, 320, easeOutCubic);
    }
  };

  private onCancel = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) return;
    const g = this.g;
    this.g = undefined;
    if (!g) return;
    if (g.kind === "draw") return this.host.draw?.end();
    if (g.kind === "dismiss") this.host.dragging(false);
    if (this.stepping || this.closing) return;
    this.settle({ x: 0, y: 0 });
  };

  /** What a drag that has just begun is: moving the zoomed picture, a swipe to the next item, a pull down to close. */
  private decide(dx: number, dy: number, view: View, type: string): "pan" | "swipe" | "dismiss" | "none" {
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.15;
    const c = this.current;
    if (this.edit) return "none";
    if (view.scale > 1.01 && c) {
      if (horizontal) {
        // At its edge already, the zoomed picture hands the drag to the strip.
        const lim = panLimit(c.box, view.scale, this.size);
        const atEdge = dx < 0 ? view.x <= -lim.x + 1 : view.x >= lim.x - 1;
        if (atEdge && this.host.canStep(dx < 0 ? 1 : -1)) return "swipe";
      }
      return "pan";
    }
    if (horizontal) return "swipe";
    return type === "mouse" ? "none" : "dismiss";
  }

  private tapped(e: PointerEvent, type: string): void {
    const p = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    const prev = this.lastTap;
    if (prev && p.t - prev.t < 320 && Math.hypot(p.x - prev.x, p.y - prev.y) < 30) {
      clearTimeout(this.tapTimer);
      this.lastTap = undefined;
      return this.doubleTap(p.x, p.y);
    }
    this.lastTap = p;
    if (type === "mouse") {
      // A click beside the picture closes the viewer; a second click on it zooms.
      if (!this.over(p.x, p.y)) {
        this.lastTap = undefined;
        this.close();
      }
      return;
    }
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.lastTap = undefined;
      this.host.tap();
    }, 300);
  }

  private doubleTap(clientX: number, clientY: number): void {
    const c = this.current;
    if (!c?.zoomable || this.edit) return;
    if (this.cur.scale > 1.01) return this.animate({ ...IDENTITY }, 320, easeInOutCubic);
    const at = this.local(clientX, clientY);
    const s = doubleTapScale(c.box, this.size, this.max());
    this.animate(clampView(zoomAt(this.view(), s, at), this.fitted(), this.size), 340, easeInOutCubic);
  }

  /** After a pinch: back within the zoom limits around where the fingers were, and inside the edges. */
  private settle(at: { x: number; y: number }): void {
    const s = Math.min(this.max(), Math.max(1, this.cur.scale));
    const v = s === this.cur.scale ? this.view() : zoomAt(this.view(), s, at);
    this.animate({ ...clampView(v, this.fitted(), this.size), track: 0, bg: 1 }, 300, easeOutCubic);
  }

  /** A released drag of the zoomed picture glides on and stops at the edges. */
  private fling(v: { x: number; y: number }): void {
    const target = clampView({ scale: this.cur.scale, x: this.cur.x + project(v.x), y: this.cur.y + project(v.y) }, this.fitted(), this.size);
    const dist = Math.hypot(target.x - this.cur.x, target.y - this.cur.y);
    if (dist < 0.5) return this.apply(false);
    this.animate(target, Math.max(260, Math.min(650, dist * 1.4)), easeOutQuart);
  }

  // ---------- wheel ----------

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const c = this.current;
    if (this.closing || !c) return;
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= this.size.w;
      dy *= this.size.h;
    }
    const zoomed = this.cur.scale > 1.01;
    if (e.ctrlKey || isMouseWheel(e)) {
      // A trackpad pinch (it comes as ctrl+wheel) or a mouse wheel: zoom where the pointer is.
      if (!c.zoomable || this.stepping) return;
      const base = this.wheelTarget ?? this.view();
      const s = Math.min(this.max(), Math.max(1, base.scale * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022))));
      const target = clampView(zoomAt(base, s, this.local(e.clientX, e.clientY)), this.fitted(), this.size);
      if (e.ctrlKey) return this.follow(target);
      // A wheel's notches glide.
      this.wheelTarget = target;
      return this.animate(target, 170, easeOutCubic, () => (this.wheelTarget = undefined));
    }
    // Two fingers on a trackpad: they move a zoomed picture, and page through the items when it is not zoomed.
    if (zoomed) return this.follow(clampView({ scale: this.cur.scale, x: this.cur.x - dx, y: this.cur.y - dy }, this.fitted(), this.size));
    if (this.edit || Math.abs(dx) <= Math.abs(dy)) return;
    // One swipe pages once, its momentum included: the next page waits for the wheel to fall quiet.
    const wp = this.wheelPage;
    clearTimeout(wp.reset);
    wp.reset = setTimeout(() => {
      wp.acc = 0;
      wp.locked = false;
    }, 180);
    if (wp.locked) return;
    wp.acc += dx;
    if (Math.abs(wp.acc) > 60) {
      this.go(wp.acc > 0 ? 1 : -1);
      wp.locked = true;
    }
  };

  /** Moves straight to `target` (a stream of small trackpad steps), sharpening once the stream stops. */
  private follow(target: View): void {
    this.stop();
    this.wheelTarget = undefined;
    Object.assign(this.cur, target);
    this.apply(true);
    clearTimeout(this.stillTimer);
    this.stillTimer = setTimeout(() => this.apply(false), 160);
  }

  // ---------- helpers ----------

  private view(): View {
    return { scale: this.cur.scale, x: this.cur.x, y: this.cur.y };
  }

  private fitted(): Size {
    return this.current ? { w: this.current.box.w, h: this.current.box.h } : { w: 0, h: 0 };
  }

  private max(): number {
    const c = this.current;
    return c ? maxScale(c.natural, c.box) : 4;
  }

  /** A screen point relative to the current box's centre. */
  private local(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.root.getBoundingClientRect();
    const c = this.current;
    return { x: clientX - r.left - (c?.box.cx ?? r.width / 2), y: clientY - r.top - (c?.box.cy ?? r.height / 2) };
  }

  /** Whether a screen point is on the picture as it is shown now. */
  private over(clientX: number, clientY: number): boolean {
    const c = this.current;
    if (!c) return false;
    const p = this.local(clientX, clientY);
    return Math.abs(p.x - this.cur.x) <= (c.box.w * this.cur.scale) / 2 && Math.abs(p.y - this.cur.y) <= (c.box.h * this.cur.scale) / 2;
  }

  /** The state that puts the current picture onto a thumbnail, cropped like it. */
  private coverOf(origin: { rect: DOMRect; radius: number }): Partial<State> | undefined {
    const c = this.current;
    if (!c || c.box.w <= 0) return undefined;
    const r = this.root.getBoundingClientRect();
    const o = origin.rect;
    const { view, clip } = coverTransform(c.box, { cx: o.left - r.left + o.width / 2, cy: o.top - r.top + o.height / 2, w: o.width, h: o.height });
    return { ...view, clipX: clip.x, clipY: clip.y, radius: origin.radius / view.scale };
  }

  private sample(e: PointerEvent): void {
    this.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (this.samples.length > 6) this.samples.shift();
  }

  /** The pointer's speed over its last ~100 ms, px/ms. */
  private velocity(now: number): { x: number; y: number } {
    const recent = this.samples.filter((s) => now - s.t < 100);
    if (recent.length < 2) return { x: 0, y: 0 };
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.animDone = undefined;
  }

  private animate(to: Partial<State>, ms: number, ease: (t: number) => number, done?: () => void): void {
    this.stop();
    if (reducedMotion() || ms <= 0) {
      Object.assign(this.cur, to);
      this.apply();
      done?.();
      return;
    }
    const from = { ...this.cur };
    const keys = Object.keys(to) as (keyof State)[];
    const t0 = performance.now();
    this.animDone = done;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const k = ease(p);
      for (const key of keys) this.cur[key] = from[key] + ((to[key] as number) - from[key]) * k;
      this.apply(p < 1);
      if (p < 1) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = 0;
        const cb = this.animDone;
        this.animDone = undefined;
        cb?.();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Writes the state to the DOM. `moving`: the picture is in motion (cheap scaling now, a sharp redraw once still). */
  private apply(moving = this.g !== undefined): void {
    const s = this.cur;
    const el = this.current?.el;
    if (el) {
      el.style.transform = `translate3d(${s.x}px, ${s.y}px, 0) scale(${s.scale})`;
      el.style.clipPath = s.clipX > 0.5 || s.clipY > 0.5 ? `inset(${s.clipY}px ${s.clipX}px round ${s.radius}px)` : "";
      el.style.opacity = s.alpha < 1 ? String(s.alpha) : "";
      el.style.willChange = moving ? "transform" : "";
    }
    this.track.style.transform = s.track ? `translate3d(${s.track}px, 0, 0)` : "";
    this.root.style.setProperty("--viewer-bg", String(Math.max(0, Math.min(1, s.bg))));
    if (Math.abs(s.scale - this.lastScale) > 0.001) {
      this.lastScale = s.scale;
      this.host.zoomed(s.scale);
    }
  }
}

/**
 * A mouse wheel rather than a trackpad: browsers that report the old `wheelDeltaY` give a trackpad's as exactly -3 ×
 * deltaY; Firefox scrolls a mouse wheel by lines.
 */
function isMouseWheel(e: WheelEvent): boolean {
  const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (legacy) return legacy !== -3 * e.deltaY;
  return e.deltaMode !== 0;
}

function prevent(e: Event): void {
  e.preventDefault();
}

function clearStyles(el: HTMLElement): void {
  el.style.transform = "";
  el.style.clipPath = "";
  el.style.opacity = "";
  el.style.willChange = "";
}

function onScreen(r: DOMRect): boolean {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}
