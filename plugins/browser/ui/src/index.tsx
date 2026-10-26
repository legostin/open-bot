// UI of the browser plugin: live view with takeover (right pane tab «Браузер») and a compact renderer for browser_* calls.
// React and @openbot/ui come from the host (import map); this file is bundled by scripts/build-ui-plugins.mjs.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { Badge, Button, EmptyState, Spinner, definePluginUI } from "@openbot/ui";
import type { OpenBotUI, ToolResultProps } from "@openbot/ui";

interface Tab {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

interface BrowserState {
  running: boolean;
  headless: boolean | null;
  control: "agent" | "user";
  busy: string | null;
  tabs: Tab[];
  url: string;
  title: string;
}

let host: OpenBotUI;
const send = (payload: Record<string, unknown>) => host.plugin.send(payload);

const viewerId = Math.random().toString(36).slice(2);
const BUTTONS = ["left", "middle", "right", "back", "forward"];

const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
  shift: e.shiftKey,
});

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- live view ----------

const S: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0, fontSize: 13 },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  url: { flex: 1, minWidth: 120, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" },
  select: { maxWidth: 220, padding: "4px 6px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" },
  screen: { position: "relative", borderRadius: 6, overflow: "hidden", border: "1px solid rgba(127,127,127,.25)", background: "rgba(127,127,127,.08)", outline: "none" },
  img: { display: "block", width: "100%", height: "auto", userSelect: "none" },
  placeholder: { display: "flex", alignItems: "center", justifyContent: "center", aspectRatio: "16 / 10" },
  hint: { opacity: 0.7, fontSize: 12 },
  error: { color: "#dc2626", fontSize: 12 },
};

function BrowserPane() {
  const [state, setState] = useState<BrowserState | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const controlRef = useRef(false);
  const lastMove = useRef(0);
  const control = state?.control === "user";
  controlRef.current = control;

  useEffect(() => {
    send({ type: "watch", on: true, id: viewerId, refresh: true });
    const renew = setInterval(() => send({ type: "watch", on: true, id: viewerId }), 20_000);
    const offs = [
      host.plugin.on("frame", (f: { data: string }) => {
        if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${f.data}`;
        setHasFrame(true);
      }),
      host.plugin.on("state", (s: BrowserState) => {
        setState(s);
        if (!s.running) setHasFrame(false);
      }),
      host.plugin.on("control", (c: { user: boolean }) => setState((s) => (s ? { ...s, control: c.user ? "user" : "agent" } : s))),
      host.plugin.on("error", (e: { message?: string }) => setError(String(e?.message ?? "Ошибка браузера"))),
    ];
    return () => {
      clearInterval(renew);
      send({ type: "watch", on: false, id: viewerId });
      offs.forEach((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // Wheel needs a non-passive native listener to prevent the pane from scrolling.
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
    if (!control) return;
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
    if (!control) return;
    // Let the browser fire "paste" so the user's clipboard text is sent with insertText.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    send({ type: "input", event: "key", action, key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat, ...mods(e) });
  };

  const navigate = () => {
    const url = (draftUrl ?? "").trim();
    if (url) send({ type: "navigate", url });
    setDraftUrl(null);
  };

  const tabs = state?.tabs ?? [];
  const active = tabs.find((t) => t.active);
  const status = control ? (
    <Badge tone="warning">Управляете вы — агент ждёт</Badge>
  ) : state?.busy ? (
    <Badge tone="info">Агент: {state.busy}</Badge>
  ) : (
    <Badge tone="neutral">Управляет агент</Badge>
  );

  return (
    <div style={S.root}>
      <div style={S.row}>
        <Button size="sm" variant="ghost" title="Назад" onClick={() => send({ type: "back" })}>
          ←
        </Button>
        <Button size="sm" variant="ghost" title="Вперёд" onClick={() => send({ type: "forward" })}>
          →
        </Button>
        <Button size="sm" variant="ghost" title="Обновить" onClick={() => send({ type: "reload" })}>
          ⟳
        </Button>
        <input
          style={S.url}
          value={draftUrl ?? state?.url ?? ""}
          placeholder="Адрес сайта"
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
            } else if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
      </div>

      <div style={S.row}>
        {tabs.length > 0 && (
          <select style={S.select} value={active?.index ?? ""} onChange={(e) => send({ type: "tab", action: "switch", index: Number(e.target.value) })}>
            {tabs.map((t) => (
              <option key={t.index} value={t.index}>
                {t.index}. {cut(t.title || t.url || "Новая вкладка", 40)}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant="ghost" title="Новая вкладка" onClick={() => send({ type: "tab", action: "new" })}>
          +
        </Button>
        {tabs.length > 0 && (
          <Button size="sm" variant="ghost" title="Закрыть вкладку" onClick={() => send({ type: "tab", action: "close", index: active?.index })}>
            ×
          </Button>
        )}
        <span style={{ flex: 1 }} />
        {state?.running && status}
        {state?.running && (
          <Button size="sm" variant={control ? "primary" : "secondary"} onClick={() => send({ type: "control", on: !control })}>
            {control ? "Вернуть управление агенту" : "Взять управление"}
          </Button>
        )}
      </div>

      {error && <div style={S.error}>{error}</div>}

      {state && !state.running ? (
        <div>
          <EmptyState icon="globe" title="Браузер не запущен" hint="Агент запустит его сам, когда понадобится. Можно открыть сайт вручную: введите адрес выше." />
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Button onClick={() => send({ type: "start" })}>Запустить браузер</Button>
          </div>
        </div>
      ) : (
        <>
          <div
            ref={screenRef}
            tabIndex={0}
            style={{ ...S.screen, boxShadow: control ? "0 0 0 2px #f59e0b" : undefined, cursor: control ? "default" : "not-allowed" }}
            onMouseDown={mouse("down")}
            onMouseUp={mouse("up")}
            onMouseMove={mouse("move")}
            onKeyDown={key("down")}
            onKeyUp={key("up")}
            onPaste={(e) => {
              if (!control) return;
              e.preventDefault();
              const text = e.clipboardData.getData("text");
              if (text) send({ type: "input", event: "text", text });
            }}
            onContextMenu={(e) => control && e.preventDefault()}
            title={control ? undefined : "Нажмите «Взять управление», чтобы кликать и печатать"}
          >
            <img ref={imgRef} alt="" draggable={false} style={{ ...S.img, display: hasFrame ? "block" : "none" }} />
            {!hasFrame && (
              <div style={S.placeholder}>
                <Spinner />
              </div>
            )}
          </div>
          <div style={S.hint}>
            {control
              ? "Клики и клавиши уходят в браузер. Когда закончите (например, пройдёте капчу или войдёте в аккаунт), верните управление агенту."
              : "Это живой экран браузера агента. Чтобы пройти капчу или войти самому, нажмите «Взять управление»."}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- compact renderer for browser_* tool calls in the chat ----------

const LABELS: Record<string, string> = {
  open: "Открыл страницу",
  snapshot: "Осмотрел страницу",
  get_text: "Прочитал текст",
  screenshot: "Сделал скриншот",
  scroll: "Прокрутил страницу",
  back: "Вернулся назад",
  tabs: "Вкладки",
  wait: "Ждёт",
  click: "Нажал",
  type: "Ввёл текст",
  press_key: "Нажал клавишу",
  fill_secret: "Подставил данные из vault",
  download: "Скачал файл",
  submit: "Действие с подтверждением",
};

const C: Record<string, CSSProperties> = {
  box: { margin: "4px 0", fontSize: 13 },
  head: { display: "flex", alignItems: "center", gap: 6, background: "transparent", border: 0, padding: 0, color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left" },
  muted: { opacity: 0.65 },
  pre: { margin: "6px 0 0", padding: 8, borderRadius: 6, background: "rgba(127,127,127,.1)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto", fontSize: 12 },
};

/** The URL from the "Страница: <title> — <url>" line that every browser result ends with. */
function pageUrl(output: string | undefined): string {
  const line = output?.split("\n").find((l) => l.startsWith("Страница: "));
  if (!line) return "";
  const last = line.split(" — ").pop() ?? "";
  return last.replace(/ \(вкладка \d+ из \d+\)$/, "").trim();
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
      <button type="button" style={C.head} onClick={() => setOpen(!open)} title={open ? "Скрыть результат" : "Показать результат"}>
        <span aria-hidden>🌐</span>
        <span style={{ fontWeight: 500 }}>{LABELS[name] ?? call.name}</span>
        {detail && <span>· {cut(detail, 80)}</span>}
        {url && (
          <span style={C.muted} title={url}>
            {shortUrl(url)}
          </span>
        )}
        {!result ? <Spinner size={12} /> : result.isError ? <Badge tone="danger">ошибка</Badge> : null}
      </button>
      {open && result && <pre style={C.pre}>{result.output}</pre>}
    </div>
  );
}

export default definePluginUI((ui) => {
  host = ui;
  const offs = [
    ui.slots.register("pane.right", { id: "browser", title: "Браузер", icon: "globe", component: BrowserPane }),
    ui.slots.register("chat.toolResult", { id: "browser-call", match: { tool: ["browser_*", "*__browser_*"] }, component: BrowserCall }),
  ];
  return () => offs.forEach((off) => off());
});
