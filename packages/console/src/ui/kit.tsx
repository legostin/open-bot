// Small UI kit for the console. Tailwind classes over semantic tokens (see index.css).

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, Eye, EyeOff, Info, Loader2, ShieldAlert, X } from "lucide-react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- buttons ----------

type Variant = "primary" | "secondary" | "danger" | "danger-solid" | "ghost";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-accent-800 dark:hover:bg-accent-700 border border-transparent shadow-sm",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-inset",
  danger: "bg-surface text-danger border border-danger-line hover:bg-danger-soft",
  "danger-solid": "bg-red-700 text-white border border-transparent hover:bg-red-800 shadow-sm",
  ghost: "text-muted hover:text-fg hover:bg-inset border border-transparent",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-10 px-3.5 text-sm gap-2 rounded-lg",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors disabled:opacity-55 disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx("inline-flex size-8 items-center justify-center rounded-md text-muted hover:text-fg hover:bg-inset transition-colors disabled:opacity-50", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-muted", className)} aria-label="Загрузка" />;
}

// ---------- layout ----------

export function Card({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div className={cx("rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]", className)} {...rest}>
      {children}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="font-medium text-fg">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

// ---------- feedback ----------

type Tone = "neutral" | "brand" | "warn" | "danger" | "ok";

const BADGE: Record<Tone, string> = {
  neutral: "bg-inset text-muted border-line",
  brand: "bg-brand-soft text-brand-fg border-brand-line",
  warn: "bg-warn-soft text-warn border-warn-line",
  danger: "bg-danger-soft text-danger border-danger-line",
  ok: "bg-ok-soft text-ok border-ok-line",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium leading-4", BADGE[tone], className)}>
      {children}
    </span>
  );
}

const CALLOUT: Record<Exclude<Tone, "neutral">, { box: string; icon: ReactNode }> = {
  brand: { box: "bg-brand-soft border-brand-line text-fg", icon: <Info className="size-4 text-brand-fg" /> },
  warn: { box: "bg-warn-soft border-warn-line text-fg", icon: <AlertTriangle className="size-4 text-warn" /> },
  danger: { box: "bg-danger-soft border-danger-line text-fg", icon: <ShieldAlert className="size-4 text-danger" /> },
  ok: { box: "bg-ok-soft border-ok-line text-fg", icon: <CheckCircle2 className="size-4 text-ok" /> },
};

export function Callout({ tone = "brand", title, children, className, icon }: { tone?: Exclude<Tone, "neutral">; title?: ReactNode; children?: ReactNode; className?: string; icon?: ReactNode }) {
  const c = CALLOUT[tone];
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cx("flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm", c.box, className)}>
      <div className="mt-0.5 shrink-0">{icon ?? c.icon}</div>
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cx(title ? "mt-0.5" : "", "text-[13px] leading-relaxed opacity-90")}>{children}</div>}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ---------- forms ----------

export function Field({ label, hint, error, children, htmlFor, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
          {label}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

const control =
  "w-full rounded-lg border border-line-strong bg-surface px-3 text-[15px] sm:text-sm text-fg placeholder:text-faint shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] focus:border-accent-600 focus:outline-none focus:ring-2 focus:ring-accent-500/25 disabled:opacity-60 disabled:bg-inset";

export function Input({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cx(control, "h-10", mono && "font-mono", className)} {...rest} />;
}

export function Textarea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cx(control, "min-h-24 py-2 leading-relaxed", mono && "font-mono", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, "h-10 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function PasswordInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} className={cx(control, "h-10 pr-10 font-mono", className)} spellCheck={false} autoCapitalize="off" autoCorrect="off" {...rest} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint hover:text-fg"
        aria-label={show ? "Скрыть" : "Показать"}
        title={show ? "Скрыть" : "Показать"}
        tabIndex={-1}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
          checked ? "border-transparent bg-brand" : "border-line-strong bg-inset",
        )}
      >
        <span className={cx("inline-block size-4.5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-[2px]")} />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
        <span className="font-medium text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>}
      </label>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, size = "md" }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; disabled?: boolean }>; className?: string; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" className={cx("inline-flex w-fit max-w-full flex-wrap self-start rounded-lg border border-line bg-inset p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md font-medium transition-colors disabled:opacity-50",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
            value === o.value ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Free-form list editor: Enter, comma or space adds an entry. */
export function ChipsInput({ value, onChange, placeholder, suggestions, mono = true, id }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; mono?: boolean; id?: string }) {
  const [text, setText] = useState("");
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setText("");
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent-600 focus-within:ring-2 focus-within:ring-accent-500/25">
      {value.map((v) => (
        <span key={v} className={cx("inline-flex max-w-full items-center gap-1 rounded-md bg-inset py-0.5 pr-1 pl-2 text-[13px] text-fg ring-1 ring-line", mono && "font-mono")}>
          <span className="truncate">{v}</span>
          <button type="button" className="rounded p-0.5 text-faint hover:text-danger" aria-label={`Убрать ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={suggestions?.length ? listId : undefined}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,;\s]$/.test(v)) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(text)}
        placeholder={value.length ? "" : placeholder}
        className={cx("h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-[15px] text-fg placeholder:text-faint focus:outline-none sm:text-sm", mono && "font-mono")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      ) : null}
    </div>
  );
}

// ---------- clipboard ----------

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Копировать", className, showLabel }: { text: string; label?: string; className?: string; showLabel?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    if (await copyText(text)) {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    }
  };
  if (showLabel) {
    return (
      <Button size="sm" variant="secondary" onClick={onClick} icon={done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />} className={className}>
        {done ? "Скопировано" : label}
      </Button>
    );
  }
  return (
    <IconButton label={done ? "Скопировано" : label} onClick={onClick} className={className}>
      {done ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
    </IconButton>
  );
}
