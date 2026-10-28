// The Wikipedia card (widget "article"): the lead picture, the title in Wikipedia's serif, its one-line description,
// the opening paragraphs (folded to a few lines, "More" unfolds them) and the link to the article.

import { useState, type CSSProperties } from "react";
import { definePluginUI, mediaSrc } from "@owlbot/ui";
import type { OwlbotUI, WidgetProps } from "@owlbot/ui";
import type { ArticleCard } from "../../server/index.ts";

let t: OwlbotUI["i18n"]["t"] = (k) => k;

const serif = 'Georgia, "Linux Libertine", "Times New Roman", serif';
const clamp = (lines: number): CSSProperties => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });

function Article({ data }: WidgetProps<ArticleCard>) {
  const a = data;
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const img = a.image && !broken ? mediaSrc(a.image.src) : undefined;
  const long = a.extract.length > 280;
  return (
    <div aria-label={t("card.label", { title: a.title })} lang={a.lang}>
      {img && (
        <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", background: "var(--surface-2)" }}>
          <img src={img} alt="" loading="lazy" onError={() => setBroken(true)} style={{ display: "block", width: "100%", maxHeight: 190, objectFit: "cover" }} />
        </a>
      )}
      <div style={{ padding: "12px 16px 4px" }}>
        <div style={{ fontFamily: serif, fontSize: 21, lineHeight: 1.2, fontWeight: 500 }}>{a.title}</div>
        {a.description && <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 2 }}>{a.description}</div>}
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, ...(open ? {} : clamp(5)) }}>{a.extract}</p>
        {long && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            style={{ marginTop: 2, padding: "2px 0", border: 0, background: "none", color: "var(--muted)", fontFamily: "inherit", fontSize: 13, cursor: "pointer" }}
          >
            {t(open ? "card.less" : "card.more")}
          </button>
        )}
      </div>
      <a
        href={a.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px 11px", marginTop: 6, borderTop: "1px solid var(--border)", color: "inherit", textDecoration: "none", fontSize: 13 }}
      >
        <span style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, width: 20, textAlign: "center" }} aria-hidden>
          W
        </span>
        <span style={{ flex: 1, fontWeight: 500 }}>{t("card.read")}</span>
        <span style={{ color: "var(--muted)" }} aria-hidden>
          ↗
        </span>
      </a>
    </div>
  );
}

export default definePluginUI((ui) => {
  t = ui.i18n.t;
  return ui.widgets.add<ArticleCard>("article", Article);
});
