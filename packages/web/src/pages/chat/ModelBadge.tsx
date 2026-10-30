// How a reply was made (Message.brainRef, model, effort): a quiet mark by the agent's message that says which brain,
// model and effort answered when tapped, and nothing until then. The hub picks them per request (model-router.ts).

import { useEffect, useRef, useState } from "react";
import { Cpu } from "lucide-react";
import type { Message } from "@owlbot/shared";
import { modelLabel } from "@owlbot/shared/models";
import { useStore } from "../../lib/store";
import { brains, ensureBrains, findBrain } from "../../state/brains";
import { effortName } from "../../state/thinking";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

export function ModelBadge({ message, className }: { message: Message; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const list = useStore(brains);
  useEffect(() => {
    if (!open) return;
    ensureBrains();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!message.brainRef && !message.model) return null;
  const rows: Array<[string, string]> = [];
  if (message.brainRef) rows.push([t("message.model.brain"), findBrain(list, message.brainRef)?.label ?? message.brainRef]);
  if (message.model) rows.push([t("message.model.model"), modelLabel(message.model)]);
  if (message.effort) rows.push([t("message.model.effort"), effortName(message.effort)]);
  return (
    <span ref={box} className={cx("relative inline-flex", className)}>
      <button
        type="button"
        aria-label={t("message.model.show")}
        title={t("message.model.show")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cx("press inline-flex size-4 items-center justify-center rounded transition-opacity", open ? "opacity-100" : "opacity-45 hover:opacity-90")}
      >
        <Cpu className="size-3" />
      </button>
      {open && (
        <span role="note" className="animate-in absolute top-5 left-0 z-20 grid w-max max-w-64 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xl border border-hairline bg-surface px-3 py-2 text-xs text-fg shadow-card">
          {rows.map(([k, v]) => (
            <span key={k} className="contents">
              <span className="text-muted">{k}</span>
              <span className="truncate font-medium">{v}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
