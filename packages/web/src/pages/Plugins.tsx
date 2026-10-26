// Plugins: status, enable/disable, restart, logs, settings, install (git URL / folder) and uninstall.

import { useCallback, useEffect, useState } from "react";
import { Download, FileText, GitBranch, Power, RotateCw, Settings2, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { formatTime, type Tone } from "../lib/format";
import { hubEvents } from "../state/app";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
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

const STATUS: Record<string, { key: MessageKey; tone: Tone }> = {
  running: { key: "plugins.status.running", tone: "success" },
  starting: { key: "plugins.status.starting", tone: "info" },
  stopped: { key: "plugins.status.stopped", tone: "neutral" },
  crashed: { key: "plugins.status.crashed", tone: "danger" },
  disabled: { key: "plugins.status.disabled", tone: "neutral" },
  "no-server": { key: "plugins.status.noServer", tone: "neutral" },
  error: { key: "plugins.status.error", tone: "danger" },
};

const PERM_LABELS: Record<keyof Permissions, MessageKey> = {
  network: "plugins.perm.network",
  vault: "plugins.perm.vault",
  core: "plugins.perm.core",
  ui: "plugins.perm.ui",
  fs: "plugins.perm.fs",
};

const UI_STATUS: Record<"loading" | "active" | "error", MessageKey> = { loading: "plugins.ui.loading", active: "plugins.ui.active", error: "plugins.ui.error" };

function PermissionList({ p }: { p: Permissions }) {
  const rows = (Object.keys(PERM_LABELS) as Array<keyof Permissions>).filter((k) => p?.[k]?.length);
  if (!rows.length) return <div className="text-xs text-muted">{t("plugins.perm.none")}</div>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((k) => (
        <div key={k} className="contents">
          <dt className="text-muted">{t(PERM_LABELS[k])}</dt>
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
      title={t("nav.plugins")}
      subtitle={t("plugins.subtitle")}
      actions={
        <Button variant="primary" icon={<Download className="size-4" />} onClick={() => setInstallOpen(true)}>
          {t("plugins.install")}
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && <EmptyState icon="puzzle" title={t("plugins.empty")} hint={t("plugins.emptyHint")} />}
      <div className="flex flex-col gap-3">
        {list?.map((p) => {
          const known = STATUS[p.status];
          const st = known ? { label: t(known.key), tone: known.tone } : { label: p.status, tone: "neutral" as const };
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
                    {p.source === "builtin" && <Badge>{t("plugins.builtin")}</Badge>}
                    {p.formats.map((f) => (
                      <Badge key={f} tone="info">
                        {f}
                      </Badge>
                    ))}
                    {p.hasUi && ui && <Badge tone={ui.status === "error" ? "danger" : ui.status === "active" ? "success" : "neutral"}>{t(UI_STATUS[ui.status])}</Badge>}
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
                  onChange={(v) => void run(`en:${p.id}`, () => api.post(`/api/plugins/${encodeURIComponent(p.id)}/enabled`, { enabled: v }), v ? t("plugins.enabled") : t("plugins.disabled"))}
                  label={<span className="sr-only">{t("plugins.enabledLabel")}</span>}
                />
              </div>

              {(p.lastError || ui?.error) && (
                <div className="mt-3 flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{p.lastError ?? `UI: ${ui?.error}`}</span>
                </div>
              )}

              <details className="mt-3 group">
                <summary className="cursor-pointer text-xs font-medium text-muted select-none hover:text-fg">{t("plugins.capabilities")}</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <PermissionList p={p.permissions} />
                  <div className="flex flex-wrap content-start gap-1 text-xs">
                    {p.contributes?.tools && <Badge>{t("plugins.cap.tools")}</Badge>}
                    {p.contributes?.http && <Badge>http</Badge>}
                    {p.hasServer && <Badge>{t("plugins.cap.process")}</Badge>}
                    {p.hasUi && <Badge>UI</Badge>}
                    {p.contributes?.brains?.map((b) => <Badge key={b}>{t("plugins.cap.brain", { name: b })}</Badge>)}
                    {p.contributes?.channels?.map((c) => <Badge key={c}>{t("plugins.cap.channel", { name: c })}</Badge>)}
                    {p.contributes?.triggers?.map((tr) => <Badge key={tr}>{t("plugins.cap.trigger", { name: tr })}</Badge>)}
                  </div>
                </div>
              </details>

              <div className="mt-3 flex flex-wrap justify-end gap-1.5">
                {hasSettings && (
                  <Button size="sm" icon={<Settings2 className="size-3.5" />} onClick={() => setSettingsFor(p)}>
                    {t("plugins.settings")}
                  </Button>
                )}
                {p.hasServer && (
                  <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => setLogsFor(p)}>
                    {t("plugins.logs")}
                  </Button>
                )}
                {p.hasServer && p.enabled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RotateCw className="size-3.5" />}
                    loading={busy === `rs:${p.id}`}
                    onClick={() => void run(`rs:${p.id}`, () => api.post(`/api/plugins/${encodeURIComponent(p.id)}/restart`, {}), t("plugins.restarted"))}
                  >
                    {t("plugins.restart")}
                  </Button>
                )}
                {p.source === "installed" && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(p)}>
                    {t("common.delete")}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {logsFor && <LogsModal plugin={logsFor} onClose={() => setLogsFor(null)} />}
      {settingsFor && (
        <Modal open onClose={() => setSettingsFor(null)} title={t("plugins.settingsTitle", { name: settingsFor.name })} wide>
          <SchemaForm
            schema={settingsFor.contributes?.settings}
            value={settingsFor.settings}
            onSubmit={async (v) => {
              await api.put(`/api/plugins/${encodeURIComponent(settingsFor.id)}/settings`, v);
              toast(t("common.settingsSaved"), "success");
              setSettingsFor(null);
              await load();
            }}
          />
        </Modal>
      )}
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t("plugins.removeTitle", { name: removing?.name })}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const p = removing!;
                setRemoving(null);
                void run(`rm:${p.id}`, () => api.del(`/api/plugins/${encodeURIComponent(p.id)}`), t("plugins.removed"));
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("plugins.removeText")}</p>
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
      title={t("plugins.logsTitle", { name: plugin.name })}
      footer={
        <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={load}>
          {t("common.refresh")}
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!logs && !error && <Loading />}
      {logs && logs.length === 0 && <div className="text-sm text-muted">{t("plugins.noLogs")}</div>}
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
    if (!source.trim()) return setError(t("plugins.needSource"));
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
      toast(t("plugins.installed", { name: preview.manifest.name }), "success");
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
      title={preview ? t("plugins.installConfirmTitle", { name: preview.manifest.name }) : t("plugins.installTitle")}
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)}>{t("common.back")}</Button>
            <Button variant="primary" icon={<Power className="size-4" />} onClick={() => void confirm()} loading={busy} disabled={preview.warnings.length > 0 && !agree}>
              {t("plugins.installConfirm")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => void prepare()} loading={busy}>
              {t("common.check")}
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <div className="flex flex-col gap-4">
          <Field label={t("plugins.source")} hint={t("plugins.sourceHint")}>
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
          <p className="text-xs text-muted">{t("plugins.stagingNote")}</p>
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
              {preview.manifest.author && <>{t("plugins.author", { name: preview.manifest.author })} · </>}
              {preview.hasServer ? t("plugins.hasServer") : t("plugins.noServer")} · {preview.hasUi ? t("plugins.hasUi") : t("plugins.noUi")}
              {preview.commitHash && <> · {t("plugins.commit", { hash: preview.commitHash.slice(0, 10) })}</>}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">{t("plugins.permissions")}</div>
            <PermissionList p={preview.permissions} />
          </div>
          {preview.warnings.length > 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning-soft/60 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-warning">
                <ShieldAlert className="size-4" /> {t("plugins.attention")}
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <div className="mt-3">
                <Toggle checked={agree} onChange={setAgree} label={t("plugins.trust")} />
              </div>
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Modal>
  );
}
