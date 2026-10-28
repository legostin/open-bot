// The catalog: everything the person can turn on (integrations, widgets, abilities), grouped by situation in life,
// with search. A switch turns an entry on or off in one tap; anything that needs the person (signing in, a token,
// fixing) continues in the chat with the assistant, which shows the setup card there. Once something is on, "Try"
// asks the assistant its example. The technical view of every plugin stays in the Plugins section.

import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, CheckCircle2, ChevronRight, Search, Sparkles } from "lucide-react";
import type { IntegrationView } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { chatStep, filterCatalog, hasSwitch, hueOf, isOn } from "../lib/catalog";
import { STATUS_TONE } from "../lib/integrations";
import { askInChat } from "../state/ask";
import { loadCatalog, useCatalog } from "../state/catalog";
import { loadIntegrations } from "../state/integrations";
import { closePanel, openPanel } from "../state/panel";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { Icon } from "../components/icon";
import { Button, cx, EmptyState, ErrorNote, Input, Loading, Page, Spinner, Toggle } from "../components/ui";

const STEP_LABEL: Record<"connect" | "fix" | "settings", MessageKey> = { connect: "catalog.connect", fix: "catalog.fix", settings: "catalog.settings" };
const STEP_ASK: Record<"connect" | "fix" | "settings", MessageKey> = { connect: "catalog.ask.connect", fix: "catalog.ask.fix", settings: "catalog.ask.settings" };
const STATUS_LINE: Partial<Record<IntegrationView["status"], MessageKey>> = {
  "needs-setup": "integrations.status.needsSetup",
  broken: "integrations.status.broken",
  unavailable: "integrations.status.unavailable",
};

/** Opens the assistant's dialog with `text` as the person's words; the panel steps aside where it covers the chat. */
function useAsk() {
  const [, navigate] = useLocation();
  return (text: string) => {
    if (window.matchMedia("(max-width: 1279px)").matches) closePanel();
    askInChat(undefined, text, navigate).catch((e) => toast(errorText(e), "error"));
  };
}

function Entry({ v, situation, fresh, onTurnedOn }: { v: IntegrationView; situation: string; fresh: boolean; onTurnedOn: (id: string) => void }) {
  const ask = useAsk();
  const [busy, setBusy] = useState(false);
  const on = isOn(v);
  const step = chatStep(v);
  const hue = hueOf(situation);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const after = await api.post<IntegrationView | undefined>(`/api/integrations/${encodeURIComponent(v.id)}/enabled`, { enabled: next });
      await Promise.all([loadCatalog(), loadIntegrations().catch(() => {})]);
      if (!next) return;
      onTurnedOn(v.id);
      // Turned on but not connected yet (a sign-in, a token): that goes on in the chat, as a card.
      if (after && (after.status === "needs-setup" || after.status === "broken")) ask(t("catalog.ask.connect", { name: v.name }));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const status = STATUS_LINE[v.status];
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-xl"
        style={{ background: `color-mix(in srgb, ${hue} ${on ? 16 : 10}%, transparent)`, color: hue }}
        aria-hidden
      >
        <Icon name={v.icon} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{v.name}</span>
        </div>
        <p className="text-[13px] leading-snug text-muted">{v.summary}</p>
        {status && (
          <p className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: `var(--${STATUS_TONE[v.status] === "neutral" ? "muted" : STATUS_TONE[v.status]})` }}>
            <span className="size-1.5 shrink-0 rounded-full bg-current" />
            <span className="truncate">{v.status === "unavailable" && v.detail ? v.detail : t(status)}</span>
          </p>
        )}
        {v.account && v.status === "connected" && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <CheckCircle2 className="size-3.5 shrink-0 text-success" />
            <span className="truncate">{v.account}</span>
          </p>
        )}
        {(step || (on && v.example)) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {step && (
              <Button size="sm" variant={step === "settings" ? "ghost" : "primary"} onClick={() => ask(t(STEP_ASK[step], { name: v.name }))}>
                {t(STEP_LABEL[step])}
                <ArrowRight className="size-3.5" />
              </Button>
            )}
            {on && v.example && v.status === "connected" && (
              <button
                type="button"
                onClick={() => ask(v.example!)}
                className={cx("inline-flex max-w-full items-start gap-1.5 rounded-xl border border-border bg-surface-2/60 px-2.5 py-1.5 text-left text-xs leading-snug text-fg transition hover:bg-surface-2", fresh && "animate-in")}
                title={t("catalog.tryHint")}
              >
                <Sparkles className="mt-px size-3.5 shrink-0" style={{ color: hue }} />
                <span className="line-clamp-2">{t("catalog.try", { example: v.example })}</span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex h-10 shrink-0 items-center">
        {busy ? (
          <Spinner size={18} />
        ) : hasSwitch(v) ? (
          <Toggle checked={on} onChange={(next) => void toggle(next)} label={<span className="sr-only">{t(on ? "catalog.turnOff" : "catalog.turnOn", { name: v.name })}</span>} />
        ) : null}
      </div>
    </div>
  );
}

export function CatalogPage() {
  const c = useCatalog();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  // Entries turned on here: their "Try" appears with a little motion.
  const [fresh, setFresh] = useState<string[]>([]);
  const retry = () => loadCatalog().then(() => setError(undefined), (e) => setError(errorText(e)));
  const sections = c ? filterCatalog(c.sections, query) : [];
  return (
    <Page title={t("nav.integrations")} subtitle={t("catalog.intro")}>
      {error && <ErrorNote onRetry={() => void retry()}>{error}</ErrorNote>}
      {!c && !error && <Loading />}
      {c && (
        <div className="flex flex-col gap-5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("catalog.search")} aria-label={t("catalog.search")} className="pl-9" />
          </div>
          {!sections.length && <EmptyState icon="search" title={t("common.nothingFound")} />}
          {sections.map((s) => (
            <section key={s.id} aria-label={s.title}>
              <h3 className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{s.title}</h3>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {s.items.map((v) => (
                  <Entry key={v.id} v={v} situation={s.id} fresh={fresh.includes(v.id)} onTurnedOn={(id) => setFresh((f) => [...f, id])} />
                ))}
              </div>
            </section>
          ))}
          <button type="button" onClick={() => openPanel("plugins")} className="flex items-center gap-1 self-center px-2 py-1 text-xs text-muted transition hover:text-fg">
            {t("catalog.advanced")}
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
    </Page>
  );
}
