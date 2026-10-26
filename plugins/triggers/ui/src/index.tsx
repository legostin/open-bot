// "Триггеры" page: list, enable toggle, create/edit per kind, run now, run history.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Spinner, definePluginUI } from "@openbot/ui";
import type { OpenBotUI } from "@openbot/ui";

type Kind = "schedule" | "once" | "watch" | "event" | "heartbeat";

interface Trigger {
  id: string;
  kind: Kind;
  name: string;
  prompt: string;
  agentId: string;
  enabled: boolean;
  maxRunsPerDay: number;
  cron?: string;
  at?: string;
  url?: string;
  selector?: string;
  jsonPath?: string;
  intervalMinutes?: number;
  secret?: string;
  times?: string[];
  weekdays?: number[];
  nextRunAt: string | null;
  webhookUrl: string | null;
  scheduleText: string;
  state: {
    lastRunAt?: string;
    lastStatus?: "ok" | "error" | "skipped";
    lastError?: string;
    lastCheckedAt?: string;
    lastValue?: string;
    done?: boolean;
  };
}

interface Run {
  id: string;
  at: string;
  reason: string;
  status: "started" | "skipped" | "error";
  taskId?: string;
  taskStatus?: string;
  detail?: string;
}

interface ListResponse {
  triggers: Trigger[];
  timezone: string;
  agents: Array<{ id: string; name: string }>;
}

const KIND_LABEL: Record<Kind, string> = {
  schedule: "Расписание",
  once: "Один раз",
  watch: "Слежение",
  event: "Вебхук",
  heartbeat: "Обзор",
};
const KIND_HINT: Record<Kind, string> = {
  schedule: "Повторяется по cron-расписанию в вашем часовом поясе.",
  once: "Срабатывает один раз в указанное время — напоминание.",
  watch: "Проверяет страницу или JSON и запускает агента, только когда значение изменилось.",
  event: "Даёт адрес вебхука с секретом: внешний сервис присылает событие — агент его разбирает.",
  heartbeat: "Регулярный обзор: агент сам смотрит память, задачи и ближайшие дела и пишет, только если есть что-то важное.",
};
const REASON_LABEL: Record<string, string> = {
  schedule: "по расписанию",
  "catch-up": "пропущенный запуск",
  once: "в назначенное время",
  change: "изменение",
  webhook: "вебхук",
  heartbeat: "обзор",
  manual: "вручную",
};
const WEEKDAYS = [
  [1, "Пн"],
  [2, "Вт"],
  [3, "Ср"],
  [4, "Чт"],
  [5, "Пт"],
  [6, "Сб"],
  [0, "Вс"],
] as const;

const s = {
  page: { maxWidth: 960, margin: "0 auto", padding: 16, display: "grid", gap: 12 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  muted: { opacity: 0.7, fontSize: "0.9em" },
  error: { color: "var(--danger, #c0392b)", fontSize: "0.9em" },
  field: { display: "grid", gap: 4, marginBottom: 10 },
  input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", font: "inherit" },
  mono: { fontFamily: "ui-monospace, monospace", fontSize: "0.85em", wordBreak: "break-all" },
} as const;

function fmt(iso: string | null | undefined, tz: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/** ISO instant → "YYYY-MM-DDTHH:MM" wall clock in tz, for <input type="datetime-local">. */
function toLocalInput(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function statusBadge(t: Trigger) {
  if (t.kind === "once" && t.state.done) return <Badge tone="neutral">выполнен</Badge>;
  if (!t.enabled) return <Badge tone="neutral">выключен</Badge>;
  if (t.state.lastStatus === "error") return <Badge tone="danger">ошибка</Badge>;
  if (t.state.lastStatus === "skipped") return <Badge tone="warning">пропуск</Badge>;
  return <Badge tone="success">активен</Badge>;
}

// ---------- form ----------

interface FormProps {
  ui: OpenBotUI;
  initial: Trigger | null;
  agents: ListResponse["agents"];
  tz: string;
  onDone: () => void;
}

function TriggerForm({ ui, initial, agents, tz, onDone }: FormProps) {
  const editing = !!initial;
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "schedule");
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agent, setAgent] = useState(initial?.agentId ?? agents[0]?.id ?? "assistant");
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * 1-5");
  const [at, setAt] = useState(toLocalInput(initial?.at, tz));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [mode, setMode] = useState<"page" | "selector" | "json">(initial?.jsonPath ? "json" : initial?.selector ? "selector" : "page");
  const [selector, setSelector] = useState(initial?.selector ?? "");
  const [jsonPath, setJsonPath] = useState(initial?.jsonPath ?? "");
  const [interval, setIntervalMin] = useState(String(initial?.intervalMinutes ?? 60));
  const [times, setTimes] = useState((initial?.times ?? ["10:00", "18:00"]).join(", "));
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [maxRuns, setMaxRuns] = useState(String(initial?.maxRunsPerDay ?? 24));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body: Record<string, unknown> = { name, prompt, agent, maxRunsPerDay: Number(maxRuns) };
    if (!editing) body.kind = kind;
    if (kind === "schedule") body.cron = cron;
    // Resend the time only when it changed: a fired one-off keeps its past time on rename.
    if (kind === "once" && (!editing || at !== toLocalInput(initial?.at, tz))) body.at = at;
    if (kind === "watch") {
      body.url = url;
      body.intervalMinutes = Number(interval);
      body.selector = mode === "selector" ? selector : null;
      body.jsonPath = mode === "json" ? jsonPath : null;
    }
    if (kind === "heartbeat") {
      body.times = times
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      body.weekdays = weekdays;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) await ui.plugin.http("PATCH", `/triggers/${initial!.id}`, body);
      else await ui.plugin.http("POST", "/triggers", body);
      ui.toast(editing ? "Триггер сохранён" : "Триггер создан", "success");
      onDone();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, input: any, hint?: string) => (
    <label style={s.field}>
      <span>{label}</span>
      {input}
      {hint && <span style={s.muted}>{hint}</span>}
    </label>
  );

  return (
    <Card title={editing ? `Изменить: ${initial!.name}` : "Новый триггер"}>
      {field(
        "Вид",
        <select style={s.input} value={kind} disabled={editing} onChange={(e: any) => setKind(e.target.value)}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>,
        KIND_HINT[kind],
      )}
      {field("Название", <input style={s.input} value={name} onChange={(e: any) => setName(e.target.value)} placeholder="Например: Утренняя сводка" />)}
      {field(
        "Что сделать агенту",
        <textarea style={s.input} rows={5} value={prompt} onChange={(e: any) => setPrompt(e.target.value)} placeholder="Например: проверь почту и напиши, если есть что-то срочное" />,
        "Контекст события (изменение, данные вебхука) добавляется автоматически.",
      )}
      {field(
        "Агент",
        <select style={s.input} value={agent} onChange={(e: any) => setAgent(e.target.value)}>
          {(agents.length ? agents : [{ id: agent, name: agent }]).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>,
      )}

      {kind === "schedule" &&
        field("Cron", <input style={{ ...s.input, ...s.mono }} value={cron} onChange={(e: any) => setCron(e.target.value)} />, `минута час день месяц день_недели, часовой пояс ${tz}. «0 9 * * 1-5» — по будням в 9:00.`)}
      {kind === "once" && field("Когда", <input type="datetime-local" style={s.input} value={at} onChange={(e: any) => setAt(e.target.value)} />, `Время в часовом поясе ${tz}.`)}
      {kind === "watch" && (
        <>
          {field("Адрес страницы или API", <input style={s.input} value={url} onChange={(e: any) => setUrl(e.target.value)} placeholder="https://…" />)}
          {field(
            "Что сравнивать",
            <select style={s.input} value={mode} onChange={(e: any) => setMode(e.target.value)}>
              <option value="page">Весь текст страницы</option>
              <option value="selector">Текст по CSS-селектору</option>
              <option value="json">Значение в JSON</option>
            </select>,
          )}
          {mode === "selector" && field("CSS-селектор", <input style={{ ...s.input, ...s.mono }} value={selector} onChange={(e: any) => setSelector(e.target.value)} placeholder=".price" />)}
          {mode === "json" && field("JSON-путь", <input style={{ ...s.input, ...s.mono }} value={jsonPath} onChange={(e: any) => setJsonPath(e.target.value)} placeholder="data.items[0].price" />)}
          {field("Интервал проверки, минут", <input type="number" min={5} style={s.input} value={interval} onChange={(e: any) => setIntervalMin(e.target.value)} />, "Не меньше 5 минут. Агент запускается только при изменении.")}
        </>
      )}
      {kind === "heartbeat" && (
        <>
          {field("Время", <input style={s.input} value={times} onChange={(e: any) => setTimes(e.target.value)} placeholder="10:00, 18:00" />, `Через запятую, часовой пояс ${tz}.`)}
          <div style={s.field}>
            <span>Дни недели</span>
            <div style={s.row}>
              {WEEKDAYS.map(([d, label]) => (
                <label key={d} style={s.row}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(d)}
                    onChange={(e: any) => setWeekdays(e.target.checked ? [...weekdays, d] : weekdays.filter((x) => x !== d))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      {kind === "event" && !editing && <p style={s.muted}>Адрес вебхука и секрет появятся после создания.</p>}
      {field("Запусков в день, не больше", <input type="number" min={1} style={s.input} value={maxRuns} onChange={(e: any) => setMaxRuns(e.target.value)} />)}

      {error && <p style={s.error}>{error}</p>}
      <div style={s.row}>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {editing ? "Сохранить" : "Создать"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDone}>
          Отмена
        </Button>
      </div>
    </Card>
  );
}

// ---------- history ----------

function History({ ui, trigger, tz, onClose }: { ui: OpenBotUI; trigger: Trigger; tz: string; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const load = useCallback(() => {
    ui.plugin
      .http<{ runs: Run[] }>("GET", `/triggers/${trigger.id}/runs`)
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, [ui, trigger.id]);
  useEffect(() => {
    load();
    return ui.plugin.on("changed", (p: { id?: string }) => {
      if (p?.id === trigger.id) load();
    });
  }, [ui, trigger.id, load]);

  return (
    <Card title={`История: ${trigger.name}`} actions={<Button variant="ghost" size="sm" onClick={onClose}>Закрыть</Button>}>
      {!runs ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <p style={s.muted}>Запусков пока не было.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={{ padding: "4px 8px 4px 0", whiteSpace: "nowrap" }}>{fmt(r.at, tz)}</td>
                <td style={{ padding: "4px 8px" }}>{REASON_LABEL[r.reason] ?? r.reason}</td>
                <td style={{ padding: "4px 8px" }}>
                  <Badge tone={r.status === "started" ? "success" : r.status === "skipped" ? "warning" : "danger"}>
                    {r.status === "started" ? "запущен" : r.status === "skipped" ? "пропущен" : "ошибка"}
                  </Badge>
                </td>
                <td style={{ padding: "4px 0 4px 8px" }}>
                  {r.taskId ? (
                    <a
                      href={`/tasks/${r.taskId}`}
                      onClick={(e: any) => {
                        e.preventDefault();
                        ui.navigate(`/tasks/${r.taskId}`);
                      }}
                    >
                      задача{r.taskStatus ? ` (${r.taskStatus})` : ""}
                    </a>
                  ) : (
                    <span style={s.muted}>{r.detail}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------- list ----------

function TriggerCard({ ui, t, tz, onEdit, onHistory }: { ui: OpenBotUI; t: Trigger; tz: string; onEdit: () => void; onHistory: () => void }) {
  const [busy, setBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const call = async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown, done?: (r: any) => void) => {
    setBusy(true);
    try {
      const r = await ui.plugin.http(method, path, body);
      done?.(r);
    } catch (e: any) {
      ui.toast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => ui.toast("Скопировано", "success"));
  };

  return (
    <Card
      title={
        <span style={s.row}>
          <b>{t.name}</b>
          <Badge tone="info">{KIND_LABEL[t.kind]}</Badge>
          {statusBadge(t)}
        </span>
      }
      actions={
        <label style={s.row} title={t.enabled ? "Выключить" : "Включить"}>
          <input type="checkbox" checked={t.enabled} disabled={busy} onChange={(e: any) => call("PATCH", `/triggers/${t.id}`, { enabled: e.target.checked })} />
          {t.enabled ? "Включён" : "Выключен"}
        </label>
      }
    >
      <div style={{ display: "grid", gap: 4 }}>
        <span style={s.muted}>{t.scheduleText}</span>
        <span>
          Следующий запуск: <b>{t.kind === "event" ? "по событию" : fmt(t.nextRunAt, tz)}</b> · Последний: {fmt(t.state.lastRunAt, tz)}
          {t.kind === "watch" && t.state.lastCheckedAt && <> · Проверено: {fmt(t.state.lastCheckedAt, tz)}</>}
        </span>
        {t.state.lastError && <span style={s.error}>{t.state.lastError}</span>}
        {t.kind === "watch" && t.state.lastValue && <span style={{ ...s.muted, ...s.mono }}>Текущее значение: {t.state.lastValue.slice(0, 200)}</span>}
        {t.kind === "event" && t.webhookUrl && (
          <div style={{ display: "grid", gap: 4 }}>
            <span style={s.row}>
              <span style={s.mono}>{t.webhookUrl}</span>
              <Button size="sm" variant="ghost" onClick={() => copy(t.webhookUrl!)}>
                Копировать
              </Button>
            </span>
            <span style={s.row}>
              Секрет (заголовок x-openbot-secret): <span style={s.mono}>{showSecret ? t.secret : "••••••••"}</span>
              <Button size="sm" variant="ghost" onClick={() => setShowSecret(!showSecret)}>
                {showSecret ? "Скрыть" : "Показать"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copy(t.secret ?? "")}>
                Копировать
              </Button>
            </span>
          </div>
        )}
      </div>
      <div style={{ ...s.row, marginTop: 10 }}>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            call("POST", `/triggers/${t.id}/run`, undefined, (r) =>
              ui.toast(r?.status === "started" ? "Задача запущена" : `Не запущено: ${r?.detail ?? ""}`, r?.status === "started" ? "success" : "error"),
            )
          }
        >
          Запустить сейчас
        </Button>
        {t.kind === "watch" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              call("POST", `/triggers/${t.id}/check`, undefined, (r) =>
                ui.toast(r?.error ? `Ошибка: ${r.error}` : r?.changed ? "Есть изменения — агент запущен" : r?.baseline ? "Запомнил текущее значение" : "Изменений нет", r?.error ? "error" : "info"),
              )
            }
          >
            Проверить
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          Изменить
        </Button>
        <Button size="sm" variant="ghost" onClick={onHistory}>
          История
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Удалить триггер «${t.name}»?`)) void call("DELETE", `/triggers/${t.id}`);
          }}
        >
          Удалить
        </Button>
      </div>
    </Card>
  );
}

function TriggersPage({ ui }: { ui: OpenBotUI }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Trigger | "new" | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  const load = useCallback(() => {
    ui.plugin
      .http<ListResponse>("GET", "/triggers")
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [ui]);

  useEffect(() => {
    load();
    return ui.plugin.on("changed", () => load());
  }, [ui, load]);

  if (!data) return <div style={s.page}>{error ? <p style={s.error}>Не удалось загрузить триггеры: {error}</p> : <Spinner />}</div>;
  const tz = data.timezone;
  const historyTrigger = history ? data.triggers.find((t) => t.id === history) : undefined;

  return (
    <div style={s.page}>
      <div style={s.head}>
        <div>
          <h2 style={{ margin: 0 }}>Триггеры</h2>
          <span style={s.muted}>Когда агенту действовать самому. Часовой пояс: {tz}</span>
        </div>
        {editing === null && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            Создать триггер
          </Button>
        )}
      </div>

      {editing !== null && (
        <TriggerForm
          key={editing === "new" ? "new" : editing.id}
          ui={ui}
          initial={editing === "new" ? null : editing}
          agents={data.agents}
          tz={tz}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {historyTrigger && <History ui={ui} trigger={historyTrigger} tz={tz} onClose={() => setHistory(null)} />}

      {data.triggers.length === 0 ? (
        <EmptyState title="Триггеров пока нет" hint="Создайте расписание, напоминание или слежение за страницей — или попросите ассистента в чате." icon="alarm-clock" />
      ) : (
        data.triggers.map((t) => <TriggerCard key={t.id} ui={ui} t={t} tz={tz} onEdit={() => setEditing(t)} onHistory={() => setHistory(t.id)} />)
      )}
    </div>
  );
}

export default definePluginUI((ui) => {
  return ui.routes.add({ path: "/triggers", title: "Триггеры", icon: "alarm-clock", nav: true, component: () => <TriggersPage ui={ui} /> });
});
