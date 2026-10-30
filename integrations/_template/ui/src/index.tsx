// The template's card (widget "day"): the place, then sunrise and sunset side by side and the day's length.
// A UI module is one file that imports only react and @owlbot/ui (types from the server are fine): the hub compiles
// it when an agent installs the integration, and `npm run build:ui-plugins` does for the ones in the repository.

import { definePluginUI } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { DayCard } from "../../server/index.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;

function Time({ label, time, glyph }: { label: string; time: string; glyph: string }) {
  return (
    <div style={{ flex: 1, padding: "10px 12px", borderRadius: 12, background: "var(--surface-2)" }}>
      <div style={{ color: "var(--muted)", fontSize: 12.5 }}>
        <span aria-hidden>{glyph} </span>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{time}</div>
    </div>
  );
}

function Day({ data }: WidgetProps<DayCard>) {
  const m = Math.round(data.dayLengthSec / 60);
  return (
    <div aria-label={t("card.label", { place: data.place })} style={{ padding: "12px 14px 14px" }}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{data.place}</div>
      {data.date !== "today" && <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{data.date}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Time label={t("card.sunrise")} time={data.sunrise} glyph="↑" />
        <Time label={t("card.sunset")} time={data.sunset} glyph="↓" />
      </div>
      <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>{t("card.day", { length: t("card.hours", { h: Math.floor(m / 60), m: m % 60 }) })}</div>
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  return ui.widgets.add<DayCard>("day", Day);
});
