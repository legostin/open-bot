// The hub's own answer while no brain of the agent works: sign Claude Code or Codex in (installing it first where the
// hub can), or give a key. It shows where the hub put it after an unanswered message, and at the end of a dialog
// that has none yet. Live from /api/setup; once a brain works it shrinks to one line and the agent takes over.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, CircleCheck, RefreshCw } from "lucide-react";
import type { SetupState } from "@openbot/shared";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { cliRows, showGate } from "../lib/setup";
import { conversations, hubEvents, useConversationMessages } from "../state/app";
import { BrainLoginCard } from "./BrainLoginCard";
import { PluginSetupCard, VaultGate } from "./SecretCards";
import { Button, Spinner } from "./ui";
import { t } from "../i18n";

/** The setup state of an agent (the default agent when none is given), reloaded when brains, keys or plugins change. */
function useSetupState(agentId: string | undefined) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
  const load = useCallback(() => {
    api.get<SetupState>(`/api/setup${query}`).then(
      (s) => {
        setState(s);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [query]);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      if (e.type === "brains.updated" || e.type === "plugins.updated" || e.type === "vault.state" || (e.type === "brain.login" && e.data.status === "succeeded")) load();
    });
  }, [load]);
  const refresh = async () => {
    setState(await api.post<SetupState>("/api/setup/refresh", agentId ? { agent: agentId } : {}));
  };
  return { state, error, refresh };
}

/** The card a `brain_setup` part stands for, in the conversation it was added to. */
export function BrainSetupCard({ conversationId }: { conversationId: string }) {
  const agentId = useStore(conversations).find((c) => c.id === conversationId)?.agentId;
  const { state, error, refresh } = useSetupState(agentId);
  if (!state) return error ? <div className="my-2 text-sm text-danger">{error}</div> : <Spinner />;
  return <SetupCardView state={state} refresh={refresh} />;
}

/** The card at the end of a dialog where nothing was written yet and no brain works. */
export function SetupGate({ conversationId, agentId }: { conversationId: string; agentId?: string }) {
  const conv = useConversationMessages(conversationId);
  const { state, refresh } = useSetupState(agentId);
  if (!conv.loaded || !state || !showGate(conv.messages, state)) return null;
  return <SetupCardView state={state} refresh={refresh} />;
}

function SetupCardView({ state, refresh }: { state: SetupState; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.usable) {
    const names = state.brains.filter((b) => b.signedIn).map((b) => b.label);
    return (
      <div className="flex items-center justify-center gap-1.5 text-sm text-muted">
        <CircleCheck className="size-4 text-success" />
        {names.length ? t("brainSetup.connected", { name: names.join(", ") }) : t("brainSetup.ready")}
      </div>
    );
  }

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const rows = cliRows(state);
  return (
    <div className="animate-in w-full rounded-2xl border border-accent/25 bg-surface p-4 shadow-card">
      <div className="mb-1 font-semibold">{t("brainSetup.title")}</div>
      <p className="mb-3 text-sm text-muted">{rows.length ? t("brainSetup.intro") : t("brainSetup.introKeys")}</p>
      <div className="flex flex-col gap-3">
        {rows.map((b) => (
          <div key={b.ref} className="flex flex-col gap-1 rounded-xl bg-surface-2/70 px-2.5 py-2">
            <BrainLoginCard brainRef={b.ref} compact install={!b.installed && b.canInstall} />
            {!b.installed && !b.canInstall && <div className="text-xs text-muted">{b.detail ?? t("brainSetup.notInstalled")}</div>}
          </div>
        ))}
        <details className="group" open={!rows.length}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-accent-text">
            {t("brainSetup.apiKeys")} <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          {/* One gate for both cards, so an absent vault is offered once, not twice. */}
          <div className="mt-2">
            <VaultGate>
              <div className="flex flex-col gap-3">
                <PluginSetupCard pluginId="brain-claude-code" bare />
                <PluginSetupCard pluginId="brain-api" bare />
              </div>
            </VaultGate>
          </div>
        </details>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void check()}>
          {t("brainSetup.checkAgain")}
        </Button>
        <span className="text-xs text-muted">{t("brainSetup.checkAgainHint")}</span>
      </div>
      {error && <div className="mt-1 text-xs text-danger">{error}</div>}
    </div>
  );
}
