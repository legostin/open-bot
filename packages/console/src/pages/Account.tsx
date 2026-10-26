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
import { notificationPermission } from "../alerts.ts";

export function AccountPage() {
  const { logout } = useSession();
  return (
    <div>
      <PageHeader
        title="Аккаунт"
        description="Способы входа, пароль и права установленных плагинов."
        actions={
          <Button icon={<LogOut className="size-4" />} onClick={() => void logout()}>
            Выйти из пульта
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
      toast("Passkey добавлен");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Section title="Passkey" icon={<Fingerprint className="size-5" />} description="Вход без пароля: отпечаток, лицо, PIN устройства или аппаратный ключ. Работает и для пульта, и для основного приложения.">
      {!list.data ? (
        list.error ? <ErrorText>{list.error}</ErrorText> : <Spinner />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted">Passkey ещё не добавлены.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <KeyRound className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                <div className="text-xs text-muted">добавлен {formatDate(p.createdAt)}</div>
              </div>
              <IconButton label={`Удалить passkey ${p.name}`} onClick={() => setRemoving(p)} className="hover:text-danger">
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {!unavailable ? (
        <form onSubmit={add} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Название, напр. «${defaultPasskeyName()}»`} aria-label="Название passkey" maxLength={60} className="sm:max-w-xs" />
          <Button type="submit" variant="primary" loading={adding} icon={<Plus className="size-4" />}>
            Добавить passkey
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
        title="Удалить passkey?"
        confirmLabel="Удалить"
        onConfirm={async () => {
          if (!removing) return;
          const next = await api.passkeyRemove(removing.id);
          list.setData(() => next);
          toast("Passkey удалён");
        }}
      >
        {removing && (
          <p>
            Войти с passkey <span className="font-medium text-fg">«{removing.name}»</span> больше не получится. Удалите его и из менеджера паролей устройства.
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
  return "Мой ключ";
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
      toast("Пароль изменён. Все сессии завершены — войдите с новым паролем.");
      // The server dropped every session, including this one.
      await logout();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Section title="Пароль" icon={<KeyRound className="size-5" />} description="Один пароль для основного приложения и пульта. После смены все открытые сессии завершатся.">
      <form onSubmit={submit} className="max-w-md space-y-4" autoComplete="on">
        <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
        <Field label="Текущий пароль" htmlFor="pw-old">
          <PasswordInput id="pw-old" autoComplete="current-password" value={oldP} onChange={(e) => setOld(e.target.value)} />
        </Field>
        <Field label="Новый пароль" htmlFor="pw-new" hint="Минимум 8 символов" error={newP && newP === oldP ? "Новый пароль совпадает с текущим" : undefined}>
          <PasswordInput id="pw-new" autoComplete="new-password" value={newP} onChange={(e) => setNew(e.target.value)} />
        </Field>
        <Field label="Повторите новый пароль" htmlFor="pw-confirm" error={confirm && confirm !== newP ? "Пароли не совпадают" : undefined}>
          <PasswordInput id="pw-confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          Сменить пароль
        </Button>
      </form>
    </Section>
  );
}

// ---------- plugins ----------

const PERM_LABELS: Array<{ key: "network" | "vault" | "core" | "ui" | "fs"; label: string; hint: string }> = [
  { key: "network", label: "Сеть", hint: "куда плагин может ходить в интернет" },
  { key: "vault", label: "Vault", hint: "какие записи может получить" },
  { key: "core", label: "Ядро", hint: "методы API ядра" },
  { key: "ui", label: "Интерфейс", hint: "возможности в основном приложении" },
  { key: "fs", label: "Файлы", hint: "дополнительные пути" },
];

function Plugins() {
  const list = useAsync<PluginInfo[]>(() => api.plugins(), []);
  // Vault metadata is readable even while sealed: used to suggest ids and flag unknown ones.
  const vault = useAsync(() => api.vault(), []);
  const vaultIds = useMemo(() => (vault.data?.items ?? []).map((i) => i.id), [vault.data]);
  return (
    <Section title="Плагины и их права" icon={<Puzzle className="size-5" />} description="Что разрешено каждому установленному плагину. Права из манифеста выдаются при установке в основном приложении.">
      {!list.data ? (
        list.error ? <ErrorText>{list.error}</ErrorText> : <Spinner />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted">Плагины не установлены.</p>
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
  if (values.length === 0) return <span className="text-xs text-faint">нет</span>;
  return (
    <>
      {values.map((v) => {
        const wildcard = v === "*" || v.endsWith(":*");
        const missing = known && known.length > 0 && !wildcard && !known.includes(v);
        return (
          <span
            key={v}
            title={missing ? "Такой записи в vault пока нет" : undefined}
            className={cx("rounded bg-inset px-1.5 py-0.5 font-mono text-xs ring-1 ring-line", v === "*" ? "text-danger" : missing ? "text-warn" : "text-fg")}
          >
            {v === "*" ? "* (всё)" : v}
            {missing && " · нет в vault"}
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
      toast(r.extraVault.length ? `Доступ плагина ${p.id} к хранилищу обновлён` : `Дополнительный доступ плагина ${p.id} отозван`);
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
        <Badge tone={p.enabled ? "ok" : "neutral"}>{p.enabled ? "включён" : "выключен"}</Badge>
        {p.hasUi && <Badge tone="brand">есть интерфейс</Badge>}
        <span className="ml-auto truncate text-xs text-faint" title={p.source}>
          {p.source}
        </span>
      </div>
      <dl className="mt-2.5 grid gap-x-4 gap-y-2 sm:grid-cols-[7rem_1fr]">
        {PERM_LABELS.map((perm) => (
          <div key={perm.key} className="contents">
            <dt className="text-xs text-muted" title={perm.hint}>
              {perm.label}
            </dt>
            <dd className="-mt-1.5 flex flex-wrap gap-1 sm:mt-0">
              <PermChips values={p.permissions?.[perm.key] ?? []} />
            </dd>
          </div>
        ))}
        {supported && (
          <div className="contents">
            <dt className="text-xs text-muted" title="Записи vault, выданные вами сверх манифеста">
              Доп. vault
            </dt>
            <dd className="-mt-1.5 flex flex-wrap items-center gap-1 sm:mt-0">
              {!editing && (
                <>
                  <PermChips values={extra} known={vaultIds} />
                  <button
                    type="button"
                    className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-brand-fg hover:underline"
                    aria-label={`Изменить дополнительный доступ плагина ${p.id} к хранилищу`}
                    onClick={() => {
                      setDraft(extra);
                      setError(undefined);
                      setEditing(true);
                    }}
                  >
                    <Pencil className="size-3" /> изменить
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
            <div className="text-sm font-medium text-fg">Дополнительный доступ к хранилищу</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              Записи vault, которые плагин <span className="font-mono text-fg">{p.id}</span> может получить сверх своего манифеста — например, ключ, на который указывает его настройка (customKeyRef,
              tokenRef). Область доступа самой записи по-прежнему действует.
            </p>
          </div>
          <ChipsInput value={draft} onChange={setDraft} placeholder="id записи, напр. openai_api_key" suggestions={vaultIds} />
          {draft.some((d) => stripRef(d) === "*") && (
            <Callout tone="danger" title="«*» откроет плагину весь vault">
              Плагин сможет запросить любую запись (в пределах её области). Выдавайте конкретные id.
            </Callout>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
              Сохранить
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Отмена
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
    <Section title="Это устройство" description="Настройки хранятся только в этом браузере.">
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-sm font-medium text-fg">Тема</div>
          <div className="max-w-56">
            <ThemeSwitch />
          </div>
        </div>
        <Switch checked={prefs.sound} onChange={(sound) => setPrefs({ sound })} label="Звук при новом запросе" description="Короткий сигнал, когда агент просит подтверждение." />
        <Switch
          checked={prefs.notify && perm === "granted"}
          disabled={perm !== "granted"}
          onChange={(notify) => setPrefs({ notify })}
          label="Системные уведомления"
          description={
            perm === "unsupported"
              ? "Недоступны на этом адресе (нужен HTTPS или localhost)."
              : perm === "denied"
                ? "Заблокированы в настройках браузера для этого сайта."
                : perm === "default"
                  ? "Включите кнопкой «Включить уведомления» на странице подтверждений."
                  : "Без подробностей запроса — они могут показываться на экране блокировки."
          }
        />
      </div>
    </Section>
  );
}
