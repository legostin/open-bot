import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useStore } from "../lib/store";
import { dismissToast, toasts } from "../state/toast";
import { cx } from "./ui";

export function Toasts() {
  const list = useStore(toasts);
  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-3 md:inset-x-auto md:top-auto md:right-4 md:bottom-4 md:items-end" aria-live="polite">
      {list.map((t) => {
        const I = t.kind === "error" ? CircleAlert : t.kind === "success" ? CircleCheck : Info;
        return (
          <div
            key={t.id}
            className={cx(
              "animate-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border bg-surface px-3 py-2.5 text-sm shadow-card",
              t.kind === "error" ? "border-danger/40" : t.kind === "success" ? "border-success/40" : "border-border",
            )}
            role={t.kind === "error" ? "alert" : "status"}
          >
            <I className={cx("mt-0.5 size-4 shrink-0", t.kind === "error" ? "text-danger" : t.kind === "success" ? "text-success" : "text-accent")} />
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            <button type="button" aria-label="Закрыть" onClick={() => dismissToast(t.id)} className="shrink-0 rounded p-0.5 text-muted hover:text-fg">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
