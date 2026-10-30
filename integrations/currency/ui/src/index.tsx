// The exchange card (widget "rates"): the sum on top, then each currency with its flag, the converted sum, the rate
// and, where there is history, a sparkline of the last weeks with how much the rate moved.

import type { CSSProperties } from "react";
import { definePluginUI } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { RatesCard } from "../../server/index.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;
let locale = "en";
let formatDate: OwlbotUI["i18n"]["formatDate"] = (d) => new Date(d).toLocaleDateString();

/** 🇺🇸 for USD, 🇪🇺 for EUR; nothing for codes that are not a country's (XAU, XDR…). */
function flag(code: string): string {
  if (code === "EUR") return "🇪🇺";
  if (code.startsWith("X")) return "";
  const region = code.slice(0, 2);
  try {
    if (new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(region) === undefined) return "";
  } catch {
    return "";
  }
  return String.fromCodePoint(...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function money(n: number, code: string): string {
  const digits = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code, maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) }).format(n);
  } catch {
    return `${n} ${code}`;
  }
}

const num = (n: number) => new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(n);

function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  const w = 84;
  const h = 26;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - lo) / span) * (h - 4)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const color = up ? "var(--success)" : "var(--danger)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ display: "block", overflow: "visible" }}>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill={color} opacity={0.12} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.2} fill={color} />
    </svg>
  );
}

const muted: CSSProperties = { color: "var(--muted)" };

function Rates({ data }: WidgetProps<RatesCard>) {
  const c = data;
  const day = formatDate(new Date(`${c.date}T12:00:00`), { day: "numeric", month: "long" });
  return (
    <div aria-label={t("card.label", { amount: num(c.amount), code: c.from })} style={{ fontVariantNumeric: "tabular-nums" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px" }}>
        <span style={{ fontSize: 26, lineHeight: 1 }} aria-hidden>
          {flag(c.from) || "💱"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.15 }}>{money(c.amount, c.from)}</div>
          <div style={{ ...muted, fontSize: 12.5 }}>{currencyName(c.from)}</div>
        </div>
      </div>
      <div>
        {c.rows.map((r) => {
          const up = (r.change ?? 0) >= 0;
          return (
            <div key={r.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderTop: "1px solid var(--border)" }}>
              <span style={{ fontSize: 22, lineHeight: 1, width: 26, textAlign: "center" }} aria-hidden>
                {flag(r.code) || "🏳️"}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.2, overflowWrap: "anywhere" }}>{money(r.value, r.code)}</div>
                <div style={{ ...muted, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {currencyName(r.code)} · {t("card.rate", { from: c.from, rate: num(r.rate), to: r.code })}
                </div>
              </div>
              {r.history && r.history.length > 1 && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }} title={t("card.days", { n: c.days })}>
                  <Sparkline values={r.history} up={up} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: up ? "var(--success)" : "var(--danger)" }}>
                    {up ? "▲" : "▼"} {Math.abs(r.change ?? 0).toFixed(2)}% · {t("card.days", { n: c.days })}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ ...muted, fontSize: 11, padding: "7px 16px 9px", borderTop: "1px solid var(--border)" }}>
        {c.source === "ecb" ? (
          t("card.ecb", { date: day })
        ) : (
          <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>
            {t("card.erApi", { date: day })}
          </a>
        )}
      </div>
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  locale = ui.i18n.locale;
  formatDate = ui.i18n.formatDate;
  return ui.widgets.add<RatesCard>("rates", Rates);
});
