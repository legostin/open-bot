// Plugins: status, enable/disable, restart, logs, settings, install (git URL / folder) and uninstall.

import { useCallback, useEffect, useState } from "react";
import { Download, FileText, GitBranch, Power, RotateCw, Settings2, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { formatTime, type Tone } from "../lib/format";
import { hubEvents } from "../state/app";
import { toast } from "../state/toast";
import { pluginLoad } from "../plugins/host";
import { SchemaForm } from "../components/SchemaForm";
import { Badge, Button, cx, EmptyState, ErrorNote, Field, Input, Loading, Modal, Page, Toggle } from "../components/ui";

interface Permissions {
  network: string[];
  vault: string[];
  core: string[];
  ui: string[];
  fs: string[];
}

interface PluginView {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: "builtin" | "installed";
  enabled: boolean;
  status: string;
  lastError?: string;
  formats: string[];
  permissions: Permissions;
  contributes?: { tools?: boolean; brains?: string[]; channels?: string[]; triggers?: string[]; hooks?: string[]; http?: boolean; settings?: Record<string, unknown> };
  settings: Record<string, unknown>;
  hasUi: boolean;
  hasServer: boolean;
  commitHash?: string;
}

interface InstallPreview {
  stagingId: string;
  manifest: { id: string; name: string; version: string; description: string; author?: string };
  formats: string[];
  permissions: Permissions;
  commitHash?: string;
  warnings: string[];
  hasServer: boolean;
  hasUi: boolean;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "работает", tone: "success" },
  starting: { label: "запускается", tone: "info" },
  stopped: { label: "остановлен", tone: "neutral" },
  crashed: { label: "упал", tone: "danger" },
  disabled: { label: "отключён", tone: "neutral" },
  "no-server": { label: "без процесса", tone: "neutral" },
  error: { label: "ошибка", tone: "danger" },
};

const PERM_LABELS: Record<keyof Permissions, string> = {
  network: "Сеть",
  vault: "Vault",
  core: "API ядра",
  ui: "Интерфейс",
  fs: "Файлы",
};

function PermissionList({ p }: { p: Permissions }) {
  const rows = (Object.keys(PERM_LABELS) as Array<keyof Permissions>).filter((k) => p?.[k]?.length);
  if (!rows.length) return <div className="text-xs text-muted">Особых прав не запрашивает</div>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((k) => (
        <div key={k} className="contents">
          <dt className="text-muted">{PERM_LABELS[k]}</dt>
          <dd className="flex flex-wrap gap-1">
            {p[k].map((v) => (
              <code key={v} className={cx("rounded bg-surface-2 px-1.5 py-0.5 font-mono", (v === "*" || v === "approvals.resolve") && "bg-warning-soft text-warning")}>
                {v}
              </code>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PluginsPage() {
  const [list, setList] = useState<PluginView[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [logsFor, setLogsFor] = useState<PluginView | null>(null);
  const [settingsFor, setSettingsFor] = useState<PluginView | null>(null);
  const [removing, setRemoving] = useState<PluginView | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const uiLoad = useStore(pluginLoad);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setList(await api.get<PluginView[]>("/api/plugins"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return hubEvents.on((e) => {
      if (e.type === "plugins.updated") void load();
    });
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, "success");
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Page
      title="Плагины"
      subtitle="Встроенные возможности тоже плагины. Совместимы с плагинами Claude Code и Codex."
      actions={
        <Button variant="primary" icon={<Download className="size-4" />} onClick={() => setInstallOpen(true)}>
          Установить
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && <EmptyState icon="puzzle" title="Плагинов нет" hint="Установите плагин из git-репозитория или папки." />}
      <div className="flex flex-col gap-3">
        {list?.map((p) => {
          const st = STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
          const ui = uiLoad[p.id];
          const hasSettings = !!p.contributes?.settings && Object.keys(p.contributes.settings).length > 0;
          return (
            <div key={p.id} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{p.name}</span>
                    {p.version && <span className="text-xs text-muted">v{p.version}</span>}
                    <Badge tone={st.tone} dot>
                      {st.label}
                    </Badge>
                    {p.source === "builtin" && <Badge>встроенный</Badge>}
                    {p.formats.map((f) => (
                      <Badge key={f} tone="info">
                        {f}
                      </Badge>
                    ))}
                    {p.hasUi && ui && <Badge tone={ui.status === "error" ? "danger" : ui.status === "active" ? "success" : "neutral"}>UI: {ui.status === "error" ? "ошибка" : ui.status === "active" ? "загружен" : "загрузка"}</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted">
                    {p.id}
                    {p.commitHash && (
                      <span className="ml-2 inline-flex items-center gap-1">
                        <GitBranch className="size-3" />
                        {p.commitHash.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  {p.description && <p className="mt-1.5 text-sm text-muted">{p.description}</p>}
                </div>
                <Toggle
                  checked={p.enabled}
                  disabled={busy === `en:${p.id}`}
                  onChange={(v) => void run(`en:${p.id}`, () => api.post(`/api/plugins/${encodeURIComponent(p.id)}/enabled`, { enabled: v }), v ? "Плагин включён" : "Плагин отключён")}
                  label={<span className="sr-only">Включён</span>}
                />
              </div>

              {(p.lastError || ui?.error) && (
                <div className="mt-3 flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{p.lastError ?? `UI: ${ui?.error}`}</span>
                </div>
              )}

              <details className="mt-3 group">
                <summary className="cursor-pointer text-xs font-medium text-muted select-none hover:text-fg">Права и возможности</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <PermissionList p={p.permissions} />
                  <div className="flex flex-wrap content-start gap-1 text-xs">
                    {p.contributes?.tools && <Badge>инструменты</Badge>}
                    {p.contributes?.http && <Badge>http</Badge>}
                    {p.hasServer && <Badge>процесс</Badge>}
                    {p.hasUi && <Badge>UI</Badge>}
                    {p.contributes?.brains?.map((b) => <Badge key={b}>мозг {b}</Badge>)}
                    {p.contributes?.channels?.map((c) => <Badge key={c}>канал {c}</Badge>)}
                    {p.contributes?.triggers?.map((t) => <Badge key={t}>триггер {t}</Badge>)}
                  </div>
                </div>
              </details>

              <div className="mt-3 flex flex-wrap justify-end gap-1.5">
                {hasSettings && (
                  <Button size="sm" icon={<Settings2 className="size-3.5" />} onClick={() => setSettingsFor(p)}>
                    Настройки
                  </Button>
                )}
                {p.hasServer && (
                  <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => setLogsFor(p)}>
                    Логи
                  </Button>
                )}
                {p.hasServer && p.enabled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RotateCw className="size-3.5" />}
                    loading={busy === `rs:${p.id}`}
                    onClick={() => void run(`rs:${p.id}`, () => api.post(`/api/plugins/${encodeURIComponent(p.id)}/restart`, {}), "Плагин перезапущен")}
                  >
                    Перезапустить
                  </Button>
                )}
                {p.source === "installed" && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(p)}>
                    Удалить
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {logsFor && <LogsModal plugin={logsFor} onClose={() => setLogsFor(null)} />}
      {settingsFor && (
        <Modal open onClose={() => setSettingsFor(null)} title={`Настройки: ${settingsFor.name}`} wide>
          <SchemaForm
            schema={settingsFor.contributes?.settings}
            value={settingsFor.settings}
            onSubmit={async (v) => {
              await api.put(`/api/plugins/${encodeURIComponent(settingsFor.id)}/settings`, v);
              toast("Настройки сохранены", "success");
              setSettingsFor(null);
              await load();
            }}
          />
        </Modal>
      )}
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Удалить «${removing?.name}»?`}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Отмена</Button>
            <Button
              variant="danger"
              onClick={() => {
                const p = removing!;
                setRemoving(null);
                void run(`rm:${p.id}`, () => api.del(`/api/plugins/${encodeURIComponent(p.id)}`), "Плагин удалён");
              }}
            >
              Удалить
            </Button>
          </>
        }
      >
        <p className="text-sm">Файлы плагина и его данные будут удалены. Настройки и секреты в vault останутся.</p>
      </Modal>
      {installOpen && (
        <InstallModal
          onClose={() => setInstallOpen(false)}
          onInstalled={() => {
            setInstallOpen(false);
            void load();
          }}
        />
      )}
    </Page>
  );
}

function LogsModal({ plugin, onClose }: { plugin: PluginView; onClose: () => void }) {
  const [logs, setLogs] = useState<Array<{ ts: string; level: string; msg: string }> | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.get<Array<{ ts: string; level: string; msg: string }>>(`/api/plugins/${encodeURIComponent(plugin.id)}/logs`).then(setLogs, (e) => setError(errorText(e)));
  }, [plugin.id]);
  useEffect(load, [load]);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Логи: ${plugin.name}`}
      footer={
        <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={load}>
          Обновить
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!logs && !error && <Loading />}
      {logs && logs.length === 0 && <div className="text-sm text-muted">Логов пока нет.</div>}
      {logs && logs.length > 0 && (
        <pre className="max-h-[60vh] overflow-auto rounded-xl bg-code-bg p-3 font-mono text-xs leading-relaxed">
          {logs.map((l, i) => (
            <div key={i} className={cx("break-words whitespace-pre-wrap", l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "")}>
              <span className="text-muted">{formatTime(l.ts)} </span>
              {l.msg}
            </div>
          ))}
        </pre>
      )}
    </Modal>
  );
}

function InstallModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [agree, setAgree] = useState(false);

  const prepare = async () => {
    if (!source.trim()) return setError("Укажите git-адрес или путь к папке");
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await api.post<InstallPreview>("/api/plugins/install", { source: source.trim() }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/api/plugins/install/confirm", { stagingId: preview.stagingId });
      toast(`Плагин «${preview.manifest.name}» установлен`, "success");
      onInstalled();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={preview ? `Установить «${preview.manifest.name}»?` : "Установить плагин"}
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)}>Назад</Button>
            <Button variant="primary" icon={<Power className="size-4" />} onClick={() => void confirm()} loading={busy} disabled={preview.warnings.length > 0 && !agree}>
              Установить и включить
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Отмена</Button>
            <Button variant="primary" onClick={() => void prepare()} loading={busy}>
              Проверить
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <div className="flex flex-col gap-4">
          <Field label="Источник" hint="Git-репозиторий (https://…, git@…) или путь к папке на сервере хаба. Подходят плагины open-bot, Claude Code и Codex.">
            <Input
              autoFocus
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://github.com/user/openbot-plugin.git"
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") void prepare();
              }}
            />
          </Field>
          <p className="text-xs text-muted">Сначала плагин скачивается во временную папку — вы увидите права, которые он просит, и решите, ставить ли его.</p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{preview.manifest.name}</span>
              <span className="font-mono text-xs text-muted">
                {preview.manifest.id} v{preview.manifest.version}
              </span>
              {preview.formats.map((f) => (
                <Badge key={f} tone="info">
                  {f}
                </Badge>
              ))}
            </div>
            {preview.manifest.description && <p className="mt-1 text-sm text-muted">{preview.manifest.description}</p>}
            <div className="mt-1 text-xs text-muted">
              {preview.manifest.author && <>Автор: {preview.manifest.author} · </>}
              {preview.hasServer ? "есть серверная часть" : "без серверной части"} · {preview.hasUi ? "есть UI" : "без UI"}
              {preview.commitHash && <> · коммит {preview.commitHash.slice(0, 10)}</>}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">Права</div>
            <PermissionList p={preview.permissions} />
          </div>
          {preview.warnings.length > 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning-soft/60 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-warning">
                <ShieldAlert className="size-4" /> Обратите внимание
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <div className="mt-3">
                <Toggle checked={agree} onChange={setAgree} label="Я доверяю этому плагину" />
              </div>
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Modal>
  );
}
