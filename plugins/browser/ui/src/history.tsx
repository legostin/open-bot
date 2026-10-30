// The history: pages by day with the time and who opened them, a search, deleting a page or all of them.
// A side panel on a wide view, a full view on the phone.

import { useEffect, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { Favicon, IconButton } from "./chrome.tsx";
import { host, hostOf, loadAgentNames, send, t, type Visit } from "./host.ts";

const PAGE = 60;

function dayLabel(at: number): string {
  const day = new Date(at).toDateString();
  const today = new Date();
  if (day === today.toDateString()) return t("ui.history.today");
  if (day === new Date(today.getTime() - 86_400_000).toDateString()) return t("ui.history.yesterday");
  return host.i18n.formatDate(at, { weekday: "long", day: "numeric", month: "long" });
}

export function HistoryPanel({ sheet, onClose }: { sheet: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [confirm, setConfirm] = useState(false);

  const load = async (before?: number) => {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (q.trim()) qs.set("q", q.trim());
    if (before) qs.set("before", String(before));
    const r = await host.plugin.http<{ visits: Visit[]; more: boolean }>("GET", `history?${qs}`);
    setVisits((prev) => (before && prev ? [...prev, ...r.visits] : r.visits));
    setMore(r.more);
  };

  useEffect(() => {
    void loadAgentNames().then(setNames);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load().catch(() => setVisits([])), q ? 200 : 0);
    return () => clearTimeout(timer);
  }, [q]);

  const open = (v: Visit, newTab: boolean) => {
    send({ type: "navigate", text: v.url, newTab });
    if (!newTab) onClose();
  };

  const remove = (v: Visit) => {
    setVisits((list) => list?.filter((x) => x.id !== v.id) ?? null);
    void host.plugin.http("DELETE", `history?id=${encodeURIComponent(v.id)}`).catch(() => {});
  };

  const clear = () => {
    setConfirm(false);
    setVisits([]);
    setMore(false);
    void host.plugin.http("DELETE", "history").catch(() => {});
  };

  const who = (by: string) => (by === "user" ? t("ui.history.byYou") : (names.get(by) ?? t("ui.history.byAgent")));

  const rows: Array<{ day: string; items: Visit[] }> = [];
  for (const v of visits ?? []) {
    const day = dayLabel(v.at);
    if (rows.at(-1)?.day !== day) rows.push({ day, items: [] });
    rows.at(-1)!.items.push(v);
  }

  return (
    <div className={sheet ? "obb-sheet" : "obb-side"} role={sheet ? "dialog" : "complementary"} aria-label={t("ui.history.title")}>
      <div className="obb-head">
        <span className="obb-head-title">{t("ui.history.title")}</span>
        <IconButton label={t("ui.close")} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <label className="obb-search">
        <Search className="obb-glyph" aria-hidden />
        <input
          value={q}
          placeholder={t("ui.history.search")}
          aria-label={t("ui.history.search")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            if (q) setQ("");
            else onClose();
          }}
        />
      </label>
      <div className="obb-list">
        {visits && !visits.length && <div className="obb-empty">{q.trim() ? t("ui.history.nothing") : t("ui.history.empty")}</div>}
        {rows.map((group) => (
          <div key={group.day}>
            <div className="obb-day">{group.day}</div>
            {group.items.map((v) => (
              <div
                key={v.id}
                className="obb-visit"
                role="link"
                title={v.url}
                onClick={(e) => open(v, e.metaKey || e.ctrlKey)}
                onMouseDown={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  open(v, true);
                }}
              >
                <span className="obb-visit-time">{host.i18n.formatDate(v.at, { hour: "2-digit", minute: "2-digit" })}</span>
                <Favicon icon={v.icon} />
                <div className="obb-visit-text">
                  <div className="obb-trunc">{v.title || hostOf(v.url) || v.url}</div>
                  <div className="obb-visit-sub obb-trunc">
                    {hostOf(v.url) || v.url} · {who(v.by)}
                  </div>
                </div>
                <IconButton
                  label={t("ui.history.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(v);
                  }}
                >
                  <X />
                </IconButton>
              </div>
            ))}
          </div>
        ))}
        {more && visits && (
          <div className="obb-list-foot">
            <button type="button" className="obb-btn" onClick={() => void load(visits.at(-1)?.at).catch(() => {})}>
              {t("ui.history.more")}
            </button>
          </div>
        )}
      </div>
      {!!visits?.length && (
        <div className="obb-panel-foot">
          {confirm ? (
            <>
              <span style={{ flex: 1 }}>{t("ui.history.clearConfirm")}</span>
              <button type="button" className="obb-link" onClick={() => setConfirm(false)}>
                {t("ui.history.cancel")}
              </button>
              <button type="button" className="obb-btn obb-danger" onClick={clear}>
                {t("ui.history.clearYes")}
              </button>
            </>
          ) : (
            <button type="button" className="obb-link obb-danger" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setConfirm(true)}>
              <Trash2 size={14} aria-hidden />
              {t("ui.history.clear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
