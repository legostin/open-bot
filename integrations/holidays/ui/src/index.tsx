// The holidays card (widget "holidays"): the country with its flag, then each holiday as a little calendar leaf with
// its name and how soon it is; long weekends show their span, length and the days to take off. Past ones fade.

import type { CSSProperties } from "react";
import { definePluginUI } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { HolidaysCard, HolidayItem } from "../../server/index.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;
let locale = "en";
let formatDate: OwlbotUI["i18n"]["formatDate"] = (d) => new Date(d).toLocaleDateString();

const noon = (d: string) => new Date(`${d}T12:00:00`);
const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function flag(cc: string): string {
  return /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";
}

function countryName(cc: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

function relative(days: number): string {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
  } catch {
    return String(days);
  }
}

const muted: CSSProperties = { color: "var(--muted)" };

function Leaf({ date, dim }: { date: string; dim: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        width: 42,
        flexShrink: 0,
        borderRadius: 9,
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        textAlign: "center",
        opacity: dim ? 0.55 : 1,
      }}
    >
      <div style={{ background: "#e5484d", color: "#fff", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", padding: "2px 0" }}>
        {formatDate(noon(date), { month: "short" }).replace(".", "")}
      </div>
      <div style={{ fontSize: 18, fontWeight: 650, lineHeight: "26px" }}>{noon(date).getDate()}</div>
    </div>
  );
}

function names(h: HolidayItem): { main: string; other?: string } {
  if (locale === "en" || !h.local) return { main: h.name, ...(h.local ? { other: h.local } : {}) };
  return { main: h.local, other: h.name };
}

function Holidays({ data }: WidgetProps<HolidaysCard>) {
  const c = data;
  const title = c.mode === "upcoming" ? t("card.upcoming") : c.mode === "year" ? t("card.year", { year: c.year ?? "" }) : t("card.weekends", { year: c.year ?? "" });
  return (
    <div aria-label={t("card.label", { title, country: countryName(c.country) })}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 10px" }}>
        <span style={{ fontSize: 24, lineHeight: 1 }} aria-hidden>
          {flag(c.country) || "🎉"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.2 }}>{title}</div>
          <div style={{ ...muted, fontSize: 12.5 }}>{countryName(c.country)}</div>
        </div>
      </div>
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {c.items.map((h, i) => {
          const past = (h.end ?? h.date) < c.today;
          const d = daysFrom(c.today, h.date);
          if (c.mode === "weekends") {
            const span = `${formatDate(noon(h.date), { day: "numeric", month: "short" })} – ${formatDate(noon(h.end ?? h.date), { day: "numeric", month: "short" })}`;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--border)", opacity: past ? 0.6 : 1 }}>
                <Leaf date={h.date} dim={past} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{span}</div>
                  {h.bridge?.length ? (
                    <div style={{ fontSize: 12, color: "var(--warning)" }}>{t("card.bridge", { dates: h.bridge.map((b) => formatDate(noon(b), { day: "numeric", month: "short" })).join(", ") })}</div>
                  ) : (
                    <div style={{ ...muted, fontSize: 12 }}>{formatDate(noon(h.date), { weekday: "long" })}</div>
                  )}
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 8px", borderRadius: 999, background: "var(--success-soft)", color: "var(--success)", whiteSpace: "nowrap" }}>
                  {t("card.days", { n: h.days ?? 0 })}
                </span>
              </div>
            );
          }
          const n = names(h);
          const when = c.mode === "upcoming" || (!past && d <= 60) ? relative(d) : formatDate(noon(h.date), { weekday: "short" });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--border)", opacity: past ? 0.55 : 1 }}>
              <Leaf date={h.date} dim={past} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 14, lineHeight: 1.3 }}>{n.main}</div>
                {(n.other || h.end) && (
                  <div style={{ ...muted, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {[h.end ? `${formatDate(noon(h.date), { day: "numeric", month: "short" })} – ${formatDate(noon(h.end), { day: "numeric", month: "short" })}` : "", n.other]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </div>
              <span style={{ ...muted, fontSize: 12, whiteSpace: "nowrap", fontWeight: d >= 0 && d <= 7 ? 600 : 400, color: d >= 0 && d <= 7 ? "var(--fg)" : "var(--muted)" }}>{when}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  locale = ui.i18n.locale;
  formatDate = ui.i18n.formatDate;
  return ui.widgets.add<HolidaysCard>("holidays", Holidays);
});
