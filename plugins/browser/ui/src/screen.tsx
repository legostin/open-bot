// The live picture of the active tab and everything that reaches the page through it: the mouse, the keys, the
// wheel, and on a touch screen taps, drags and two-finger zoom. The zoom is local (the picture grows on this screen;
// the page and the agent see nothing); a drag pans the zoomed picture and scrolls the page past its edge.
// On a phone the system keyboard needs a focused text field: a hidden one types into the page, and it is focused by
// itself, inside the tap, when the hub says a text field is under the finger.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, MutableRefObject, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Spinner } from "@owlbot/ui";
import { host, send, t, touchScreen, viewerId } from "./host.ts";
import { NO_ZOOM, clampZoom, pan, pinch, zoomAt, type Bounds, type Zoom } from "./zoom.ts";

const BUTTONS = ["left", "middle", "right", "back", "forward"];

const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
  shift: e.shiftKey,
});

/** Keys the phone's keyboard sends as keys, not text (also a hardware keyboard on a tablet). */
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/** What the keyboard field holds between keystrokes: Backspace on a truly empty field fires no input event on Android. */
const KB_IDLE = "​";

/** iOS shows a keyboard only for a field focused inside a touch; Android also for one focused later. */
const iOS = () => typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** The size of `el` (kept up to date). */
export function useBoxSize(el: HTMLElement | null): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((s) => (s.w === Math.floor(width) && s.h === Math.floor(height) ? s : { w: Math.floor(width), h: Math.floor(height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return size;
}

export interface Keyboard {
  ref: MutableRefObject<HTMLInputElement | null>;
  open: boolean;
  setOpen(open: boolean): void;
  /** A text field on the page has the focus but the keyboard is not up (iOS would not open it by itself). */
  setHint(on: boolean): void;
}

type Gesture = { kind: "tap"; x0: number; y0: number } | { kind: "drag"; x: number; y: number } | { kind: "pinch"; z0: Zoom; m0: { x: number; y: number }; d0: number };

export function Screen(props: {
  expanded: boolean;
  control: boolean;
  hasFrame: boolean;
  frameSize: { w: number; h: number };
  imgRef: MutableRefObject<HTMLImageElement | null>;
  lastFrame: MutableRefObject<string | null>;
  keyboard: Keyboard;
  /** The page shown: a new one starts at 100 %. */
  page: string;
  /** Over the picture (the new tab page). */
  overlay?: ReactNode;
}) {
  const { expanded, control, frameSize, imgRef, keyboard } = props;
  const kbRef = keyboard.ref;
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const box = useBoxSize(area);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const controlRef = useRef(control);
  controlRef.current = control;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const frameRef = useRef(frameSize);
  frameRef.current = frameSize;
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const zoomRef = useRef(zoom);
  const setZoomNow = (z: Zoom) => {
    zoomRef.current = z;
    setZoom(z);
  };
  const lastMove = useRef(0);
  // Phones follow a tap with emulated mouse events: those are dropped, the tap was already sent.
  const lastTouch = useRef(0);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const scroll = useRef({ dx: 0, dy: 0, x: 0, y: 0, sentAt: 0 });
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  // The hub's answer to "a text field under the finger?" for the touch going on now.
  const probe = useRef<{ seq: number; editable?: boolean | null; tap: boolean }>({ seq: 0, tap: false });
  const focusState = useRef<boolean | null>(null);
  const touch = touchScreen();

  // A new page or tab starts unzoomed; a resized box keeps the zoom inside it.
  useEffect(() => setZoomNow(NO_ZOOM), [props.page]);
  useEffect(() => {
    if (zoomRef.current.s <= 1 || !screenRef.current) return;
    const l = local({ x: 0, y: 0 });
    setZoomNow(clampZoom(zoomRef.current, l.w, l.h, l.b));
  }, [box.w, box.h, frameSize.w, frameSize.h]);
  // Leaving the large view (or control) unzooms and forgets the keyboard.
  useEffect(() => {
    if (!expanded) setZoomNow(NO_ZOOM);
  }, [expanded]);
  useEffect(() => {
    if (!control) {
      focusState.current = null;
      keyboard.setHint(false);
    }
  }, [control]);

  // Keys go to the browser as soon as the user takes control (a keyboard, not the phone's).
  useEffect(() => {
    if (control && !touch) screenRef.current?.focus();
  }, [control]);

  // The hub's answers: a text field under the finger, the focus after a click.
  useEffect(() => {
    const offs = [
      host.plugin.on("probe", (p: { id: string; seq: number; editable: boolean | null }) => {
        if (p.id === viewerId && p.seq === probe.current.seq) probe.current.editable = p.editable;
      }),
      host.plugin.on("focus", (f: { editable: boolean | null }) => {
        if (!controlRef.current || !touch) return;
        const kb = kbRef.current;
        const up = !!kb && document.activeElement === kb;
        const was = focusState.current;
        focusState.current = f.editable;
        if (f.editable === true && !up) {
          // Android opens the keyboard for this; iOS only inside a touch, so the keyboard button lights up there.
          if (!iOS()) kb?.focus();
          keyboard.setHint(!!kb && document.activeElement !== kb);
        } else if (f.editable === false) {
          keyboard.setHint(false);
          // The field the keyboard was for lost the focus: the keyboard goes too (one opened by hand stays).
          if (up && was === true) kb?.blur();
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  /** A point relative to the picture's (unzoomed) box, the box's size, and the area the zoom may fill around it. */
  const local = (p: { x: number; y: number }) => {
    const r = screenRef.current!.getBoundingClientRect();
    const a = areaRef.current?.getBoundingClientRect() ?? r;
    const b: Bounds = { x0: a.left - r.left, y0: a.top - r.top, x1: a.right - r.left, y1: a.bottom - r.top };
    return { x: p.x - r.left, y: p.y - r.top, w: r.width, h: r.height, b };
  };

  // Wheel needs a non-passive native listener to prevent the page from scrolling. A trackpad pinch arrives as a
  // wheel with ctrlKey: it zooms the picture.
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!expandedRef.current) return;
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      if (e.ctrlKey) {
        e.preventDefault();
        const l = local({ x: e.clientX, y: e.clientY });
        setZoomNow(zoomAt(zoomRef.current, zoomRef.current.s * Math.exp((-e.deltaY * k) / 120), l, l.w, l.h, l.b));
      } else if (controlRef.current) {
        e.preventDefault();
        send({ type: "input", event: "wheel", ...pos(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k, ...mods(e) });
      } else if (zoomRef.current.s > 1) {
        e.preventDefault();
        const l = local({ x: e.clientX, y: e.clientY });
        setZoomNow(pan(zoomRef.current, -e.deltaX * k, -e.deltaY * k, l.w, l.h, l.b).z);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [area]);

  // iOS raises the keyboard for a field focused inside the touch: touchend is the last moment of it.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onTouchEnd = () => {
      if (controlRef.current && probe.current.tap && probe.current.editable === true) openKeyboard();
    };
    el.addEventListener("touchend", onTouchEnd);
    return () => el.removeEventListener("touchend", onTouchEnd);
  }, [area]);

  const openKeyboard = () => {
    const kb = kbRef.current;
    if (!kb || document.activeElement === kb) return;
    kb.focus();
    keyboard.setHint(false);
  };

  const mouse = (action: "down" | "up" | "move") => (e: ReactMouseEvent) => {
    if (!control || Date.now() - lastTouch.current < 800) return;
    if (action === "move") {
      const now = Date.now();
      if (now - lastMove.current < 40) return;
      lastMove.current = now;
    } else {
      e.preventDefault();
      if (action === "down") screenRef.current?.focus();
    }
    send({
      type: "input",
      event: "mouse",
      action,
      ...pos(e),
      button: action === "move" ? undefined : (BUTTONS[e.button] ?? "left"),
      buttons: e.buttons,
      clickCount: e.detail || 1,
      ...mods(e),
    });
  };

  const key = (action: "down" | "up") => (e: ReactKeyboardEvent) => {
    // The keyboard field (inside the screen) sends its own keys.
    if (!control || e.target === kbRef.current) return;
    // Let the browser fire "paste" so the user's clipboard text is sent with insertText.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    // Prevented keys (Escape included) go to the agent's browser and do not close the live view.
    e.preventDefault();
    send({ type: "input", event: "key", action, key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat, ...mods(e) });
  };

  const press = (key: string) => {
    for (const action of ["down", "up"]) send({ type: "input", event: "key", action, key, code: key, keyCode: KEY_CODES[key] ?? 0 });
  };

  /** Send the drag's leftover so far as one wheel step: the page moves with the finger. */
  const flushScroll = () => {
    const s = scroll.current;
    const r = imgRef.current?.getBoundingClientRect();
    if (!r?.width || (!s.dx && !s.dy)) return;
    // Remote pixels per screen pixel, the zoom included.
    const k = frameRef.current.w / r.width;
    send({ type: "input", event: "wheel", ...pos({ clientX: s.x, clientY: s.y }), deltaX: -s.dx * k, deltaY: -s.dy * k });
    s.dx = s.dy = 0;
    s.sentAt = Date.now();
  };

  const drag = (g: Extract<Gesture, { kind: "drag" }>, x: number, y: number) => {
    const dx = x - g.x;
    const dy = y - g.y;
    g.x = x;
    g.y = y;
    let rest = { x: dx, y: dy };
    if (zoomRef.current.s > 1) {
      const l = local({ x, y });
      const r = pan(zoomRef.current, dx, dy, l.w, l.h, l.b);
      setZoomNow(r.z);
      rest = r.rest;
    }
    if (!controlRef.current || (!rest.x && !rest.y)) return;
    const s = scroll.current;
    s.dx += rest.x;
    s.dy += rest.y;
    s.x = x;
    s.y = y;
    if (Date.now() - s.sentAt >= 32) flushScroll();
  };

  const tap = (e: { clientX: number; clientY: number }) => {
    if (controlRef.current) {
      const at = pos(e);
      // The letterbox around the page is not the page.
      if (at.x < 0 || at.x > 1 || at.y < 0 || at.y > 1) return;
      send({ type: "input", event: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount: 1 });
      send({ type: "input", event: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount: 1 });
      if (probe.current.editable === true) openKeyboard();
      return;
    }
    // Watching: a double tap zooms in on the spot, or back out.
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.at < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      lastTap.current = null;
      const l = local({ x: e.clientX, y: e.clientY });
      setZoomNow(zoomRef.current.s > 1 ? NO_ZOOM : zoomAt(zoomRef.current, 2.5, l, l.w, l.h, l.b));
    } else lastTap.current = { at: now, x: e.clientX, y: e.clientY };
  };

  // Fingers work on the whole area: the zoomed picture fills it, and a pinch may start in the letterbox.
  const onPointer = (kind: "down" | "move" | "up" | "cancel") => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!expanded || e.pointerType !== "touch") return;
    // The new tab page and the zoom chip over the picture take their own taps.
    if (kind === "down" && (e.target as HTMLElement).closest?.(".obb-ntp, .obb-zoomchip")) return;
    lastTouch.current = Date.now();
    const fingers = touches.current;
    if (kind === "down") {
      // No emulated mouse events and no focus change (the keyboard field keeps the phone's keyboard up).
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 1) {
        gesture.current = { kind: "tap", x0: e.clientX, y0: e.clientY };
        probe.current = { seq: probe.current.seq + 1, tap: true };
        if (control) send({ type: "probe", id: viewerId, seq: probe.current.seq, ...pos(e) });
      } else if (fingers.size === 2) {
        flushScroll();
        probe.current.tap = false;
        const [a, b] = [...fingers.values()];
        const m = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        gesture.current = { kind: "pinch", z0: zoomRef.current, m0: { x: m.x, y: m.y }, d0: Math.hypot(a.x - b.x, a.y - b.y) };
      }
      return;
    }
    if (!fingers.has(e.pointerId)) return;
    const g = gesture.current;
    if (kind === "move") {
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g) return;
      if (g.kind === "pinch") {
        if (fingers.size < 2) return;
        const [a, b] = [...fingers.values()];
        const m = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        setZoomNow(pinch(g.z0, g.m0, g.d0, m, Math.hypot(a.x - b.x, a.y - b.y), m.w, m.h, m.b));
        return;
      }
      if (g.kind === "tap") {
        if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 8) return;
        probe.current.tap = false;
        const d: Gesture = { kind: "drag", x: g.x0, y: g.y0 };
        gesture.current = d;
        drag(d, e.clientX, e.clientY);
        return;
      }
      drag(g, e.clientX, e.clientY);
      return;
    }
    fingers.delete(e.pointerId);
    if (g?.kind === "pinch") {
      // One finger stays on the glass: it goes on moving the picture.
      const rest = [...fingers.values()][0];
      gesture.current = rest ? { kind: "drag", x: rest.x, y: rest.y } : null;
      return;
    }
    if (fingers.size) return;
    gesture.current = null;
    if (g?.kind === "tap" && kind === "up") tap(e);
    else flushScroll();
  };

  // The phone's keyboard types into the page: text with insertText, Backspace / Enter / arrows as keys. The field stays
  // (almost) empty; words an input method composes go when they are committed.
  useEffect(() => {
    const el = kbRef.current;
    if (!el) return;
    const idle = () => {
      el.value = KB_IDLE;
      el.setSelectionRange(KB_IDLE.length, KB_IDLE.length);
    };
    const onBeforeInput = (e: InputEvent) => {
      if (!controlRef.current || e.isComposing || e.inputType === "insertCompositionText") return;
      e.preventDefault();
      const text = e.data ?? e.dataTransfer?.getData("text/plain");
      if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") press("Enter");
      else if (e.inputType.startsWith("insert") && text) send({ type: "input", event: "text", text });
      else if (e.inputType.startsWith("deleteContentBackward") || e.inputType.startsWith("deleteWordBackward")) press("Backspace");
      else if (e.inputType.startsWith("deleteContentForward")) press("Delete");
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      if (controlRef.current && e.data) send({ type: "input", event: "text", text: e.data });
      setTimeout(idle, 0);
    };
    const onInput = (e: Event) => !(e as InputEvent).isComposing && idle();
    const onKey = (e: KeyboardEvent) => {
      if (!controlRef.current || e.isComposing || !(e.key in KEY_CODES)) return;
      // Handled here, so no beforeinput follows; prevented, so Escape does not close the live view.
      e.preventDefault();
      send({ type: "input", event: "key", action: e.type === "keydown" ? "down" : "up", key: e.key, code: e.code || e.key, keyCode: KEY_CODES[e.key], repeat: e.repeat, ...mods(e) });
    };
    idle();
    el.addEventListener("focus", idle);
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKey);
    el.addEventListener("keyup", onKey);
    return () => {
      el.removeEventListener("focus", idle);
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keyup", onKey);
    };
  }, [control]);

  // The picture keeps its aspect ratio and fits the area; input coordinates are taken from the image's own box.
  const scale = box.w && box.h ? Math.min(box.w / frameSize.w, box.h / frameSize.h) : 0;
  const fit = { width: Math.max(1, Math.floor(frameSize.w * scale)), height: Math.max(1, Math.floor(frameSize.h * scale)) };
  const zoomed = zoom.s > 1.001;

  return (
    <div
      ref={(el) => {
        areaRef.current = el;
        setArea(el);
      }}
      className="obb-area"
      style={{
        background: expanded ? undefined : "transparent",
        // Fingers are the page's (or the zoom's), not the live view's: no browser scrolling or pinch zoom here.
        touchAction: expanded ? "none" : undefined,
      }}
      onPointerDown={onPointer("down")}
      onPointerMove={onPointer("move")}
      onPointerUp={onPointer("up")}
      onPointerCancel={onPointer("cancel")}
    >
      <div
        ref={screenRef}
        className="obb-screen"
        tabIndex={expanded ? 0 : -1}
        style={{
          ...(scale > 0 ? fit : { width: "100%", height: "100%" }),
          boxShadow: control && !zoomed ? "0 0 0 2px var(--warning)" : undefined,
          cursor: control ? "default" : undefined,
          // The zoomed picture spills into the area around the box (the area clips it).
          overflow: zoomed ? "visible" : undefined,
        }}
        onMouseDown={mouse("down")}
        onMouseUp={mouse("up")}
        onMouseMove={mouse("move")}
        onKeyDown={key("down")}
        onKeyUp={key("up")}
        onPaste={(e) => {
          if (!control || e.target === kbRef.current) return;
          e.preventDefault();
          const text = e.clipboardData.getData("text");
          if (text) send({ type: "input", event: "text", text });
        }}
        onContextMenu={(e) => control && e.preventDefault()}
        title={expanded && !control && !touch ? t("ui.screen.locked") : undefined}
      >
        <div className="obb-layer" style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` } : undefined}>
          <img
            ref={(el) => {
              imgRef.current = el;
              if (el && props.lastFrame.current && el.src !== props.lastFrame.current) el.src = props.lastFrame.current;
            }}
            alt=""
            draggable={false}
            style={{ display: props.hasFrame ? "block" : "none" }}
          />
        </div>
        {!props.hasFrame && (
          <div className="obb-center">
            <Spinner />
          </div>
        )}
        {control && (
          <input
            ref={kbRef}
            className="obb-kbfield"
            tabIndex={-1}
            aria-label={t("ui.keyboard.label")}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="enter"
            onFocus={() => keyboard.setOpen(true)}
            onBlur={() => keyboard.setOpen(false)}
          />
        )}
      </div>
      {expanded && zoomed && (
        <button type="button" className="obb-zoomchip" title={t("ui.zoom.reset")} onClick={() => setZoomNow(NO_ZOOM)}>
          {Math.round(zoom.s * 100)}%
          <RotateCcw aria-hidden />
        </button>
      )}
      {props.overlay}
    </div>
  );
}
