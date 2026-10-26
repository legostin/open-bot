// First-run checklist on the chat page: brain, vault, Telegram.

import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, CircleCheck, CircleDashed, ExternalLink, X } from "lucide-react";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { hubEvents, session } from "../../state/app";
import { cx } from "../../components/ui";

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
      <button type="button" onClick={dismiss} aria-label="Скрыть" className="absolute top-2.5 right-2.5 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg">
        <X className="size-4" />
      </button>
      <div className="mb-1 font-semibold">Давайте всё настроим 👋</div>
      <p className="mb-3 pr-6 text-sm text-muted">Три шага — и ассистент сможет думать, хранить секреты и писать вам в телефон.</p>
      <ol className="flex flex-col gap-1.5">
        <Step done={brainOk} title="Подключите мозг" hint="Claude Code, Codex или API-ключ" action={<Link href="/brains">Инструкции <ArrowRight className="inline size-3.5" /></Link>} />
        <Step
          done={vaultOk}
          title="Создайте vault"
          hint="Шифрованное хранилище токенов и паролей — в пульте безопасности"
          action={
            <a href={`${s.consoleUrl}/#/vault`} target="_blank" rel="noopener noreferrer">
              Открыть пульт <ExternalLink className="inline size-3.5" />
            </a>
          }
        />
        <Step done={telegramOk} title="Подключите Telegram" hint="Уведомления и подтверждения на телефоне" action={<Link href="/plugins">Плагины <ArrowRight className="inline size-3.5" /></Link>} />
      </ol>
    </div>
  );
}

function Step({ done, title, hint, action }: { done: boolean; title: string; hint: string; action: ReactNode }) {
  return (
    <li className={cx("flex items-center gap-3 rounded-xl px-2.5 py-2", done ? "opacity-60" : "bg-surface-2/70")}>
      {done ? <CircleCheck className="size-5 shrink-0 text-success" /> : <CircleDashed className="size-5 shrink-0 text-muted" />}
      <div className="min-w-0 flex-1">
        <div className={cx("text-sm font-medium", done && "line-through")}>{title}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      {!done && <span className="shrink-0 text-[13px] font-medium text-accent-text [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1">{action}</span>}
    </li>
  );
}
