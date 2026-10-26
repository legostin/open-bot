import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useStore } from "../lib/store";
import { dismissToast, toasts } from "../state/toast";
import { t } from "../i18n";
import { cx } from "./ui";

export function Toasts() {
  const list = useStore(toasts);
  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-3 md:inset-x-auto md:top-auto md:right-4 md:bottom-4 md:items-end mobile:top-[calc(env(safe-area-inset-top)+0.5rem)]" aria-live="polite">
      {list.map((item) => {
        const I = item.kind === "error" ? CircleAlert : item.kind === "success" ? CircleCheck : Info;
        return (
          <div
            key={item.id}
            className={cx(
              "animate-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border bg-surface px-3 py-2.5 text-sm shadow-card",
              item.kind === "error" ? "border-danger/40" : item.kind === "success" ? "border-success/40" : "border-border",
            )}
            role={item.kind === "error" ? "alert" : "status"}
          >
            <I className={cx("mt-0.5 size-4 shrink-0", item.kind === "error" ? "text-danger" : item.kind === "success" ? "text-success" : "text-accent")} />
            <span className="min-w-0 flex-1 break-words">{item.text}</span>
            <button type="button" aria-label={t("common.close")} onClick={() => dismissToast(item.id)} className="shrink-0 rounded p-0.5 text-muted hover:text-fg">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
