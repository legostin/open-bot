// UI of the browser plugin: the browser's live view (with takeover) for the host's floating live-view window, and a
// compact renderer for browser_* calls. The backend's "activity" event tells the host when an agent drives the
// browser, so the window opens on its own.
// React and @owlbot/ui come from the host (import map); this file is bundled by scripts/build-ui-plugins.mjs.
// Texts come from .owlbot-plugin/locales (ui.* keys) through ui.i18n.t.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Badge, Button, EmptyState, Spinner, definePluginUI } from "@owlbot/ui";
import type { LiveViewActivity, LiveViewProps, OwlbotUI, ToolResultProps } from "@owlbot/ui";

interface Tab {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

/** Playwright's Chromium being downloaded by the plugin (outside Docker, on first use). */
interface InstallStatus {
  installing: boolean;
  step: string | null;
  progress: number | null;
  error: string | null;
}

interface BrowserState {
  running: boolean;
  headless: boolean | null;
  control: "agent" | "user";
  busy: string | null;
  tabs: Tab[];
  url: string;
  title: string;
  install?: InstallStatus;
}

/** The backend's "activity" event: sent on every change, whether or not anyone watches. */
interface Activity {
  running: boolean;
  busy: string | null;
  agentId: string | null;
  url: string;
  control: "agent" | "user";
  attention: boolean;
}

let host: OwlbotUI;
let t: OwlbotUI["i18n"]["t"] = (key) => key;
const send = (payload: Record<string, unknown>) => host.plugin.send(payload);

/** The backend sends `code` + `params` (ui.error.<code>) with an English `message` as a fallback. */
function errorText(e: { message?: string; code?: string; params?: Record<string, string> } | undefined): string {
  if (e?.code) {
    const key = `ui.error.${e.code}`;
    const text = t(key, e.params ?? {});
    if (text !== key) return text;
  }
  return e?.message ? t("ui.error.other", { detail: e.message }) : t("ui.error.generic");
}

const viewerId = Math.random().toString(36).slice(2);
const BUTTONS = ["left", "middle", "right", "back", "forward"];

const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
  shift: e.shiftKey,
});

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A phone or tablet: taps and drags instead of a mouse, and a system keyboard that needs a text field. */
const touchScreen = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

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
const KB_IDLE = "\u200b";

function hostOf(u: string): string {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.host.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** Tools with a label (ui.call.<name>). */
const LABELED = new Set(["open", "snapshot", "get_text", "screenshot", "scroll", "back", "tabs", "wait", "click", "type", "press_key", "fill_secret", "download", "submit"]);

const toolLabel = (name: string) => (LABELED.has(name) ? t(`ui.call.${name}`) : name);

/** What the host shows in the live view's title bar and how it decides when to open the window. */
function toLiveActivity(a: Activity): LiveViewActivity {
  const status = a.attention ? t("ui.activity.captcha") : a.control === "user" ? t("ui.activity.user") : hostOf(a.url);
  return { active: !!a.busy, attention: a.attention, userControl: a.control === "user", agentId: a.agentId ?? undefined, status };
}

// ---------- live view ----------

const S: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0, fontSize: 13 },
  mini: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 12 },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  url: { flex: 1, minWidth: 140, padding: "5px 8px", borderRadius: 8, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" },
  select: { maxWidth: 220, padding: "4px 6px", borderRadius: 8, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" },
  area: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  screen: { position: "relative", borderRadius: 6, overflow: "hidden", background: "rgba(127,127,127,.08)", outline: "none" },
  img: { display: "block", width: "100%", height: "100%", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" },
  // Focused to bring up the phone's keyboard; invisible and out of the way of taps. 16 px: iOS does not zoom.
  kb: { position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0, border: 0, padding: 0, fontSize: 16, pointerEvents: "none" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, height: "100%", textAlign: "center", padding: 8 },
  hint: { opacity: 0.7, fontSize: 12 },
  error: { color: "#dc2626", fontSize: 12 },
};

/** The size of `el` (kept up to date). */
function useBoxSize(el: HTMLElement | null): { w: number; h: number } {
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

function BrowserView({ mode }: LiveViewProps) {
  const expanded = mode === "expanded";
  const [state, setState] = useState<BrowserState | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [frameSize, setFrameSize] = useState({ w: 1280, h: 800 });
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The latest frame: a new <img> (the layout changes between the compact and the large view) shows it at once.
  const lastFrame = useRef<string | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const controlRef = useRef(false);
  const lastMove = useRef(0);
  const kbRef = useRef<HTMLInputElement | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  // The finger on the screen: a tap clicks, a drag scrolls the page (wheel deltas, sent at most every 32 ms).
  const finger = useRef<{ id: number; x0: number; y0: number; x: number; y: number; moved: boolean; dx: number; dy: number; sentAt: number } | null>(null);
  // Phones follow a tap with emulated mouse events: those are dropped, the tap was already sent.
  const lastTouch = useRef(0);
  const control = expanded && state?.control === "user";
  controlRef.current = control;
  const box = useBoxSize(area);
  const touch = touchScreen();

  useEffect(() => {
    send({ type: "watch", on: true, id: viewerId, refresh: true });
    const renew = setInterval(() => send({ type: "watch", on: true, id: viewerId }), 20_000);
    const offs = [
      host.plugin.on("frame", (f: { data: string; width?: number; height?: number }) => {
        lastFrame.current = `data:image/jpeg;base64,${f.data}`;
        if (imgRef.current) imgRef.current.src = lastFrame.current;
        if (f.width && f.height) setFrameSize((s) => (s.w === f.width && s.h === f.height ? s : { w: f.width!, h: f.height! }));
        setHasFrame(true);
      }),
      host.plugin.on("state", (s: BrowserState) => {
        setState(s);
        if (!s.running) setHasFrame(false);
      }),
      host.plugin.on("control", (c: { user: boolean }) => setState((s) => (s ? { ...s, control: c.user ? "user" : "agent" } : s))),
      host.plugin.on("error", (e: { message?: string; code?: string; params?: Record<string, string> }) => setError(errorText(e))),
    ];
    return () => {
      clearInterval(renew);
      send({ type: "watch", on: false, id: viewerId });
      offs.forEach((off) => off());
    };
  }, []);

  // The compact window takes no input: leaving the large view hands control back to the agent.
  useEffect(() => {
    if (!expanded && state?.control === "user") send({ type: "control", on: false });
  }, [expanded]);

  // Keys go to the browser as soon as the user takes control.
  useEffect(() => {
    if (control) screenRef.current?.focus();
  }, [control]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  // Wheel needs a non-passive native listener to prevent the page from scrolling.
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!controlRef.current) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      send({ type: "input", event: "wheel", ...pos(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k, ...mods(e) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
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

  /** Send the drag so far as one wheel step: the page moves with the finger (remote pixels per screen pixel). */
  const flushScroll = () => {
    const f = finger.current;
    const r = imgRef.current?.getBoundingClientRect();
    if (!f || !r?.width || (!f.dx && !f.dy)) return;
    const k = frameSize.w / r.width;
    send({ type: "input", event: "wheel", ...pos({ clientX: f.x0, clientY: f.y0 }), deltaX: -f.dx * k, deltaY: -f.dy * k });
    f.dx = f.dy = 0;
    f.sentAt = Date.now();
  };

  const onPointer = (kind: "down" | "move" | "up" | "cancel") => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!control || e.pointerType !== "touch") return;
    lastTouch.current = Date.now();
    const f = finger.current;
    if (kind === "down") {
      // No emulated mouse events and no focus change (the keyboard field keeps the phone's keyboard up).
      e.preventDefault();
      if (f) return;
      finger.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, dx: 0, dy: 0, sentAt: 0 };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      return;
    }
    if (!f || f.id !== e.pointerId) return;
    if (kind === "move") {
      if (!f.moved && Math.hypot(e.clientX - f.x0, e.clientY - f.y0) < 8) return;
      f.moved = true;
      f.dx += e.clientX - f.x;
      f.dy += e.clientY - f.y;
      f.x = e.clientX;
      f.y = e.clientY;
      if (Date.now() - f.sentAt >= 32) flushScroll();
      return;
    }
    if (kind === "up" && !f.moved) {
      const at = pos(e);
      send({ type: "input", event: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount: 1 });
      send({ type: "input", event: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount: 1 });
    } else if (kind === "up") flushScroll();
    finger.current = null;
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

  const navigate = () => {
    const url = (draftUrl ?? "").trim();
    if (url) send({ type: "navigate", url });
    setDraftUrl(null);
  };

  // The picture keeps its aspect ratio and fits the area; input coordinates are taken from the image's own box.
  const scale = box.w && box.h ? Math.min(box.w / frameSize.w, box.h / frameSize.h) : 0;
  const fit = { width: Math.max(1, Math.floor(frameSize.w * scale)), height: Math.max(1, Math.floor(frameSize.h * scale)) };
  const running = state?.running ?? true;
  const installing = !!state && !state.running && !!state.install?.installing;

  const picture = (
    <div ref={setArea} style={S.area}>
      <div
        ref={screenRef}
        tabIndex={expanded ? 0 : -1}
        style={{
          ...S.screen,
          ...(scale > 0 ? fit : { width: "100%", height: "100%" }),
          boxShadow: control ? "0 0 0 2px #f59e0b" : undefined,
          cursor: control ? "default" : expanded ? "not-allowed" : undefined,
          // Drags are the page's scrolling, not the live view's (and no pinch zoom of the picture).
          touchAction: control ? "none" : undefined,
        }}
        onPointerDown={onPointer("down")}
        onPointerMove={onPointer("move")}
        onPointerUp={onPointer("up")}
        onPointerCancel={onPointer("cancel")}
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
        title={expanded && !control ? t("ui.screen.locked") : undefined}
      >
        <img
          ref={(el) => {
            imgRef.current = el;
            if (el && lastFrame.current && el.src !== lastFrame.current) el.src = lastFrame.current;
          }}
          alt=""
          draggable={false}
          style={{ ...S.img, display: hasFrame ? "block" : "none" }}
        />
        {!hasFrame && (
          <div style={S.center}>
            <Spinner />
          </div>
        )}
        {control && (
          <input
            ref={kbRef}
            style={S.kb}
            tabIndex={-1}
            aria-label={t("ui.keyboard.label")}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="enter"
            onFocus={() => setKbOpen(true)}
            onBlur={() => setKbOpen(false)}
          />
        )}
      </div>
    </div>
  );

  if (!expanded) {
    return (
      <div style={S.mini}>
        {installing ? (
          <div style={S.center}>
            <Spinner size={14} />
            <span style={S.hint}>{t("ui.install.title")}</span>
          </div>
        ) : !running ? (
          <div style={S.center}>
            <span style={S.hint}>{t("ui.stopped.title")}</span>
          </div>
        ) : (
          picture
        )}
      </div>
    );
  }

  const tabs = state?.tabs ?? [];
  const active = tabs.find((x) => x.active);
  const status = control ? (
    <Badge tone="warning">{t("ui.status.user")}</Badge>
  ) : state?.busy ? (
    <Badge tone="info">{t("ui.status.busy", { tool: toolLabel(state.busy) })}</Badge>
  ) : (
    <Badge tone="neutral">{t("ui.status.agent")}</Badge>
  );

  return (
    <div style={S.root}>
      <div style={S.row}>
        <Button size="sm" variant="ghost" title={t("ui.nav.back")} onClick={() => send({ type: "back" })}>
          ←
        </Button>
        <Button size="sm" variant="ghost" title={t("ui.nav.forward")} onClick={() => send({ type: "forward" })}>
          →
        </Button>
        <Button size="sm" variant="ghost" title={t("ui.nav.reload")} onClick={() => send({ type: "reload" })}>
          ⟳
        </Button>
        <input
          style={S.url}
          value={draftUrl ?? state?.url ?? ""}
          placeholder={t("ui.urlPlaceholder")}
          spellCheck={false}
          onFocus={(e) => {
            setDraftUrl(state?.url ?? "");
            e.currentTarget.select();
          }}
          onChange={(e) => setDraftUrl(e.target.value)}
          onBlur={() => setDraftUrl(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              navigate();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              // Leave the field, not the live view.
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        {tabs.length > 0 && (
          <select style={S.select} value={active?.index ?? ""} onChange={(e) => send({ type: "tab", action: "switch", index: Number(e.target.value) })}>
            {tabs.map((tab) => (
              <option key={tab.index} value={tab.index}>
                {tab.index}. {cut(tab.title || tab.url || t("ui.tab.new"), 40)}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant="ghost" title={t("ui.tab.new")} onClick={() => send({ type: "tab", action: "new" })}>
          +
        </Button>
        {tabs.length > 0 && (
          <Button size="sm" variant="ghost" title={t("ui.tab.close")} onClick={() => send({ type: "tab", action: "close", index: active?.index })}>
            ×
          </Button>
        )}
        {state?.running && (
          <Button size="sm" variant={control ? "primary" : "secondary"} onClick={() => send({ type: "control", on: !control })}>
            {control ? t("ui.control.return") : t("ui.control.take")}
          </Button>
        )}
      </div>

      {error && <div style={S.error}>{error}</div>}

      {installing && state?.install ? (
        <div>
          <EmptyState icon="globe" title={t("ui.install.title")} hint={t("ui.install.hint")} />
          <div style={{ ...S.row, justifyContent: "center" }}>
            <Spinner size={14} />
            {state.install.step && (
              <span style={S.hint}>
                {state.install.progress !== null
                  ? t("ui.install.progress", { step: state.install.step, percent: state.install.progress })
                  : t("ui.install.step", { step: state.install.step })}
              </span>
            )}
          </div>
        </div>
      ) : state && !state.running ? (
        <div>
          <EmptyState icon="globe" title={t("ui.stopped.title")} hint={t("ui.stopped.hint")} />
          {state.install?.error && (
            <div style={{ ...S.error, textAlign: "center", marginBottom: 8 }}>{t("ui.install.failed", { detail: state.install.error })}</div>
          )}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Button onClick={() => send({ type: "start" })}>{t("ui.start")}</Button>
          </div>
        </div>
      ) : (
        <>
          {picture}
          <div style={{ ...S.row, ...S.hint }}>
            {state?.running && status}
            {control && touch && (
              <Button
                size="sm"
                variant={kbOpen ? "primary" : "secondary"}
                // A tap focuses the field (inside the gesture, or iOS shows no keyboard); a second tap hides it.
                onClick={() => (kbOpen ? kbRef.current?.blur() : kbRef.current?.focus())}
              >
                ⌨ {kbOpen ? t("ui.keyboard.hide") : t("ui.keyboard.show")}
              </Button>
            )}
            <span>{control ? t(touch ? "ui.hint.touch" : "ui.hint.user") : t("ui.hint.agent")}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- compact renderer for browser_* tool calls in the chat ----------

const C: Record<string, CSSProperties> = {
  box: { margin: "4px 0", fontSize: 13 },
  head: { display: "flex", alignItems: "center", gap: 6, background: "transparent", border: 0, padding: 0, color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left" },
  muted: { opacity: 0.65 },
  pre: { margin: "6px 0 0", padding: 8, borderRadius: 6, background: "rgba(127,127,127,.1)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto", fontSize: 12 },
};

/** The URL from the "Page: <title> — <url>" line that every browser result ends with. */
function pageUrl(output: string | undefined): string {
  const line = output?.split("\n").find((l) => l.startsWith("Page: "));
  if (!line) return "";
  const last = line.split(" — ").pop() ?? "";
  return last.replace(/ \(tab \d+ of \d+\)$/, "").trim();
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return cut(x.host + (x.pathname === "/" ? "" : x.pathname), 60);
  } catch {
    return cut(u, 60);
  }
}

function BrowserCall({ call, result }: ToolResultProps) {
  const [open, setOpen] = useState(false);
  const name = call.name.replace(/^.*?browser_/, "");
  const input = (call.input ?? {}) as Record<string, unknown>;
  const url = (typeof input.url === "string" && input.url) || pageUrl(result?.output);
  const detail = name === "submit" && typeof input.description === "string" ? input.description : name === "press_key" && typeof input.key === "string" ? input.key : "";
  return (
    <div style={C.box}>
      <button type="button" style={C.head} onClick={() => setOpen(!open)} title={open ? t("ui.call.hide") : t("ui.call.show")}>
        <span aria-hidden>🌐</span>
        <span style={{ fontWeight: 500 }}>{LABELED.has(name) ? t(`ui.call.${name}`) : call.name}</span>
        {detail && <span>· {cut(detail, 80)}</span>}
        {url && (
          <span style={C.muted} title={url}>
            {shortUrl(url)}
          </span>
        )}
        {!result ? <Spinner size={12} /> : result.isError ? <Badge tone="danger">{t("ui.call.error")}</Badge> : null}
      </button>
      {open && result && <pre style={C.pre}>{result.output}</pre>}
    </div>
  );
}

export default definePluginUI((ui) => {
  host = ui;
  t = (key, params) => ui.i18n.t(key, params);
  const view = ui.liveView.register({ id: "browser", title: t("ui.view.title"), icon: "globe", component: BrowserView });
  const offs = [
    () => view.dispose(),
    ui.plugin.on("activity", (a: Activity) => view.update(toLiveActivity(a))),
    ui.slots.register("chat.toolResult", { id: "browser-call", match: { tool: ["browser_*", "*__browser_*"] }, component: BrowserCall }),
  ];
  // An agent may already be working in the browser when the page loads.
  send({ type: "activity" });
  return () => offs.forEach((off) => off());
});
