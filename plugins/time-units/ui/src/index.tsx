// The clocks card (widget "clocks"): a tile per place with an analog face (light by day, dark by night), the time,
// and how it relates to the viewer's own: today or tomorrow, hours ahead or behind. "Now" clocks keep running.

import { useEffect, useState } from "react";
import { definePluginUI } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { ClocksCard } from "../../server/index.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;
let locale = "en";

interface ZoneTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsIn(zone: string | undefined, at: Date): ZoneTime {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** Minutes the zone is ahead of the viewer. */
function aheadOfViewer(zone: string, at: Date): number {
  const z = partsIn(zone, at);
  const v = partsIn(undefined, at);
  return Math.round((Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi) - Date.UTC(v.y, v.mo - 1, v.d, v.h, v.mi)) / 60_000);
}

function Face({ h, mi, night }: { h: number; mi: number; night: boolean }) {
  const hourA = ((h % 12) + mi / 60) * 30;
  const minA = mi * 6;
  const fg = night ? "#f3f3f4" : "#18181b";
  return (
    <svg width={44} height={44} viewBox="0 0 58 58" aria-hidden style={{ display: "block", flexShrink: 0 }}>
      <circle cx={29} cy={29} r={27} fill={night ? "#1d1d24" : "#ffffff"} stroke={night ? "#33333d" : "#d9d9d6"} strokeWidth={1.5} />
      {Array.from({ length: 12 }, (_, i) => (
        <line key={i} x1={29} y1={5} x2={29} y2={i % 3 === 0 ? 9.5 : 7.5} stroke={fg} strokeOpacity={i % 3 === 0 ? 0.7 : 0.3} strokeWidth={i % 3 === 0 ? 1.8 : 1.2} strokeLinecap="round" transform={`rotate(${i * 30} 29 29)`} />
      ))}
      <line x1={29} y1={29} x2={29} y2={15.5} stroke={fg} strokeWidth={3} strokeLinecap="round" transform={`rotate(${hourA} 29 29)`} />
      <line x1={29} y1={29} x2={29} y2={9.5} stroke={fg} strokeWidth={2} strokeLinecap="round" transform={`rotate(${minA} 29 29)`} />
      <circle cx={29} cy={29} r={2.4} fill="#e5484d" />
    </svg>
  );
}

function Clocks({ data }: WidgetProps<ClocksCard>) {
  const c = data;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!c.live) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [c.live]);
  const at = c.live ? new Date(now) : new Date(c.at);
  const viewer = partsIn(undefined, at);
  return (
    <div aria-label={t("card.label")}>
      {c.clocks.map((clock, i) => {
        let p: ZoneTime;
        let ahead = 0;
        try {
          p = partsIn(clock.zone, at);
          ahead = aheadOfViewer(clock.zone, at);
        } catch {
          return null;
        }
        const night = p.h < 7 || p.h >= 19;
        const dayDiff = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(viewer.y, viewer.mo - 1, viewer.d)) / 86_400_000);
        const day = dayDiff < 0 ? t("card.yesterday") : dayDiff > 0 ? t("card.tomorrow") : t("card.today");
        const hours = Math.abs(ahead) / 60;
        const h = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, "");
        const rel = ahead === 0 ? t("card.same") : ahead > 0 ? t("card.ahead", { h }) : t("card.behind", { h });
        const time = new Intl.DateTimeFormat(locale, { timeZone: clock.zone, hour: "numeric", minute: "2-digit" }).format(at);
        return (
          <div key={`${clock.zone}-${i}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderTop: i ? "1px solid var(--border)" : undefined }}>
            <Face h={p.h} mi={p.mi} night={night} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clock.label}</div>
              <div style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {day} · {rel}
              </div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 300, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{time}</div>
          </div>
        );
      })}
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  locale = ui.i18n.locale;
  return ui.widgets.add<ClocksCard>("clocks", Clocks);
});
