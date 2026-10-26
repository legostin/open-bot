import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Filter, Link2, RefreshCw, ScrollText, ShieldCheck, ShieldX, X } from "lucide-react";
import { api, errorText } from "../api.ts";
import type { AuditEntry, AuditVerify } from "../types.ts";
import { actorLabel, formatDate, shortHash } from "../lib/format.ts";
import { Button, Callout, Card, cx, EmptyState, ErrorText, Input, PageHeader, Spinner } from "../ui/kit.tsx";

const PAGE = 50;

const PRESETS: Array<{ label: string; action: string }> = [
  { label: "Все", action: "" },
  { label: "Подтверждения", action: "approval.*" },
  { label: "Vault", action: "vault.*" },
  { label: "Правила", action: "rule.*" },
  { label: "Вход", action: "auth.*" },
  { label: "Инструменты", action: "tool.*" },
  { label: "Политика", action: "policy.*" },
  { label: "Плагины", action: "plugin.*" },
];

export function AuditPage() {
  const [action, setAction] = useState("");
  const [custom, setCustom] = useState("");
  const [from, setFrom] = useState<number>();
  const [rows, setRows] = useState<AuditEntry[]>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [verify, setVerify] = useState<AuditVerify>();
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string>();
  const seq = useRef(0);

  const load = useCallback(async (opts: { action: string; before?: number; append: boolean }) => {
    const my = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.audit({ limit: PAGE, before: opts.before, action: opts.action || undefined });
      if (my !== seq.current) return;
      setRows((prev) => (opts.append ? [...(prev ?? []), ...page] : page));
      setMore(page.length === PAGE);
    } catch (e) {
      if (my === seq.current) setError(errorText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load({ action, before: from, append: false });
  }, [action, from, load]);

  const runVerify = async () => {
    setVerifying(true);
    setVerifyError(undefined);
    try {
      setVerify(await api.auditVerify());
    } catch (e) {
      setVerifyError(errorText(e));
    } finally {
      setVerifying(false);
    }
  };

  const applyCustom = (e: FormEvent) => {
    e.preventDefault();
    setFrom(undefined);
    setAction(custom.trim());
  };

  const last = rows?.[rows.length - 1];
  const highlight = from !== undefined ? from - 1 : undefined;

  return (
    <div>
      <PageHeader
        title="Аудит"
        description="Журнал всех важных событий: вызовы инструментов, решения политики, подтверждения, обращения к vault, входы. Записи связаны хэш-цепочкой — подмену или удаление видно при проверке."
        actions={
          <Button icon={<ShieldCheck className="size-4" />} loading={verifying} onClick={() => void runVerify()}>
            Проверить целостность
          </Button>
        }
      />

      {verify &&
        (verify.ok ? (
          <Callout tone="ok" className="mb-4" title="Цепочка цела">
            Проверено записей: {verify.count}. Ни одна запись не изменена и не удалена.
          </Callout>
        ) : (
          <Callout tone="danger" className="mb-4" title={`Цепочка нарушена на записи #${verify.brokenAt}`} icon={<ShieldX className="size-4 text-danger" />}>
            <p>Начиная с этой записи журнал был изменён или из него удалены записи. Цельных записей до разрыва: {verify.count}.</p>
            {verify.brokenAt !== undefined && (
              <button
                type="button"
                className="mt-1 font-medium text-danger underline underline-offset-2"
                onClick={() => {
                  setAction("");
                  setCustom("");
                  setFrom(verify.brokenAt! + 1);
                }}
              >
                Показать запись #{verify.brokenAt}
              </button>
            )}
          </Callout>
        ))}
      {verifyError && (
        <div className="mb-4">
          <ErrorText>{verifyError}</ErrorText>
        </div>
      )}

      <div className="mb-4 space-y-3">
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setFrom(undefined);
                setCustom(p.action);
                setAction(p.action);
              }}
              className={cx(
                "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                action === p.action ? "border-brand-line bg-brand-soft text-brand-fg" : "border-line bg-surface text-muted hover:text-fg",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <form onSubmit={applyCustom} className="flex gap-2">
          <div className="relative flex-1">
            <Filter className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input mono value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="vault.reveal, auth.*" className="pl-9" autoCapitalize="off" spellCheck={false} aria-label="Фильтр по действию" />
          </div>
          <Button type="submit">Найти</Button>
          <Button icon={<RefreshCw className={cx("size-4", loading && "animate-spin")} />} onClick={() => void load({ action, before: from, append: false })} aria-label="Обновить" title="Обновить">
            <span className="hidden sm:inline">Обновить</span>
          </Button>
        </form>
        {from !== undefined && (
          <div className="flex items-center gap-2 text-sm text-muted">
            Показаны записи начиная с #{from - 1} и старше.
            <button type="button" className="inline-flex items-center gap-1 font-medium text-brand-fg hover:underline" onClick={() => setFrom(undefined)}>
              <X className="size-3.5" /> к новым
            </button>
          </div>
        )}
      </div>

      {!rows ? (
        error ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <ErrorText>{error}</ErrorText>
            <Button onClick={() => void load({ action, before: from, append: false })}>Повторить</Button>
          </Card>
        ) : (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-8" />} title="Записей не найдено">
          {action ? "Попробуйте другой фильтр. Шаблон: «*» — любые символы, например approval.*" : "Журнал пуст."}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[4.5rem_10.5rem_9rem_minmax(0,11rem)_minmax(0,1fr)_1.5rem] gap-3 border-b border-line bg-inset px-4 py-2 text-xs font-medium text-muted sm:grid">
            <span>#</span>
            <span>Время</span>
            <span>Кто</span>
            <span>Действие</span>
            <span>Объект</span>
            <span />
          </div>
          <div className="divide-y divide-line">
            {rows.map((r) => (
              <AuditRow key={r.seq} r={r} highlighted={r.seq === highlight} />
            ))}
          </div>
        </Card>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <ErrorText>{rows && error}</ErrorText>
          {more ? (
            <Button loading={loading} onClick={() => last && void load({ action, before: last.seq, append: true })}>
              Показать ещё {PAGE}
            </Button>
          ) : (
            <p className="text-xs text-faint">Это начало журнала{action ? " для этого фильтра" : ""}.</p>
          )}
        </div>
      )}
    </div>
  );
}

function actionTone(action: string): string {
  if (action === "auth.failure" || action.endsWith(".remove") || action.endsWith(".deny") || action === "approval.expire") return "text-danger";
  if (action.startsWith("vault.")) return "text-brand-fg";
  if (action.startsWith("approval.") || action.startsWith("rule.")) return "text-warn";
  return "text-fg";
}

function AuditRow({ r, highlighted }: { r: AuditEntry; highlighted: boolean }) {
  const [open, setOpen] = useState(highlighted);
  const hasData = r.data !== undefined && r.data !== null;
  return (
    <div className={cx(highlighted && "bg-danger-soft")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm hover:bg-inset/70 sm:grid-cols-[4.5rem_10.5rem_9rem_minmax(0,11rem)_minmax(0,1fr)_1.5rem] sm:items-center"
      >
        <span className="order-2 font-mono text-xs text-faint sm:order-none">#{r.seq}</span>
        <span className="order-3 text-xs text-muted tabular-nums sm:order-none">{formatDate(r.ts, true)}</span>
        <span className="order-4 truncate text-xs text-muted sm:order-none sm:text-sm sm:text-fg" title={r.actor}>
          {actorLabel(r.actor)}
        </span>
        <span className={cx("order-1 truncate font-mono text-[13px] font-medium sm:order-none", actionTone(r.action))} title={r.action}>
          {r.action}
        </span>
        <span className="order-5 col-span-2 truncate font-mono text-xs text-muted sm:order-none sm:col-span-1" title={r.target}>
          {r.target ?? ""}
        </span>
        <ChevronDown className={cx("hidden size-4 text-faint transition-transform sm:block", open && "rotate-180")} />
      </div>
      {open && (
        <div className="space-y-2 px-4 pb-3">
          {hasData ? (
            <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs leading-relaxed text-fg">{JSON.stringify(r.data, null, 2)}</pre>
          ) : (
            <p className="text-xs text-faint">Без данных</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-faint">
            <span className="inline-flex items-center gap-1" title={r.prevHash}>
              <Link2 className="size-3" /> prev {shortHash(r.prevHash)}
            </span>
            <span title={r.hash}>hash {shortHash(r.hash)}</span>
            <span>{r.actor}</span>
            <span>{r.ts}</span>
          </div>
        </div>
      )}
    </div>
  );
}
