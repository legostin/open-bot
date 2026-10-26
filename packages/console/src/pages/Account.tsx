import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Fingerprint, KeyRound, LogOut, Pencil, Plus, Puzzle, Trash2 } from "lucide-react";
import { api, errorText } from "../api.ts";
import type { Passkey, PluginInfo } from "../types.ts";
import { useAsync } from "../hooks.ts";
import { useSession } from "../session.tsx";
import { formatDate } from "../lib/format.ts";
import { setPrefs, usePrefs } from "../prefs.ts";
import { passkeyUnavailableReason, registerPasskey } from "../webauthn.ts";
import { Badge, Button, Callout, Card, ChipsInput, cx, ErrorText, Field, IconButton, Input, PageHeader, PasswordInput, Spinner, Switch } from "../ui/kit.tsx";
import { ConfirmDialog, useToast } from "../ui/overlay.tsx";
import { ThemeSwitch } from "../ui/theme.tsx";
import { LocaleSwitch } from "../ui/locale.tsx";
import { t, type MessageKey } from "../i18n/index.ts";
import { notificationPermission } from "../alerts.ts";

export function AccountPage() {
  const { logout } = useSession();
  return (
    <div>
      <PageHeader
        title={t("account.title")}
        description={t("account.description")}
        actions={
          <Button icon={<LogOut className="size-4" />} onClick={() => void logout()}>
            {t("shell.logout")}
          </Button>
        }
      />
      <div className="space-y-6">
        <Passkeys />
        <ChangePassword />
        <Plugins />
        <DevicePrefs />
      </div>
    </div>
  );
}

function Section({ title, description, children, icon }: { title: string; description?: ReactNode; children: ReactNode; icon?: ReactNode }) {
  return (
    <Card>
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        {icon && <span className="mt-0.5 text-muted">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </Card>
  );
}

// ---------- passkeys ----------

function Passkeys() {
  const toast = useToast();
  const list = useAsync(() => api.passkeys(), []);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<Passkey>();
  const unavailable = passkeyUnavailableReason();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError(undefined);
    try {
      const next = await registerPasskey(name.trim() || defaultPasskeyName());
      list.setData(() => next);
      setName("");
      toast(t("passkeys.added"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Section title={t("passkeys.title")} icon={<Fingerprint className="size-5" />} description={t("passkeys.description")}>
      {!list.data ? (
        list.error ? <ErrorText>{list.error}</ErrorText> : <Spinner />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted">{t("passkeys.empty")}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <KeyRound className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                <div className="text-xs text-muted">{t("passkeys.addedOn", { date: formatDate(p.createdAt) })}</div>
              </div>
              <IconButton label={t("passkeys.removeLabel", { name: p.name })} onClick={() => setRemoving(p)} className="hover:text-danger">
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {!unavailable ? (
        <form onSubmit={add} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("passkeys.namePlaceholder", { example: defaultPasskeyName() })} aria-label={t("passkeys.nameLabel")} maxLength={60} className="sm:max-w-xs" />
          <Button type="submit" variant="primary" loading={adding} icon={<Plus className="size-4" />}>
            {t("passkeys.add")}
          </Button>
        </form>
      ) : (
        <p className="mt-4 text-sm text-warn">{unavailable}</p>
      )}
      <div className="mt-3">
        <ErrorText>{error}</ErrorText>
      </div>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(undefined)}
        title={t("passkeys.remove.title")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          if (!removing) return;
          const next = await api.passkeyRemove(removing.id);
          list.setData(() => next);
          toast(t("passkeys.removed"));
        }}
      >
        {removing && (
          <p>
            {t("passkeys.remove.body", { name: removing.name })}
          </p>
        )}
      </ConfirmDialog>
    </Section>
  );
}

function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return t("passkeys.defaultName");
}

// ---------- password ----------

function ChangePassword() {
  const { logout } = useSession();
  const toast = useToast();
  const [oldP, setOld] = useState("");
  const [newP, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const valid = !!oldP && newP.length >= 8 && newP === confirm && newP !== oldP;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.changePassword(oldP, newP);
      toast(t("password.changed"));
      // The server dropped every session, including this one.
      await logout();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Section title={t("password.title")} icon={<KeyRound className="size-5" />} description={t("password.description")}>
      <form onSubmit={submit} className="max-w-md space-y-4" autoComplete="on">
        <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
        <Field label={t("password.current")} htmlFor="pw-old">
          <PasswordInput id="pw-old" autoComplete="current-password" value={oldP} onChange={(e) => setOld(e.target.value)} />
        </Field>
        <Field label={t("password.new")} htmlFor="pw-new" hint={t("password.minLength")} error={newP && newP === oldP ? t("password.sameAsOld") : undefined}>
          <PasswordInput id="pw-new" autoComplete="new-password" value={newP} onChange={(e) => setNew(e.target.value)} />
        </Field>
        <Field label={t("password.repeat")} htmlFor="pw-confirm" error={confirm && confirm !== newP ? t("password.mismatch") : undefined}>
          <PasswordInput id="pw-confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          {t("password.submit")}
        </Button>
      </form>
    </Section>
  );
}

// ---------- plugins ----------

const PERMS = ["network", "vault", "core", "ui", "fs"] as const;

function Plugins() {
  const list = useAsync<PluginInfo[]>(() => api.plugins(), []);
  // Vault metadata is readable even while sealed: used to suggest ids and flag unknown ones.
  const vault = useAsync(() => api.vault(), []);
  const vaultIds = useMemo(() => (vault.data?.items ?? []).map((i) => i.id), [vault.data]);
  return (
    <Section title={t("plugins.title")} icon={<Puzzle className="size-5" />} description={t("plugins.description")}>
      {!list.data ? (
        list.error ? <ErrorText>{list.error}</ErrorText> : <Spinner />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted">{t("plugins.empty")}</p>
      ) : (
        <div className="space-y-3">
          {list.data.map((p) => (
            <PluginCard
              key={p.id}
              p={p}
              vaultIds={vaultIds}
              onSaved={(extraVault) => list.setData((l) => l?.map((x) => (x.id === p.id ? { ...x, extraVault } : x)))}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

const stripRef = (s: string) => s.replace(/^vault:\/\//, "");

function PermChips({ values, known }: { values: string[]; known?: string[] }) {
  if (values.length === 0) return <span className="text-xs text-faint">{t("common.none")}</span>;
  return (
    <>
      {values.map((v) => {
        const wildcard = v === "*" || v.endsWith(":*");
        const missing = known && known.length > 0 && !wildcard && !known.includes(v);
        return (
          <span
            key={v}
            title={missing ? t("plugins.notInVault") : undefined}
            className={cx("rounded bg-inset px-1.5 py-0.5 font-mono text-xs ring-1 ring-line", v === "*" ? "text-danger" : missing ? "text-warn" : "text-fg")}
          >
            {v === "*" ? t("plugins.wildcardAll") : v}
            {missing && t("plugins.notInVaultSuffix")}
          </span>
        );
      })}
    </>
  );
}

function PluginCard({ p, vaultIds, onSaved }: { p: PluginInfo; vaultIds: string[]; onSaved: (extraVault: string[]) => void }) {
  const toast = useToast();
  const extra = p.extraVault ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(extra);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const supported = p.extraVault !== undefined;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.pluginVault(p.id, draft.map(stripRef));
      onSaved(r.extraVault);
      setEditing(false);
      toast(r.extraVault.length ? t("plugins.vaultUpdated", { id: p.id }) : t("plugins.vaultRevoked", { id: p.id }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx("rounded-lg border border-line p-3", !p.enabled && "opacity-80")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{p.name}</span>
        <span className="font-mono text-xs text-muted">{p.id}</span>
        <Badge tone={p.enabled ? "ok" : "neutral"}>{p.enabled ? t("plugins.enabled") : t("plugins.disabled")}</Badge>
        {p.hasUi && <Badge tone="brand">{t("plugins.hasUi")}</Badge>}
        <span className="ml-auto truncate text-xs text-faint" title={p.source}>
          {p.source}
        </span>
      </div>
      <dl className="mt-2.5 grid gap-x-4 gap-y-2 sm:grid-cols-[7rem_1fr]">
        {PERMS.map((perm) => (
          <div key={perm} className="contents">
            <dt className="text-xs text-muted" title={t(`perm.${perm}.hint` as MessageKey)}>
              {t(`perm.${perm}` as MessageKey)}
            </dt>
            <dd className="-mt-1.5 flex flex-wrap gap-1 sm:mt-0">
              <PermChips values={p.permissions?.[perm] ?? []} />
            </dd>
          </div>
        ))}
        {supported && (
          <div className="contents">
            <dt className="text-xs text-muted" title={t("plugins.extraVault.hint")}>
              {t("plugins.extraVault.label")}
            </dt>
            <dd className="-mt-1.5 flex flex-wrap items-center gap-1 sm:mt-0">
              {!editing && (
                <>
                  <PermChips values={extra} known={vaultIds} />
                  <button
                    type="button"
                    className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-brand-fg hover:underline"
                    aria-label={t("plugins.extraVault.editLabel", { id: p.id })}
                    onClick={() => {
                      setDraft(extra);
                      setError(undefined);
                      setEditing(true);
                    }}
                  >
                    <Pencil className="size-3" /> {t("plugins.extraVault.edit")}
                  </button>
                </>
              )}
            </dd>
          </div>
        )}
      </dl>

      {editing && (
        <div className="mt-3 space-y-3 rounded-lg border border-brand-line bg-brand-soft/40 p-3">
          <div>
            <div className="text-sm font-medium text-fg">{t("plugins.extraVault.title")}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {t("plugins.extraVault.body", { id: p.id })}
            </p>
          </div>
          <ChipsInput value={draft} onChange={setDraft} placeholder={t("plugins.extraVault.placeholder")} suggestions={vaultIds} />
          {draft.some((d) => stripRef(d) === "*") && (
            <Callout tone="danger" title={t("plugins.extraVault.wildcard.title")}>
              {t("plugins.extraVault.wildcard.body")}
            </Callout>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- this device ----------

function DevicePrefs() {
  const prefs = usePrefs();
  const perm = notificationPermission();
  return (
    <Section title={t("device.title")} description={t("device.description")}>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-sm font-medium text-fg">{t("device.theme")}</div>
          <div className="max-w-56">
            <ThemeSwitch />
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium text-fg">{t("device.language")}</div>
          <LocaleSwitch className="w-fit" />
          <p className="mt-1 text-xs text-muted">{t("device.language.hint")}</p>
        </div>
        <Switch checked={prefs.sound} onChange={(sound) => setPrefs({ sound })} label={t("device.sound")} description={t("device.sound.hint")} />
        <Switch
          checked={prefs.notify && perm === "granted"}
          disabled={perm !== "granted"}
          onChange={(notify) => setPrefs({ notify })}
          label={t("device.notify")}
          description={
            perm === "unsupported"
              ? t("device.notify.unsupported")
              : perm === "denied"
                ? t("device.notify.denied")
                : perm === "default"
                  ? t("device.notify.default")
                  : t("device.notify.granted")
          }
        />
      </div>
    </Section>
  );
}
