// The browser's live view: the compact picture in the corner window, and in the large view a browser — tabs, a
// toolbar, the address bar, history — laid out like a desktop browser on a wide view and like a phone browser
// (address on top, buttons at the bottom) on a narrow one.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { ArrowLeft, ArrowRight, History, Keyboard as KeyboardIcon, RotateCw, X } from "lucide-react";
import { Badge, Button, EmptyState, Spinner } from "@owlbot/ui";
import type { LiveViewProps } from "@owlbot/ui";
import { ControlButton, IconButton, MoreMenu } from "./chrome.tsx";
import { HistoryPanel } from "./history.tsx";
import { errorText, host, isBlank, send, t, toolLabel, touchScreen, viewerId, type BrowserState } from "./host.ts";
import { NewTabPage } from "./newtab.tsx";
import { Omnibox } from "./omnibox.tsx";
import { Screen, useBoxSize, type Keyboard } from "./screen.tsx";
import { addStyles } from "./styles.ts";
import { TabStrip, TabSwitcher } from "./tabs.tsx";

/** Narrower than this, the large view is a phone browser. */
const PHONE_WIDTH = 640;

export function BrowserView({ mode }: LiveViewProps) {
  addStyles();
  const expanded = mode === "expanded";
  const [state, setState] = useState<BrowserState | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [frameSize, setFrameSize] = useState({ w: 1280, h: 800 });
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "history" | "tabs">(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The latest frame: a new <img> (the layout changes between the compact and the large view) shows it at once.
  const lastFrame = useRef<string | null>(null);
  const omniRef = useRef<HTMLInputElement | null>(null);
  const kbRef = useRef<HTMLInputElement | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  const [kbHint, setKbHint] = useState(false);
  const keyboard: Keyboard = { ref: kbRef, open: kbOpen, setOpen: setKbOpen, setHint: setKbHint };
  const control = expanded && state?.control === "user";
  const width = useBoxSize(root).w;
  const phone = (width || (typeof window === "undefined" ? PHONE_WIDTH : window.innerWidth)) < PHONE_WIDTH;
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
    if (!expanded) setPanel(null);
  }, [expanded]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const running = state?.running ?? true;
  const installing = !!state && !state.running && !!state.install?.installing;
  const tabs = state?.tabs ?? [];
  const active = tabs.find((x) => x.active);
  const blank = !!state?.running && !state.loading && isBlank(state.url);

  const screen = (overlay?: ReactNode) => (
    <Screen
      expanded={expanded}
      control={control}
      hasFrame={hasFrame}
      frameSize={frameSize}
      imgRef={imgRef}
      lastFrame={lastFrame}
      keyboard={keyboard}
      page={`${active?.index ?? 0} ${state?.url ?? ""}`}
      overlay={overlay}
    />
  );

  if (!expanded) {
    return (
      <div className="obb" style={{ fontSize: 12 }}>
        {installing ? (
          <div className="obb-center">
            <Spinner size={14} />
            <span className="obb-muted">{t("ui.install.title")}</span>
          </div>
        ) : !running ? (
          <div className="obb-center">
            <span className="obb-muted">{t("ui.stopped.title")}</span>
          </div>
        ) : (
          screen()
        )}
      </div>
    );
  }

  const body = (search: boolean) =>
    installing && state?.install ? (
      <div className="obb-area" style={{ flexDirection: "column" }}>
        <EmptyState icon="globe" title={t("ui.install.title")} hint={t("ui.install.hint")} />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Spinner size={14} />
          {state.install.step && (
            <span className="obb-muted">
              {state.install.progress !== null
                ? t("ui.install.progress", { step: state.install.step, percent: state.install.progress })
                : t("ui.install.step", { step: state.install.step })}
            </span>
          )}
        </div>
      </div>
    ) : state && !state.running ? (
      <div className="obb-area" style={{ flexDirection: "column", gap: 8 }}>
        <EmptyState icon="globe" title={t("ui.stopped.title")} hint={t("ui.stopped.hint")} />
        {state.install?.error && <div className="obb-error" style={{ border: 0 }}>{t("ui.install.failed", { detail: state.install.error })}</div>}
        <Button onClick={() => send({ type: "start" })}>{t("ui.start")}</Button>
      </div>
    ) : (
      screen(blank ? <NewTabPage state={state} search={search} /> : undefined)
    );

  const reload = state?.loading ? (
    <IconButton label={t("ui.nav.stop")} onClick={() => send({ type: "stop" })}>
      <X />
    </IconButton>
  ) : (
    <IconButton label={t("ui.nav.reload")} disabled={!state?.running || isBlank(state.url)} onClick={() => send({ type: "reload" })}>
      <RotateCw />
    </IconButton>
  );
  const back = (
    <IconButton label={t("ui.nav.back")} disabled={!state?.running || state.canGoBack === false} onClick={() => send({ type: "back" })}>
      <ArrowLeft />
    </IconButton>
  );
  const forward = (
    <IconButton label={t("ui.nav.forward")} disabled={!state?.running || state.canGoForward === false} onClick={() => send({ type: "forward" })}>
      <ArrowRight />
    </IconButton>
  );
  const status = control ? t("ui.status.user") : state?.busy ? t("ui.status.busy", { tool: toolLabel(state.busy) }) : t("ui.status.agent");

  // Cmd/Ctrl+L: to the address bar, even while the keys go to the page.
  const onKeyDownCapture = (e: ReactKeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      e.stopPropagation();
      omniRef.current?.focus();
    }
  };

  if (phone) {
    return (
      <div ref={setRoot} className="obb" onKeyDownCapture={onKeyDownCapture}>
        <div className="obb-phone">
          <Omnibox state={state} variant="phone" inputRef={omniRef} trailing={isBlank(state?.url) ? undefined : reload} />
          {error && <div className="obb-error">{error}</div>}
          {body(false)}
          {state?.running && (
            <div className="obb-pstatus">
              {(control || state.busy) && <span className={`obb-dot${control ? " is-user" : ""}`} aria-hidden />}
              <span className="obb-trunc">{status}</span>
            </div>
          )}
          <div className="obb-bar">
            {back}
            {forward}
            <IconButton label={t("ui.tabs.open")} onClick={() => setPanel("tabs")}>
              <span className="obb-count">{tabs.length || 1}</span>
            </IconButton>
            {control && touch && (
              <IconButton
                label={kbOpen ? t("ui.keyboard.hide") : kbHint ? t("ui.keyboard.tap") : t("ui.keyboard.show")}
                className={kbOpen ? "is-on" : kbHint ? "is-hint" : undefined}
                // A tap focuses the field (inside the gesture, or iOS shows no keyboard); a second tap hides it.
                onClick={() => (kbOpen ? kbRef.current?.blur() : (kbRef.current?.focus(), setKbHint(false)))}
              >
                <KeyboardIcon />
              </IconButton>
            )}
            {state?.running && <ControlButton control={control} short />}
          </div>
          {panel === "tabs" && <TabSwitcher tabs={tabs} onClose={() => setPanel(null)} onHistory={() => setPanel("history")} />}
          {panel === "history" && <HistoryPanel sheet onClose={() => setPanel(null)} />}
        </div>
      </div>
    );
  }

  return (
    <div ref={setRoot} className="obb" onKeyDownCapture={onKeyDownCapture}>
      <div className="obb-frame">
        {tabs.length > 0 && <TabStrip tabs={tabs} />}
        <div className="obb-toolbar">
          {back}
          {forward}
          {reload}
          <Omnibox state={state} variant="bar" inputRef={omniRef} />
          <IconButton label={t("ui.history.title")} pressed={panel === "history"} onClick={() => setPanel(panel === "history" ? null : "history")}>
            <History />
          </IconButton>
          <MoreMenu url={state?.url ?? ""} />
          {state?.running && <ControlButton control={control} />}
        </div>
        {error && <div className="obb-error">{error}</div>}
        <div className="obb-body">
          {body(true)}
          {panel === "history" && <HistoryPanel sheet={false} onClose={() => setPanel(null)} />}
        </div>
        <div className="obb-foot">
          {state?.running && (control ? <Badge tone="warning">{status}</Badge> : state.busy ? <Badge tone="info">{status}</Badge> : <Badge tone="neutral">{status}</Badge>)}
          <span className="obb-trunc">{control ? t(touch ? "ui.hint.touch" : "ui.hint.user") : t("ui.hint.agent")}</span>
        </div>
      </div>
    </div>
  );
}
