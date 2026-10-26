// Secrets without leaving the chat: a write-only field that sends the value straight to the vault, the vault's own
// create/unlock step when it is not open yet, the card for a secret the assistant asked for, and a plugin's setup card.
// Values are never shown again, put into messages or sent to the model; the model only learns vault://<id>.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Lock, LockOpen, ShieldCheck, ExternalLink } from "lucide-react";
import type { MessagePart, PluginSetupView, SecretRequest, VaultState } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { hubEvents, session } from "../state/app";
import { usePluginRegistry } from "../plugins/slots";
import { PluginBoundary } from "../plugins/boundary";
import { Markdown } from "./markdown";
import { Badge, Button, Input, Spinner, Toggle, cx } from "./ui";
import { t, type MessageKey } from "../i18n";
import catalogEn from "../i18n/en";

/** A password-style field for one secret. `onSave` gets the value; the field forgets it right after. */
function matches(pattern: string | undefined, value: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true; // a broken pattern in a third-party manifest only disables the warning
  }
}

export function SecretInput({
  vaultId,
  onSave,
  exists,
  compact,
  pattern,
}: {
  vaultId: string;
  onSave: (value: string) => Promise<void>;
  exists?: boolean;
  compact?: boolean;
  /** The declared format: a value that does not match takes a second click (formats change, so it is not a hard rule). */
  pattern?: string;
}) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!value.trim() || busy) return;
    if (!warned && !matches(pattern, value.trim())) {
      setWarned(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
      setValue("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Input
            type={shown ? "text" : "password"}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setWarned(false);
            }}
            placeholder={t("secret.placeholder")}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            data-1p-ignore=""
            data-lpignore="true"
            aria-label={t("secret.placeholder")}
            className="pr-10 font-mono"
          />
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-fg"
            aria-label={shown ? t("secret.hide") : t("secret.show")}
          >
            {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <Button type="submit" variant="primary" size={compact ? "sm" : "md"} loading={busy} disabled={!value.trim()} icon={<Lock className="size-4" />}>
          {warned ? t("secret.saveAnyway") : exists ? t("secret.replace") : t("secret.save")}
        </Button>
      </div>
      {warned && <div className="text-xs text-warning">{t("secret.formatWarning")}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="size-3.5 shrink-0" /> {t("secret.privacy", { id: vaultId })}
      </div>
    </form>
  );
}

/** Creates or unlocks the vault right here when a secret needs it. Renders children once the vault is open. */
export function VaultGate({ children }: { children: React.ReactNode }) {
  const s = useStore(session);
  const state: VaultState = s?.vaultState ?? "unlocked";
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state === "unlocked") return <>{children}</>;
  const creating = state === "uninitialized";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (creating && pass !== repeat) return setError(t("vaultGate.mismatch"));
    setBusy(true);
    setError(null);
    try {
      // The hub broadcasts vault.state; the session store flips and this gate opens.
      await api.post(creating ? "/api/vault/init" : "/api/vault/unlock", { passphrase: pass, remember });
      setPass("");
      setRepeat("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <LockOpen className="size-4 text-accent-text" /> {creating ? t("vaultGate.createTitle") : t("vaultGate.unlockTitle")}
      </div>
      <p className="text-xs text-muted">{creating ? t("vaultGate.createHint") : t("vaultGate.unlockHint")}</p>
      <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t("vaultGate.passphrase")} aria-label={t("vaultGate.passphrase")} autoComplete={creating ? "new-password" : "current-password"} />
      {creating && <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder={t("vaultGate.repeat")} aria-label={t("vaultGate.repeat")} autoComplete="new-password" />}
      <Toggle checked={remember} onChange={setRemember} label={<span className="text-xs">{t("vaultGate.remember")}</span>} />
      {error && <div className="text-xs text-danger">{error}</div>}
      <div>
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={pass.length < (creating ? 8 : 1)}>
          {creating ? t("vaultGate.create") : t("vaultGate.unlock")}
        </Button>
      </div>
    </form>
  );
}

function Hint({ hint, link }: { hint?: string; link?: string }) {
  if (!hint && !link) return null;
  return (
    <div className="text-sm text-muted">
      {hint && <Markdown text={hint} className="text-sm" />}
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium text-accent-text">
          {t("secret.get")} <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

/** A secret the assistant asked for (hub_secret_request). */
export function SecretRequestCard({ part }: { part: Extract<MessagePart, { type: "secret_request" }> }) {
  const [req, setReq] = useState<SecretRequest | null>(null);
  const load = useCallback(() => {
    api.get<SecretRequest>(`/api/secret-requests/${encodeURIComponent(part.requestId)}`).then(setReq, () => setReq(null));
  }, [part.requestId]);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      if (e.type === "secret.request" && e.data.id === part.requestId) setReq(e.data);
    });
  }, [load, part.requestId]);
  const status = req?.status ?? part.status;
  const title = req?.title ?? part.title;
  return (
    <div className={cx("my-2 flex flex-col gap-2 rounded-xl border px-3 py-2.5", status === "pending" ? "border-accent/35 bg-accent-soft/40" : "border-border bg-surface-2/60")}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className={cx("size-4", status === "pending" ? "text-accent-text" : "text-muted")} />
        <span className="text-sm font-semibold">{t("secret.title", { title })}</span>
        {status === "saved" && <Badge tone="success">{t("secret.present")}</Badge>}
        {status === "cancelled" && <Badge tone="neutral">{t("secret.cancelled")}</Badge>}
      </div>
      {status === "pending" && (
        <>
          <Hint hint={req?.hint} link={req?.link} />
          <VaultGate>
            {req?.exists && <div className="text-xs text-muted">{t("secret.replaceHint")}</div>}
            <SecretInput
              vaultId={part.vaultId}
              exists={req?.exists}
              onSave={async (value) => setReq(await api.post<SecretRequest>(`/api/secret-requests/${encodeURIComponent(part.requestId)}`, { value }))}
            />
          </VaultGate>
          <div>
            <Button variant="ghost" size="sm" onClick={() => api.post<SecretRequest>(`/api/secret-requests/${encodeURIComponent(part.requestId)}/cancel`).then(setReq)}>
              {t("secret.cancel")}
            </Button>
          </div>
        </>
      )}
      {status === "saved" && <div className="text-xs text-muted">{t("secret.saved", { id: part.vaultId })}</div>}
    </div>
  );
}

function statusLabel(status: string): string {
  const key = `plugins.status.${status === "no-server" ? "noServer" : status}`;
  return key in catalogEn ? t(key as MessageKey) : status;
}

/** One secret of a plugin: a field while missing, a "Replace" button once it is in the vault. */
function SetupSecretRow({ secret: s, onSave }: { secret: PluginSetupView["secrets"][number]; onSave: (value: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {s.title}
        {s.present ? <Badge tone="success">{t("secret.present")}</Badge> : !s.required && <span className="text-xs font-normal text-muted">{t("secret.optional")}</span>}
        {s.present && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            {t("secret.replace")}
          </Button>
        )}
      </div>
      {!s.present && <Hint hint={s.hint} link={s.link} />}
      {(!s.present || editing) && (
        <SecretInput
          compact
          vaultId={s.vaultId}
          exists={s.present}
          pattern={s.pattern}
          onSave={async (value) => {
            await onSave(value);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

/** A plugin's setup: its secrets and its own setup section (e.g. Telegram pairing), live. */
export function PluginSetupCard({ pluginId, bare }: { pluginId: string; bare?: boolean }) {
  const [view, setView] = useState<PluginSetupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { settings: sections } = usePluginRegistry();
  const load = useCallback(() => {
    api.get<PluginSetupView>(`/api/plugins/${encodeURIComponent(pluginId)}/setup`).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [pluginId]);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      if (e.type === "plugins.updated" || e.type === "vault.state") load();
    });
  }, [load]);
  if (error) return <div className="my-2 text-sm text-danger">{error}</div>;
  if (!view) return <Spinner />;
  const own = sections.filter((s) => s.pluginId === pluginId);
  const missing = view.secrets.filter((s) => s.required && !s.present).length;
  return (
    <div className={cx("flex flex-col gap-3", !bare && "my-2 rounded-xl border border-border bg-surface-2/50 px-3 py-2.5")}>
      {!bare && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{t("setup.title", { name: view.name })}</span>
          {/* A running plugin with its own section (Telegram) shows its real state there; "running" here would contradict a rejected token. */}
          {missing > 0 ? (
            <Badge tone="warning">{t("setup.missing")}</Badge>
          ) : (
            (view.status !== "running" || own.length === 0) && (
              <Badge tone={view.status === "running" ? "success" : "neutral"}>{t("setup.status", { status: statusLabel(view.status) })}</Badge>
            )
          )}
        </div>
      )}
      {!view.enabled && (
        <Toggle
          checked={false}
          onChange={() => api.post(`/api/plugins/${encodeURIComponent(pluginId)}/enabled`, { enabled: true }).then(load, (e) => setError(errorText(e)))}
          label={<span className="text-sm">{t("setup.enable")}</span>}
        />
      )}
      {view.secrets.length > 0 && (
        <VaultGate>
          <div className="flex flex-col gap-3">
            {view.secrets.map((s) => (
              <SetupSecretRow
                key={s.vaultId}
                secret={s}
                onSave={async (value) => setView(await api.post<PluginSetupView>(`/api/plugins/${encodeURIComponent(pluginId)}/secrets/${encodeURIComponent(s.vaultId)}`, { value }))}
              />
            ))}
          </div>
        </VaultGate>
      )}
      {own.map((sec) => {
        const C = sec.component;
        return (
          <PluginBoundary key={sec.key} pluginId={sec.pluginId}>
            <C pluginId={sec.pluginId} />
          </PluginBoundary>
        );
      })}
      {view.secrets.length === 0 && own.length === 0 && <div className="text-sm text-muted">{t("setup.ready")}</div>}
    </div>
  );
}
