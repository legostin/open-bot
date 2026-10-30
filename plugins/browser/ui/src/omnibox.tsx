// The address bar: shows where the tab is (the host in front), takes an address or words to search for, and suggests
// open tabs and pages from the history while the person types.
// The <input> is always there (under the formatted address when idle): a tap focuses it inside the touch, so the
// phone's keyboard comes up. On the phone the focused bar grows over the whole view with the suggestions.

import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { AppWindow, ArrowRight, Clock, Globe, Lock, Search } from "lucide-react";
import { addressKind } from "../../server/address.ts";
import { Favicon } from "./chrome.tsx";
import { engineName, host, hostOf, isBlank, send, t, type BrowserState, type Tab, type Visit } from "./host.ts";

type Item = { kind: "go" | "search"; text: string } | { kind: "tab"; tab: Tab } | { kind: "page"; visit: Visit };

const MAX_ITEMS = 8;

/** The address with Cyrillic and spaces as people type them (the URL parser encodes them again). */
function decoded(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/** The address as people read it: Cyrillic paths decoded, "https://" left out. */
function readable(url: string): { scheme: string; host: string; rest: string } {
  try {
    const u = new URL(url);
    let rest = u.pathname + u.search + u.hash;
    try {
      rest = decodeURI(rest);
    } catch {
      /* keep it encoded */
    }
    return { scheme: u.protocol === "https:" ? "" : `${u.protocol}//`, host: u.host, rest: rest === "/" ? "" : rest };
  } catch {
    return { scheme: "", host: "", rest: url };
  }
}

export function Omnibox(props: {
  state: BrowserState | null;
  /** bar: the desktop toolbar; hero: the new tab page; phone: the phone's address pill, a full view while typing. */
  variant: "bar" | "hero" | "phone";
  inputRef?: MutableRefObject<HTMLInputElement | null>;
  /** Shown at the end of the idle bar (the phone's reload button). */
  trailing?: ReactNode;
}) {
  const { state, variant } = props;
  const url = variant === "hero" ? "" : (state?.url ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [sel, setSel] = useState(0);
  const own = useRef<HTMLInputElement | null>(null);
  // The click that focused the field selects the whole address; its mouseup must not put the caret back.
  const focusing = useRef(false);
  const editing = draft !== null;
  const q = typed ? (draft ?? "").trim() : "";

  useEffect(() => {
    if (!q) {
      setVisits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      host.plugin
        .http<{ visits: Visit[] }>("GET", `suggest?q=${encodeURIComponent(q)}`)
        .then((r) => live && setVisits(r.visits ?? []))
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    if (!q) return [];
    const low = q.toLowerCase();
    const tabs = (state?.tabs ?? []).filter((x) => !x.active && !isBlank(x.url) && `${x.title} ${x.url}`.toLowerCase().includes(low)).slice(0, 3);
    const open = new Set(tabs.map((x) => x.url));
    const pages = visits.filter((v) => !open.has(v.url) && v.url !== state?.url).slice(0, MAX_ITEMS - 1 - tabs.length);
    const first: Item = { kind: addressKind(q) === "url" ? "go" : "search", text: q };
    return [first, ...tabs.map((tab): Item => ({ kind: "tab", tab })), ...pages.map((visit): Item => ({ kind: "page", visit }))];
  }, [q, visits, state?.tabs, state?.url]);

  useEffect(() => setSel(0), [q]);

  const finish = () => {
    setDraft(null);
    setTyped(false);
    own.current?.blur();
  };

  const pick = (item: Item | undefined) => {
    if (!item) {
      const text = (draft ?? "").trim();
      if (text && (typed || text !== url)) send({ type: "navigate", text });
    } else if (item.kind === "tab") send({ type: "tab", action: "switch", index: item.tab.index });
    else send({ type: "navigate", text: item.kind === "page" ? item.visit.url : item.text });
    finish();
  };

  const shown = readable(url);
  const engine = engineName(state?.searchEngine);
  const leading = editing || isBlank(url) ? <Search className="obb-glyph" aria-hidden /> : shown.scheme ? <Globe className="obb-glyph" aria-hidden /> : <Lock className="obb-glyph" aria-hidden />;
  const open = editing && variant === "phone";
  const list = editing && items.length > 0;

  const field = (
    <label className="obb-omni-field">
      {leading}
      <span style={{ position: "relative", display: "flex", flex: 1, minWidth: 0, height: "100%" }}>
        <input
          ref={(el) => {
            own.current = el;
            if (props.inputRef) props.inputRef.current = el;
          }}
          value={editing ? draft : url && !isBlank(url) ? url : ""}
          placeholder={t("ui.omni.placeholder", { engine })}
          aria-label={t("ui.omni.label")}
          role="combobox"
          aria-expanded={list}
          aria-autocomplete="list"
          type="text"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          // Idle, the formatted address over it is what shows.
          style={{ color: editing || isBlank(url) ? undefined : "transparent" }}
          onMouseDown={() => {
            focusing.current = document.activeElement !== own.current;
          }}
          onMouseUp={(e) => {
            if (!focusing.current) return;
            focusing.current = false;
            e.preventDefault();
            e.currentTarget.select();
          }}
          onFocus={(e) => {
            setDraft(isBlank(url) ? "" : decoded(url));
            setTyped(false);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onBlur={() => {
            setDraft(null);
            setTyped(false);
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            setTyped(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pick(list ? items[sel] : undefined);
            } else if (e.key === "Escape") {
              // Leave the field, not the live view.
              e.preventDefault();
              finish();
            } else if (list && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSel((s) => (s + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
            }
          }}
        />
        {!editing && !isBlank(url) && (
          <span
            className="obb-omni-show"
            aria-hidden
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: variant === "phone" ? "center" : "flex-start", pointerEvents: "none" }}
          >
            {variant === "phone" ? (
              <b className="obb-trunc">{hostOf(url) || url}</b>
            ) : (
              <span className="obb-trunc">
                {shown.scheme && <span>{shown.scheme}</span>}
                <b>{shown.host}</b>
                <span>{shown.rest}</span>
              </span>
            )}
          </span>
        )}
      </span>
      {!editing && props.trailing}
    </label>
  );

  return (
    // One tree in every state: the focused input must not be mounted again when the phone's bar opens up.
    <div className={`obb-omni is-${variant}${open ? " obb-sheet" : ""}`}>
      <div className="obb-omni-top">
        <div style={{ flex: 1, minWidth: 0 }}>{field}</div>
        {open && (
          <button type="button" className="obb-link" onPointerDown={(e) => e.preventDefault()} onClick={finish}>
            {t("ui.omni.cancel")}
          </button>
        )}
      </div>
      {list && (
        <div
          className="obb-sugg"
          role="listbox"
          // A press on a row must not blur the field before the click picks it.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item, i) => (
            <div key={i} role="option" aria-selected={i === sel} className="obb-sugg-row" onMouseEnter={() => setSel(i)} onClick={() => pick(item)}>
              <Row item={item} engine={engine} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ item, engine }: { item: Item; engine: string }) {
  if (item.kind !== "tab" && item.kind !== "page") {
    return (
      <>
        {item.kind === "go" ? <ArrowRight className="obb-glyph" aria-hidden /> : <Search className="obb-glyph" aria-hidden />}
        <span className="obb-sugg-main obb-trunc">{item.text}</span>
        <span className="obb-sugg-sub obb-trunc">— {item.kind === "go" ? t("ui.omni.go") : t("ui.omni.search", { engine })}</span>
      </>
    );
  }
  if (item.kind === "tab") {
    return (
      <>
        <AppWindow className="obb-glyph" aria-hidden />
        <span className="obb-sugg-main obb-trunc">{item.tab.title || hostOf(item.tab.url)}</span>
        <span className="obb-sugg-sub obb-trunc">— {t("ui.omni.switch")}</span>
      </>
    );
  }
  const v = item.visit;
  return (
    <>
      {v.icon ? <Favicon icon={v.icon} /> : <Clock className="obb-glyph" aria-hidden />}
      <span className="obb-sugg-main obb-trunc">{v.title || hostOf(v.url) || v.url}</span>
      <span className="obb-sugg-sub obb-trunc">{readable(v.url).host + readable(v.url).rest}</span>
    </>
  );
}
