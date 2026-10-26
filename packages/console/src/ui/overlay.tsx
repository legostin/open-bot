// Dialogs (native <dialog> for focus trapping and Escape) and toasts.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { Button, cx, ErrorText, IconButton } from "./kit.tsx";
import { errorText } from "../api.ts";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  closeOnBackdrop?: boolean;
}) {
  if (!open) return null;
  return (
    <DialogInner onClose={onClose} title={title} description={description} footer={footer} size={size} closeOnBackdrop={closeOnBackdrop}>
      {children}
    </DialogInner>
  );
}

function DialogInner({
  onClose,
  title,
  description,
  children,
  footer,
  size,
  closeOnBackdrop,
}: {
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size: "sm" | "md" | "lg";
  closeOnBackdrop: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => {
      d.removeEventListener("cancel", onCancel);
      if (d.open) d.close();
    };
  }, []);

  const width = size === "sm" ? "sm:max-w-md" : size === "lg" ? "sm:max-w-3xl" : "sm:max-w-xl";
  return (
    <dialog
      ref={ref}
      aria-labelledby="ob-dialog-title"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (closeOnBackdrop && downOnBackdrop.current && e.target === ref.current) onClose();
      }}
      className={cx(
        "fixed inset-x-0 bottom-0 top-auto m-0 flex max-h-[92dvh] w-full max-w-none flex-col overflow-hidden rounded-t-2xl border border-line bg-surface p-0 text-fg shadow-2xl",
        "sm:inset-0 sm:m-auto sm:h-fit sm:max-h-[88dvh] sm:rounded-xl",
        "backdrop:bg-slate-950/55 backdrop:backdrop-blur-[2px] ob-in",
        width,
      )}
    >
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 id="ob-dialog-title" className="text-base font-semibold text-fg">
            {title}
          </h2>
          {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
        </div>
        <IconButton label="Закрыть" onClick={onClose} className="-mr-1.5 -mt-0.5">
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
      {footer && (
        <div className="pb-safe flex flex-col-reverse gap-2 border-t border-line bg-inset/60 px-4 py-3 sm:flex-row sm:justify-end sm:px-5 [&>button]:w-full sm:[&>button]:w-auto">{footer}</div>
      )}
    </dialog>
  );
}

/** Confirmation for destructive actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  tone = "danger",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant={tone === "danger" ? "danger-solid" : "primary"} onClick={run} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-muted">
        {children}
        <ErrorText>{error}</ErrorText>
      </div>
    </Dialog>
  );
}

// ---------- toasts ----------

type ToastTone = "ok" | "error" | "info";
interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

const ToastCtx = createContext<(text: string, tone?: ToastTone) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (text: string, tone: ToastTone = "ok") => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-3), { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4000);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3 sm:top-auto sm:bottom-4 sm:left-auto sm:right-4 sm:items-end">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cx(
              "ob-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border bg-surface px-3 py-2.5 text-sm text-fg shadow-lg",
              t.tone === "error" ? "border-danger-line" : t.tone === "ok" ? "border-ok-line" : "border-line",
            )}
          >
            {t.tone === "error" ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            ) : t.tone === "ok" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-brand-fg" />
            )}
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            <button type="button" className="text-faint hover:text-fg" aria-label="Закрыть" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
