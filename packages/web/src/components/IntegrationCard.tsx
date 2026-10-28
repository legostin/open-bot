// One integration of the library, on its page and in the chat (hub_integration_connect): its status and the button
// that moves it forward. Google ones sign in through the hub (a new tab; a pasted return address when the browser
// cannot reach the hub on 127.0.0.1), setup ones open their plugin's setup card, an off one turns on, and access from
// anywhere shows its own steps (RemoteAccessCard).

import { useState } from "react";
import { CheckCircle2, ExternalLink } from "lucide-react";
import type { IntegrationView } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { openExternal } from "../lib/external";
import { primaryAction, STATUS_TONE } from "../lib/integrations";
import { loadIntegrations, useIntegrations } from "../state/integrations";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { Icon } from "./icon";
import { PluginSetupCard, VaultGate } from "./SecretCards";
import { RemoteAccessCard } from "./RemoteAccessCard";
import { Badge, Button, cx, Input, Spinner } from "./ui";

const STATUS_LABEL: Record<IntegrationView["status"], MessageKey> = {
  connected: "integrations.status.connected",
  "needs-setup": "integrations.status.needsSetup",
  broken: "integrations.status.broken",
  off: "integrations.status.off",
  unavailable: "integrations.status.unavailable",
};

function GoogleSignIn({ view, conversationId }: { view: IntegrationView; conversationId?: string }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [pasted, setPasted] = useState("");
  const start = async () => {
    setBusy(true);
    try {
      const { url } = await api.post<{ url: string }>("/api/connections/google/start", { integration: view.id, conversationId });
      openExternal(url);
      setWaiting(true);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const complete = async () => {
    setBusy(true);
    try {
      await api.post("/api/connections/google/complete", { url: pasted });
      setPasted("");
      setWaiting(false);
      await loadIntegrations();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <VaultGate>
      <div className="flex flex-col gap-2">
        <div>
          <Button variant="primary" size="sm" loading={busy && !waiting} onClick={() => void start()} icon={<ExternalLink className="size-4" />}>
            {t(view.status === "broken" ? "integrations.reconnect" : "integrations.connectGoogle")}
          </Button>
        </div>
        {waiting && (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm">
            <span>{t("integrations.waiting")}</span>
            <span className="text-xs text-muted">{t("integrations.pasteHint")}</span>
            <div className="flex gap-2">
              <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:…/oauth/callback?…" aria-label={t("integrations.pasteLabel")} className="min-w-0 flex-1" />
              <Button size="sm" disabled={!pasted.includes("code=")} loading={busy} onClick={() => void complete()}>
                {t("integrations.pasteDone")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </VaultGate>
  );
}

export function IntegrationCard({ view, conversationId, className }: { view: IntegrationView; conversationId?: string; className?: string }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = primaryAction(view);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await loadIntegrations();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <div className={cx("flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3.5", className)}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg">
          <Icon name={view.icon} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{view.name}</span>
            <Badge tone={STATUS_TONE[view.status]} dot>
              {t(STATUS_LABEL[view.status])}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted">{view.summary}</p>
          {/* Access from anywhere shows its link and steps in its own body. */}
          {view.account && view.connect !== "remote" && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              {view.status === "connected" && <CheckCircle2 className="size-3.5 text-success" />}
              <span className="truncate">{view.account}</span>
            </p>
          )}
          {view.detail && view.status !== "connected" && (view.connect !== "remote" || view.status === "unavailable") && <p className="mt-1 text-xs text-muted">{view.detail}</p>}
        </div>
      </div>

      {view.connect === "remote" && <RemoteAccessCard />}
      {action === "turnOn" && (
        <div>
          <Button size="sm" loading={busy} onClick={() => void run(() => api.post(`/api/integrations/${encodeURIComponent(view.id)}/enabled`, { enabled: true, ...(conversationId ? { conversationId } : {}) }))}>
            {t("integrations.turnOn")}
          </Button>
        </div>
      )}
      {(action === "connect" || action === "reconnect") && <GoogleSignIn view={view} conversationId={conversationId} />}
      {action === "disconnect" &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{t("integrations.disconnectConfirm", { name: view.name })}</span>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void run(() => api.del("/api/connections/google"))}>
              {t("integrations.disconnect")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              {t("integrations.disconnect")}
            </Button>
          </div>
        ))}
      {action === "setup" && (
        <>
          <div>
            <Button size="sm" variant={view.status === "connected" ? "ghost" : "primary"} onClick={() => setSetupOpen((o) => !o)}>
              {t(setupOpen ? "integrations.hideSetup" : "integrations.setup")}
            </Button>
          </div>
          {setupOpen && <PluginSetupCard pluginId={view.id} bare />}
        </>
      )}
    </div>
  );
}

/** The card the agent shows in the chat (hub_integration_connect). */
export function IntegrationChatCard({ id, conversationId }: { id: string; conversationId: string }) {
  const list = useIntegrations();
  if (!list) return <Spinner />;
  const view = list.find((v) => v.id === id);
  if (!view) return null;
  return <IntegrationCard view={view} conversationId={conversationId} className="my-2 max-w-xl" />;
}
