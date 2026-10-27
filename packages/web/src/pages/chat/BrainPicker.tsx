// Which brain an agent thinks with, right in its dialog's header: shows the one that will answer and switches it.
// Choosing a brain moves it to the front of the agent's fallback order; the others stay as fallbacks.

import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronDown, Plus } from "lucide-react";
import type { AgentDef } from "@owlbot/shared";
import { api, errorText } from "../../lib/api";
import { useStore } from "../../lib/store";
import { refreshAgents } from "../../state/app";
import { activeBrain, brainReady, brains, brainStatus, ensureBrains, normalizeBrainRef, preferBrain, type BrainRow } from "../../state/brains";
import { openPanel } from "../../state/panel";
import { toast } from "../../state/toast";
import { Badge, cx, Spinner } from "../../components/ui";
import { t } from "../../i18n";

export function BrainPicker({ agent }: { agent: AgentDef }) {
  const list = useStore(brains);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => ensureBrains(), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!list) return null;
  const active = activeBrain(agent.brains, list);
  const rows = list.slice().sort((a, b) => Number(brainReady(b)) - Number(brainReady(a)));

  const choose = async (b: BrainRow) => {
    if (active && normalizeBrainRef(active.ref) === normalizeBrainRef(b.ref)) return setOpen(false);
    setBusy(b.ref);
    try {
      await api.put(`/api/agents/${encodeURIComponent(agent.id)}`, { brains: preferBrain(agent.brains, b.ref) });
      await refreshAgents();
      toast(t("brainPicker.switched", { agent: agent.name, brain: b.label }), "success");
      setOpen(false);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("brainPicker.label")}: ${active ? [active.label, active.probe?.model].filter(Boolean).join(" · ") : t("brainPicker.none")}`}
        className={cx(
          "flex max-w-[11rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
          active ? "border-border bg-surface-2/70 text-fg hover:bg-surface-2" : "border-warning/40 bg-warning-soft/60 text-warning",
        )}
      >
        <Brain className="size-3.5 shrink-0" />
        {/* A narrow bar (TopBar's container) keeps the icon; the title says which brain. */}
        <span className="hidden truncate @lg/top:inline">{active?.label ?? t("brainPicker.none")}</span>
        <ChevronDown className={cx("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute top-full left-0 z-30 mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-1.5 shadow-card">
          <div className="px-2 pt-1 pb-1.5 text-xs text-muted">{t("brainPicker.heading", { agent: agent.name })}</div>
          {rows.map((b) => {
            const ready = brainReady(b);
            const current = !!active && normalizeBrainRef(active.ref) === normalizeBrainRef(b.ref);
            const st = brainStatus(b);
            return (
              <button
                key={b.ref}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                disabled={!ready || !!busy}
                onClick={() => void choose(b)}
                title={!ready ? b.probe?.detail ?? st.label : undefined}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition enabled:hover:bg-surface-2 disabled:opacity-55"
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {busy === b.ref ? <Spinner size={14} /> : current ? <Check className="size-4 text-accent-text" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{b.label}</span>
                  {b.probe?.model && <span className="block truncate text-[11px] text-muted">{t("brains.model", { model: b.probe.model })}</span>}
                </span>
                {!ready && <Badge tone={st.tone}>{st.label}</Badge>}
              </button>
            );
          })}
          <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1 text-[11px] leading-snug text-muted">{t("brainPicker.hint")}</div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openPanel("brains");
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-accent-text hover:bg-surface-2"
          >
            <Plus className="size-4" /> {t("brainPicker.connect")}
          </button>
        </div>
      )}
    </div>
  );
}
