// First-run checklist on the chat page: brain, vault, Telegram.

import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, CircleCheck, CircleDashed, X } from "lucide-react";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { hubEvents, session } from "../../state/app";
import { openPanel } from "../../state/panel";
import { cx } from "../../components/ui";
import { PluginSetupCard, VaultGate } from "../../components/SecretCards";
import { t } from "../../i18n";

interface BrainRow {
  ref: string;
  connected: boolean;
  probe?: { authenticated: boolean };
}
interface ChannelRow {
  id: string;
  pluginId: string;
  connected?: boolean;
}

const KEY = "ob.checklist.dismissed";

export function FirstRunChecklist() {
  const s = useStore(session);
  const [brains, setBrains] = useState<BrainRow[] | null>(null);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [open, setOpen] = useState<"brain" | "vault" | "telegram" | null>(null);
  const toggle = (step: "brain" | "vault" | "telegram") => setOpen((o) => (o === step ? null : step));
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (dismissed) return;
    const load = () => {
      api.get<BrainRow[]>("/api/brains").then(setBrains, () => setBrains([]));
      api.get<ChannelRow[]>("/api/channels").then(setChannels, () => setChannels([]));
    };
    load();
    return hubEvents.on((e) => {
      if (e.type === "brains.updated" || e.type === "plugins.updated") load();
    });
  }, [dismissed]);

  if (dismissed || !s || brains === null || channels === null) return null;

  const brainOk = brains.some((b) => b.connected && b.probe?.authenticated);
  const vaultOk = s.vaultState !== "uninitialized";
  const telegramOk = channels.some((c) => (c.id === "telegram" || c.pluginId === "telegram") && c.connected);
  if (brainOk && vaultOk && telegramOk) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="animate-in relative mx-auto mb-4 w-full max-w-[640px] rounded-2xl border border-accent/25 bg-surface p-4 shadow-card">
      <button type="button" onClick={dismiss} aria-label={t("checklist.hide")} className="absolute top-2.5 right-2.5 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
        <X className="size-4" />
      </button>
      <div className="mb-1 font-semibold">{t("checklist.title")}</div>
      <p className="mb-3 pr-6 text-sm text-muted">{t("checklist.intro")}</p>
      {/* Every step opens right here: nothing sends the user to another page or the console. */}
      <ol className="flex flex-col gap-1.5">
        <Step done={brainOk} title={t("checklist.brain")} hint={t("checklist.brainHint")} open={open === "brain"} onToggle={() => toggle("brain")}>
          <PluginSetupCard pluginId="brain-api" bare />
          <button type="button" onClick={() => openPanel("brains")} className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent-text">
            {t("checklist.subscriptions")} {t("checklist.brainAction")} <ArrowRight className="size-3.5" />
          </button>
        </Step>
        <Step done={vaultOk} title={t("checklist.vault")} hint={t("checklist.vaultHint")} open={open === "vault"} onToggle={() => toggle("vault")}>
          <VaultGate>{null}</VaultGate>
        </Step>
        <Step done={telegramOk} title={t("checklist.telegram")} hint={t("checklist.telegramHint")} open={open === "telegram"} onToggle={() => toggle("telegram")}>
          <PluginSetupCard pluginId="telegram" bare />
        </Step>
      </ol>
    </div>
  );
}

function Step({ done, title, hint, open, onToggle, children }: { done: boolean; title: string; hint: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li className={cx("rounded-xl px-2.5 py-2", done ? "opacity-60" : "bg-surface-2/70")}>
      <div className="flex items-center gap-3">
        {done ? <CircleCheck className="size-5 shrink-0 text-success" /> : <CircleDashed className="size-5 shrink-0 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className={cx("text-sm font-medium", done && "line-through")}>{title}</div>
          <div className="text-xs text-muted">{hint}</div>
        </div>
        {!done && (
          <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-accent-text">
            {open ? t("checklist.collapse") : t("checklist.setUp")} <ChevronDown className={cx("size-3.5 transition", open && "rotate-180")} />
          </button>
        )}
      </div>
      {open && !done && <div className="mt-2.5 border-t border-border pt-2.5">{children}</div>}
    </li>
  );
}
