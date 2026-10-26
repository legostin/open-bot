// Settings section for the Telegram channel: connection status, pairing code, bound chat, unbind.

import { useCallback, useEffect, useState } from "react";
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

const tone = (s: Status) => (s.connected ? "success" : s.state === "error" || s.state === "unauthorized" ? "danger" : s.state === "polling" ? "info" : "warning");
const label = (s: Status) =>
  s.connected ? "Подключён" : s.state === "polling" ? "Ждёт привязки" : s.state === "no-token" ? "Нет токена" : s.state === "unauthorized" ? "Токен не принят" : s.state === "error" ? "Нет связи" : "Подключение…";

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

  if (!status) return <Card title="Telegram">{error ? <p>Не удалось получить статус: {error}</p> : <Spinner />}</Card>;

  return (
    <Card title="Telegram" actions={<Badge tone={tone(status)}>{label(status)}</Badge>}>
      <p style={muted}>{status.detail}</p>

      {(status.state === "no-token" || status.state === "unauthorized") && (
        <ol>
          <li>
            Создайте бота у <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> и скопируйте токен.
          </li>
          <li>
            На пульте безопасности добавьте в vault секрет <code>{status.tokenRef.replace(/^vault:\/\//, "")}</code> с токеном в поле <code>value</code>.
          </li>
          <li>Бот подключится сам в течение минуты.</li>
        </ol>
      )}

      {status.state === "polling" && !status.chat && status.pairingCode && (
        <div>
          <p>
            Откройте бота{status.bot?.username ? ` @${status.bot.username}` : ""} в Telegram и отправьте ему команду:
          </p>
          <div style={code}>/start {status.pairingCode}</div>
          <div style={row}>
            {status.deepLink && (
              <a href={status.deepLink} target="_blank" rel="noreferrer">
                Открыть в Telegram ↗
              </a>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => act("/pairing-code")}>
              Новый код
            </Button>
          </div>
          <p style={muted}>Бот отвечает только одному личному чату — тому, из которого пришёл код.</p>
        </div>
      )}

      {status.chat && (
        <div>
          <p>
            Привязан чат: <b>{status.chat.name}</b>
            <span style={muted}> · с {new Date(status.chat.boundAt).toLocaleString()}</span>
          </p>
          <p style={muted}>Сюда приходят ответы, уведомления и запросы на подтверждение. Команды в чате: /help, /tasks, /stop.</p>
          <div style={row}>
            <Button variant="danger" disabled={busy} onClick={() => act("/unbind", "Отвязать чат Telegram? Уведомления перестанут приходить туда.")}>
              Отвязать
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default definePluginUI((ui) => {
  return ui.settings.section({ id: "telegram", title: "Telegram", component: () => <TelegramSettings ui={ui} /> });
});
