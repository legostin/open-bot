// Settings section for the Telegram channel: connection status, pairing code, bound chat, unbind.

import { Fragment, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Button, Card, Spinner, definePluginUI } from "@openbot/ui";
import type { OpenBotUI } from "@openbot/ui";

interface Status {
  connected: boolean;
  state: "starting" | "no-token" | "unauthorized" | "polling" | "error" | "stopped";
  detail: string;
  bot: { id: number; username: string | null; name: string | null } | null;
  chat: { id: number; name: string; boundAt: string } | null;
  pairingCode: string | null;
  deepLink: string | null;
  tokenRef: string;
}

// Set in definePluginUI: the page reloads on a language switch.
let t: OpenBotUI["i18n"]["t"] = (key) => key;
let formatDate: OpenBotUI["i18n"]["formatDate"] = (d) => new Date(d).toLocaleString();

/** A message with React elements in its placeholders: rich("ui.x", { link: <a>…</a> }). */
function rich(key: string, parts: Record<string, ReactNode>): ReactNode[] {
  const marks = Object.fromEntries(Object.keys(parts).map((k) => [k, `\u0000${k}\u0000`]));
  return t(key, marks)
    .split("\u0000")
    .map((s, i) => (i % 2 ? <Fragment key={i}>{parts[s]}</Fragment> : s));
}

const tone = (s: Status) => (s.connected ? "success" : s.state === "error" || s.state === "unauthorized" ? "danger" : s.state === "polling" ? "info" : "warning");
const label = (s: Status) =>
  t(
    s.connected
      ? "ui.state.connected"
      : s.state === "polling"
        ? "ui.state.waiting"
        : s.state === "no-token"
          ? "ui.state.noToken"
          : s.state === "unauthorized"
            ? "ui.state.unauthorized"
            : s.state === "error"
              ? "ui.state.error"
              : "ui.state.connecting",
  );

const muted = { opacity: 0.75, fontSize: "0.9em" } as const;
const code = { fontFamily: "ui-monospace, monospace", fontSize: "1.6em", letterSpacing: "0.2em", fontWeight: 600 } as const;
const row = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 } as const;

function TelegramSettings({ ui }: { ui: OpenBotUI }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    ui.plugin
      .http<Status>("GET", "/status")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [ui]);

  useEffect(() => {
    load();
    const off = ui.plugin.on("status", (s: Status) => setStatus(s));
    return off;
  }, [ui, load]);

  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      setStatus(await ui.plugin.http<Status>("POST", path));
    } catch (e: any) {
      ui.toast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <Card title="Telegram">{error ? <p>{t("ui.statusFailed", { error })}</p> : <Spinner />}</Card>;

  return (
    <Card title="Telegram" actions={<Badge tone={tone(status)}>{label(status)}</Badge>}>
      <p style={muted}>{status.detail}</p>

      {/* No token yet: the setup card above this section has the token field (it goes straight into the vault). */}
      {status.state === "no-token" && <p style={muted}>{t("ui.setup.wait")}</p>}

      {status.state === "polling" && !status.chat && status.pairingCode && (
        <div>
          {status.deepLink ? (
            <>
              <p>{t("ui.pair.oneTap", { bot: status.bot?.username ? `@${status.bot.username}` : t("status.bot") })}</p>
              <div style={row}>
                <Button variant="primary" onClick={() => window.open(status.deepLink!, "_blank", "noopener,noreferrer")}>
                  {t("ui.pair.openLink")}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => act("/pairing-code")}>
                  {t("ui.pair.newCode")}
                </Button>
              </div>
              <p style={muted}>{t("ui.pair.orSend")}</p>
              <div style={code}>/start {status.pairingCode}</div>
            </>
          ) : (
            <>
              <p>{status.bot?.username ? t("ui.pair.promptNamed", { bot: `@${status.bot.username}` }) : t("ui.pair.prompt")}</p>
              <div style={code}>/start {status.pairingCode}</div>
              <div style={row}>
                <Button variant="secondary" disabled={busy} onClick={() => act("/pairing-code")}>
                  {t("ui.pair.newCode")}
                </Button>
              </div>
            </>
          )}
          <p style={muted}>{t("ui.pair.note")}</p>
        </div>
      )}

      {status.chat && (
        <div>
          <p>
            {rich("ui.chat.linked", { name: <b>{status.chat.name}</b> })}
            <span style={muted}> · {t("ui.chat.since", { date: formatDate(status.chat.boundAt, { dateStyle: "medium", timeStyle: "short" }) })}</span>
          </p>
          <p style={muted}>{t("ui.chat.note")}</p>
          <div style={row}>
            <Button variant="danger" disabled={busy} onClick={() => act("/unbind", t("ui.unbindConfirm"))}>
              {t("ui.unbind")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default definePluginUI((ui) => {
  t = (key, params) => ui.i18n.t(key, params);
  formatDate = (d, opts) => ui.i18n.formatDate(d, opts);
  return ui.settings.section({ id: "telegram", title: "Telegram", component: () => <TelegramSettings ui={ui} /> });
});
