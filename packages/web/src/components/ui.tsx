// Shared UI primitives. Button, Card, Badge, EmptyState and Spinner are also exposed to UI plugins (@openbot/ui).

import { useEffect, useId, useRef, useState, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Loader2, X } from "lucide-react";
import type { BadgeProps, ButtonProps, CardProps, EmptyStateProps } from "@openbot/ui";
import { Icon } from "./icon";
import { mergeClasses } from "../lib/classes";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- Button ----------

const BTN_VARIANTS = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-sm",
  secondary: "bg-surface text-fg border border-border hover:bg-surface-2",
  ghost: "text-fg hover:bg-surface-2",
  danger: "bg-danger-soft text-danger hover:brightness-95 border border-transparent",
} as const;

export function Button(
  props: ButtonProps & { className?: string; icon?: ReactNode; loading?: boolean; form?: string; "aria-label"?: string },
) {
  const { children, onClick, variant = "secondary", size = "md", disabled, title, type = "button", className, icon, loading, form } = props;
  return (
    <button
      type={type}
      form={form}
      title={title}
      aria-label={props["aria-label"]}
      disabled={disabled || loading}
      onClick={onClick}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition select-none whitespace-nowrap",
        "disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-10 px-4 text-sm",
        BTN_VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton(props: { label: string; onClick?: () => void; children: ReactNode; className?: string; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        "inline-flex size-9 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-40",
        props.active && "bg-surface-2 text-fg",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

// ---------- Card ----------

export function Card({ title, actions, children, className }: CardProps) {
  return (
    <section className={cx("rounded-2xl border border-border bg-surface shadow-card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 font-semibold">{title}</div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

// ---------- Badge ----------

const TONES = {
  neutral: "bg-surface-2 text-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

export function Badge({ children, tone = "neutral", className, dot }: BadgeProps & { className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

// ---------- EmptyState / Spinner ----------

export function EmptyState({ title, hint, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
        <Icon name={icon ?? "sparkles"} className="size-6" />
      </div>
      <div className="font-medium">{title}</div>
      {hint && <div className="max-w-md text-sm text-muted">{hint}</div>}
    </div>
  );
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 style={{ width: size, height: size }} className={cx("animate-spin text-muted", className)} aria-label="Загрузка" />;
}

export function Loading({ text = "Загрузка…" }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <Spinner /> {text}
    </div>
  );
}

export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

// ---------- form controls ----------

const CONTROL = "w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted/70 transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={mergeClasses(`${CONTROL} h-10`, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={mergeClasses(`${CONTROL} py-2 leading-relaxed`, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={mergeClasses(`${CONTROL} h-10 pr-8`, props.className)} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  const labelId = useId();
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2.5 text-sm select-none", disabled && "pointer-events-none opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition", checked ? "bg-accent" : "bg-surface-3")}
      >
        <span className={cx("inline-block size-5 rounded-full bg-white shadow transition", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
      {label && <span id={labelId}>{label}</span>}
    </label>
  );
}

/** Labelled form row. Use group for composite controls (chips, lists) so clicks on the label do not hit inner buttons. */
export function Field({ label, hint, error, children, className, group }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string; group?: boolean }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={cx("flex flex-col gap-1.5", className)} role={group ? "group" : undefined}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs leading-relaxed text-muted">{hint}</span> : null}
    </Tag>
  );
}

/** Editable list of short strings (globs, hosts, times) as chips with an input. */
export function TagInput({ value, onChange, placeholder, inputType = "text" }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; inputType?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface p-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
      {value.map((v, i) => (
        <span key={v + i} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pr-1 pl-2 font-mono text-xs">
          {v}
          <button type="button" aria-label={`Убрать ${v}`} className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-fg" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        type={inputType}
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none"
      />
    </div>
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Remember what had focus before opening (read during render: an autoFocus child grabs focus before effects run).
  const restoreTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) restoreTo.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo.current?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "animate-in relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-card outline-none sm:rounded-2xl",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="min-w-0 truncate text-base font-semibold">
            {title}
          </h2>
          <IconButton label="Закрыть" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="pb-safe flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Copy ----------

export function CopyButton({ text, label = "Копировать", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx("inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-fg", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? "Скопировано" : label}
    </button>
  );
}

export function CodeLine({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-code-bg px-3 py-2">
      <code className="min-w-0 flex-1 font-mono text-[13px] break-all whitespace-pre-wrap">{children}</code>
      <CopyButton text={children} label="" />
    </div>
  );
}

// ---------- page scaffolding ----------

export function Page({ title, subtitle, actions, children, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cx("mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8", className)}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-xl border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx("rounded-[10px] px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition", value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
