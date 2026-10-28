// The weather card (widget "forecast"): the place and now in large type, the next hours as a strip, the days ahead
// with a temperature bar each (where the day sits between the week's coldest and warmest), sunrise and sunset.

import type { CSSProperties } from "react";
import { definePluginUI } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { ForecastCard } from "../../server/index.ts";
import { conditionEmoji, conditionOf } from "../../server/codes.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;
let formatDate: OwlbotUI["i18n"]["formatDate"] = (d) => new Date(d).toLocaleString();

const deg = (n: number) => `${Math.round(n)}°`;
/** The place's local time ("2026-10-28T15:00") read as this device's: hours and weekdays come out as at the place. */
const local = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00` : s);

/** Cold blue through mild green to hot red, by °C. */
function tempColor(c: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [-15, [104, 132, 255]],
    [0, [92, 200, 255]],
    [10, [110, 210, 160]],
    [20, [242, 201, 76]],
    [30, [242, 153, 74]],
    [40, [235, 87, 87]],
  ];
  if (c <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, a] = stops[i - 1];
    const [t2, b] = stops[i];
    if (c <= t2) {
      const k = (c - t1) / (t2 - t1);
      return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(",")})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}

const muted: CSSProperties = { color: "var(--muted)" };
const rain: CSSProperties = { color: "var(--info)", fontSize: 11, fontWeight: 500 };

function Forecast({ data }: WidgetProps<ForecastCard>) {
  const f = data;
  const celsius = (n: number) => (f.units.temp === "°F" ? ((n - 32) * 5) / 9 : n);
  const cur = f.current;
  const cond = conditionOf(cur.code);
  const where = [f.place.region, f.place.country].filter(Boolean).join(", ");
  const lo = Math.min(...f.daily.map((d) => d.min));
  const hi = Math.max(...f.daily.map((d) => d.max));
  const span = Math.max(1, hi - lo);
  const today = f.daily[0];
  const time = (s?: string) => (s ? formatDate(local(s), { hour: "numeric", minute: "2-digit" }) : "");
  const wind = t(f.units.wind === "mph" ? "unit.mph" : "unit.ms", { value: Math.round(cur.wind) });
  // Chances of rain take room only when there is some to show.
  const hourlyRain = f.hourly.some((h) => (h.pop ?? 0) >= 20);
  const dailyRain = f.daily.some((d) => (d.pop ?? 0) >= 20);

  return (
    <div aria-label={t("card.label", { place: f.place.name })} style={{ fontVariantNumeric: "tabular-nums" }}>
      <div
        style={{
          padding: "14px 16px 12px",
          background: `linear-gradient(135deg, color-mix(in srgb, ${tempColor(celsius(cur.temp))} 22%, transparent), transparent 70%)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.25 }}>{f.place.name}</div>
            {where && <div style={{ ...muted, fontSize: 12, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{where}</div>}
          </div>
          <div style={{ fontSize: 34, lineHeight: 1 }} aria-hidden>
            {conditionEmoji(cond, cur.day)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
          <span style={{ fontSize: 46, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1.05 }}>{deg(cur.temp)}</span>
          <span style={{ fontSize: 15, fontWeight: 500 }}>{t(`cond.${cond}`)}</span>
        </div>
        <div style={{ ...muted, fontSize: 12.5, marginTop: 2 }}>
          {[t("card.feels", { temp: deg(cur.feels) }), t("card.wind", { speed: wind }), t("card.humidity", { value: cur.humidity })].join(" · ")}
        </div>
      </div>

      {f.hourly.length > 1 && (
        <div style={{ display: "flex", overflowX: "auto", gap: 2, padding: "8px 10px", borderTop: "1px solid var(--border)", scrollbarWidth: "none" }}>
          {f.hourly.map((h, i) => (
            <div key={h.time} style={{ minWidth: 46, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "2px 0" }}>
              <span style={{ ...muted, fontSize: 11.5, whiteSpace: "nowrap" }}>{i === 0 ? t("card.now") : formatDate(local(h.time), { hour: "numeric" })}</span>
              <span style={{ fontSize: 19, lineHeight: 1.1 }} aria-hidden>
                {i === 0 ? conditionEmoji(cond, cur.day) : conditionEmoji(conditionOf(h.code), h.day)}
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>{deg(i === 0 ? cur.temp : h.temp)}</span>
              {hourlyRain && <span style={{ ...rain, visibility: (h.pop ?? 0) >= 20 ? "visible" : "hidden" }}>{h.pop ?? 0}%</span>}
            </div>
          ))}
        </div>
      )}

      {f.daily.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "4px 14px 6px" }}>
          {f.daily.map((d, i) => {
            const left = ((d.min - lo) / span) * 100;
            const width = Math.max(4, ((d.max - d.min) / span) * 100);
            return (
              <div
                key={d.date}
                style={{ display: "grid", gridTemplateColumns: `minmax(56px, 1fr) 26px ${dailyRain ? "34px " : ""}34px minmax(72px, 2.4fr) 34px`, alignItems: "center", gap: 6, padding: "5px 0", fontSize: 13.5 }}
              >
                <span style={{ fontWeight: i === 0 ? 600 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textTransform: "capitalize" }}>
                  {i === 0 ? t("card.today") : formatDate(local(d.date), { weekday: "short" })}
                </span>
                <span style={{ fontSize: 17, textAlign: "center" }} aria-hidden>
                  {conditionEmoji(conditionOf(d.code))}
                </span>
                {dailyRain && (
                  <span style={{ ...rain, textAlign: "right" }} title={t("card.rain", { value: d.pop ?? 0 })}>
                    {(d.pop ?? 0) >= 20 ? `${d.pop}%` : ""}
                  </span>
                )}
                <span style={{ ...muted, textAlign: "right" }}>{deg(d.min)}</span>
                <span style={{ position: "relative", height: 5, borderRadius: 3, background: "var(--surface-2)" }}>
                  <span
                    style={{
                      position: "absolute",
                      left: `${left}%`,
                      width: `${width}%`,
                      top: 0,
                      bottom: 0,
                      borderRadius: 3,
                      background: `linear-gradient(90deg, ${tempColor(celsius(d.min))}, ${tempColor(celsius(d.max))})`,
                    }}
                  />
                </span>
                <span style={{ fontWeight: 500 }}>{deg(d.max)}</span>
              </div>
            );
          })}
        </div>
      )}

      {today?.sunrise && today?.sunset && (
        <div style={{ ...muted, display: "flex", gap: 14, fontSize: 12, padding: "8px 16px 10px", borderTop: "1px solid var(--border)" }}>
          <span>🌅 {t("card.sunrise", { time: time(today.sunrise) })}</span>
          <span>🌇 {t("card.sunset", { time: time(today.sunset) })}</span>
        </div>
      )}
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  formatDate = ui.i18n.formatDate;
  return ui.widgets.add<ForecastCard>("forecast", Forecast);
});
