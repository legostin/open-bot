// The crypto card (widget "prices"): a row per coin with its logo, name and ticker, the week's sparkline, the price
// and the 24-hour change as a green or red pill.

import { useState, type CSSProperties } from "react";
import { definePluginUI, mediaSrc } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { CoinRow, PricesCard } from "../../server/index.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;
let locale = "en";
let formatDate: OwlbotUI["i18n"]["formatDate"] = (d) => new Date(d).toLocaleString();

function price(n: number, currency: string): string {
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 6;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) }).format(n);
  } catch {
    // Not an ISO currency (btc, eth): the number and the ticker.
    return `${new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(n)} ${currency.toUpperCase()}`;
  }
}

function Spark({ values, up }: { values: number[]; up: boolean }) {
  const w = 72;
  const h = 26;
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const line = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ display: "block", flexShrink: 0 }}>
      <polyline points={line} fill="none" stroke={up ? "var(--success)" : "var(--danger)"} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** The coin's logo over its ticker: the ticker shows while the picture loads, and stays if it never does. */
function Logo({ coin }: { coin: CoinRow }) {
  const [shown, setShown] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = coin.image && !broken ? mediaSrc(coin.image) : undefined;
  const box: CSSProperties = { width: 28, height: 28, borderRadius: 999, flexShrink: 0 };
  return (
    <span aria-hidden style={{ ...box, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-2)", fontSize: 9.5, fontWeight: 700, overflow: "hidden" }}>
      {!shown && coin.symbol.slice(0, 3)}
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setShown(true)}
          onError={() => setBroken(true)}
          style={{ ...box, position: "absolute", inset: 0, objectFit: "cover", opacity: shown ? 1 : 0 }}
        />
      )}
    </span>
  );
}

function Prices({ data }: WidgetProps<PricesCard>) {
  const c = data;
  return (
    <div aria-label={t("card.label")} style={{ fontVariantNumeric: "tabular-nums" }}>
      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        {c.coins.map((coin, i) => {
          const up = (coin.change24h ?? 0) >= 0;
          const weekUp = coin.sparkline ? coin.sparkline[coin.sparkline.length - 1] >= coin.sparkline[0] : up;
          return (
            <div key={coin.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: i ? "1px solid var(--border)" : undefined }}>
              <Logo coin={coin} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{coin.name}</div>
                <div style={{ color: "var(--muted)", fontSize: 11.5 }}>
                  {coin.rank ? `#${coin.rank} · ` : ""}
                  {coin.symbol}
                </div>
              </div>
              {coin.sparkline && coin.sparkline.length > 1 && (
                <span title={t("card.week")}>
                  <Spark values={coin.sparkline} up={weekUp} />
                </span>
              )}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, minWidth: 86 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{price(coin.price, c.currency)}</span>
                {coin.change24h !== undefined && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: 6,
                      color: up ? "var(--success)" : "var(--danger)",
                      background: up ? "var(--success-soft)" : "var(--danger-soft)",
                    }}
                  >
                    {up ? "+" : "−"}
                    {Math.abs(coin.change24h).toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11, padding: "7px 14px 9px", borderTop: "1px solid var(--border)" }}>
        {t("card.source", { time: formatDate(c.at, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }) })}
      </div>
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  locale = ui.i18n.locale;
  formatDate = ui.i18n.formatDate;
  return ui.widgets.add<PricesCard>("prices", Prices);
});
