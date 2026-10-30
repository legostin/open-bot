// A compact line for browser_* calls in the chat; a click shows the result.

import { useState } from "react";
import type { CSSProperties } from "react";
import { Badge, Spinner } from "@owlbot/ui";
import type { ToolResultProps } from "@owlbot/ui";
import { cut, LABELED, t } from "./host.ts";

const C: Record<string, CSSProperties> = {
  box: { margin: "4px 0", fontSize: 13 },
  head: { display: "flex", alignItems: "center", gap: 6, background: "transparent", border: 0, padding: 0, color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left" },
  muted: { opacity: 0.65 },
  pre: { margin: "6px 0 0", padding: 8, borderRadius: 6, background: "rgba(127,127,127,.1)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto", fontSize: 12 },
};

/** The URL from the "Page: <title> — <url>" line that every browser result ends with. */
function pageUrl(output: string | undefined): string {
  const line = output?.split("\n").find((l) => l.startsWith("Page: "));
  if (!line) return "";
  const last = line.split(" — ").pop() ?? "";
  return last.replace(/ \(tab \d+ of \d+\)$/, "").trim();
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return cut(x.host + (x.pathname === "/" ? "" : x.pathname), 60);
  } catch {
    return cut(u, 60);
  }
}

export function BrowserCall({ call, result }: ToolResultProps) {
  const [open, setOpen] = useState(false);
  const name = call.name.replace(/^.*?browser_/, "");
  const input = (call.input ?? {}) as Record<string, unknown>;
  const url = (typeof input.url === "string" && input.url) || pageUrl(result?.output);
  const description = typeof input.description === "string" ? input.description : "";
  // An approved action names the control the page showed, then what the agent said it does.
  const submitDetail = typeof input.label === "string" && input.label ? t("ui.call.submitDetail", { label: cut(input.label, 40), description }) : description;
  const detail =
    name === "submit" ? submitDetail : name === "history_clear" ? description : name === "press_key" && typeof input.key === "string" ? input.key : name === "history" && typeof input.query === "string" ? input.query : "";
  return (
    <div style={C.box}>
      <button type="button" style={C.head} onClick={() => setOpen(!open)} title={open ? t("ui.call.hide") : t("ui.call.show")}>
        <span aria-hidden>🌐</span>
        <span style={{ fontWeight: 500 }}>{LABELED.has(name) ? t(`ui.call.${name}`) : call.name}</span>
        {detail && <span>· {cut(detail, 80)}</span>}
        {url && (
          <span style={C.muted} title={url}>
            {shortUrl(url)}
          </span>
        )}
        {!result ? <Spinner size={12} /> : result.isError ? <Badge tone="danger">{t("ui.call.error")}</Badge> : null}
      </button>
      {open && result && <pre style={C.pre}>{result.output}</pre>}
    </div>
  );
}
