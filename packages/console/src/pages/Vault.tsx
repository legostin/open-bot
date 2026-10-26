import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Puzzle,
  ShieldAlert,
  StickyNote,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import { api, errorText } from "../api.ts";
import type { PluginInfo, VaultItem, VaultItemMeta, VaultItemType, VaultScope, VaultView } from "../types.ts";
import { useAsync, useTools } from "../hooks.ts";
import { useLiveEvents } from "../session.tsx";
import { formatDate } from "../lib/format.ts";
import { buildPayload, DEFAULT_SCOPE, emptyDraft, IDENTITY_SUGGESTIONS, passphraseStrength, slugify, TEMPLATES, TYPE_HINTS, TYPE_LABELS, validateId, type VaultDraft, type VaultTemplate } from "../lib/vault.ts";
import { Badge, Button, Callout, Card, ChipsInput, CopyButton, cx, ErrorText, Field, IconButton, Input, PageHeader, PasswordInput, Segmented, Spinner, Switch, Textarea } from "../ui/kit.tsx";
import { ConfirmDialog, Dialog, useToast } from "../ui/overlay.tsx";
import { LoadError } from "./Approvals.tsx";

const TYPE_ICONS: Record<VaultItemType, ReactNode> = {
  login: <Globe className="size-4.5" />,
  secret: <KeyRound className="size-4.5" />,
  identity: <UserRound className="size-4.5" />,
  note: <StickyNote className="size-4.5" />,
};

const NAME_PLACEHOLDER: Record<VaultItemType, string> = { login: "GitHub", secret: "GitHub token", identity: "Мои данные", note: "Wi-Fi дома" };
const ID_PLACEHOLDER: Record<VaultItemType, string> = { login: "github", secret: "github_token", identity: "me", note: "home_wifi" };

type EditorState = { mode: "create"; draft: VaultDraft; template?: VaultTemplate } | { mode: "edit"; meta: VaultItemMeta };

export function VaultPage() {
  const vault = useAsync(() => api.vault(), []);
  const toast = useToast();
  const [editor, setEditor] = useState<EditorState>();
  const [sealing, setSealing] = useState(false);

  useLiveEvents((e) => {
    if (e.type === "vault.state") void vault.reload();
  });

  const v = vault.data;
  if (!v) return vault.error ? <LoadError error={vault.error} retry={vault.reload} /> : <Centered />;

  const seal = async () => {
    setSealing(true);
    try {
      await api.vaultSeal();
      toast("Vault запечатан");
      await vault.reload();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSealing(false);
    }
  };

  const openTemplate = (t: VaultTemplate) => {
    const existing = v.items.find((i) => i.id === t.id);
    if (existing) setEditor({ mode: "edit", meta: existing });
    else setEditor({ mode: "create", template: t, draft: { ...emptyDraft("secret"), id: t.id, name: t.name } });
  };

  return (
    <div>
      <PageHeader
        title="Vault"
        description={
          <>
            Зашифрованное хранилище паролей, токенов и личных данных. Агенты видят только ссылки <span className="font-mono text-fg">vault://id</span>, а значения подставляет ядро.
          </>
        }
        actions={
          v.state === "unlocked" ? (
            <>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ mode: "create", draft: emptyDraft("secret") })}>
                Добавить запись
              </Button>
              <Button icon={<Lock className="size-4" />} loading={sealing} onClick={() => void seal()} title="Стереть ключ из памяти: секреты станут недоступны до разблокировки">
                Запечатать
              </Button>
            </>
          ) : undefined
        }
      />

      <StateBanner v={v} />

      {v.state === "uninitialized" && <CreateVault onDone={vault.reload} />}
      {v.state === "sealed" && <UnlockVault onDone={vault.reload} autoUnlock={v.autoUnlock} />}

      {v.state === "unlocked" && <Templates items={v.items} onPick={openTemplate} />}

      {v.state !== "uninitialized" && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-fg">
            Записи <span className="font-normal text-muted">· {v.items.length}</span>
          </h2>
          {v.items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
              {v.state === "unlocked" ? "Пока пусто. Добавьте первую запись или воспользуйтесь шаблоном выше." : "Записей нет."}
            </p>
          ) : (
            <div className="space-y-2.5">
              {v.items.map((item) => (
                <ItemRow key={item.id} item={item} unlocked={v.state === "unlocked"} onEdit={() => setEditor({ mode: "edit", meta: item })} onChanged={vault.reload} />
              ))}
            </div>
          )}
        </section>
      )}

      {v.state !== "uninitialized" && <ChangePassphrase onDone={vault.reload} />}

      {editor && (
        <ItemEditor
          key={editor.mode === "edit" ? editor.meta.id : `new-${editor.template?.id ?? ""}`}
          state={editor}
          existingIds={v.items.map((i) => i.id)}
          onClose={() => setEditor(undefined)}
          onSaved={(meta, created) => {
            setEditor(undefined);
            toast(created ? `Запись vault://${meta.id} создана` : `Запись vault://${meta.id} сохранена`);
            void vault.reload();
          }}
        />
      )}
    </div>
  );
}

function Centered() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

function StateBanner({ v }: { v: VaultView }) {
  if (v.state === "unlocked") {
    return (
      <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-ok-line bg-ok-soft px-3.5 py-2.5 text-sm">
        <LockOpen className="size-4 shrink-0 text-ok" />
        <span className="text-fg">
          <span className="font-medium">Vault открыт.</span> <span className="text-muted">Агенты и плагины могут использовать записи в пределах их областей доступа.</span>
        </span>
      </div>
    );
  }
  if (v.state === "sealed") {
    return (
      <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-warn-line bg-warn-soft px-3.5 py-2.5 text-sm">
        <Lock className="size-4 shrink-0 text-warn" />
        <span className="text-fg">
          <span className="font-medium">Vault запечатан.</span> <span className="text-muted">Секреты недоступны никому, пока вы не разблокируете его.</span>
        </span>
      </div>
    );
  }
  return null;
}

// ---------- create / unlock ----------

function CreateVault({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const strength = passphraseStrength(pass);
  const mismatch = confirm.length > 0 && confirm !== pass;
  const valid = pass.length >= 8 && pass === confirm && ack;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.vaultInit(pass);
      setPass("");
      setConfirm("");
      toast("Vault создан и открыт");
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-fg ring-1 ring-brand-line">
          <KeyRound className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-fg">Создайте vault</h2>
          <p className="mt-1 text-sm text-muted">Придумайте пароль vault. Им шифруются все записи; после перезапуска хаба vault нужно будет разблокировать этим паролем.</p>
        </div>
      </div>

      <form onSubmit={submit} className="mt-5 max-w-md space-y-4">
        <Field label="Пароль vault" htmlFor="vp1" hint="Минимум 8 символов. Лучше — фраза из 4–5 случайных слов.">
          <PasswordInput id="vp1" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        {pass && <StrengthMeter score={strength.score} label={strength.label} />}
        <Field label="Повторите пароль" htmlFor="vp2" error={mismatch ? "Пароли не совпадают" : undefined}>
          <PasswordInput id="vp2" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>

        <Callout tone="danger" title="Этот пароль невозможно восстановить">
          Ни open-bot, ни кто-либо другой не сможет расшифровать vault без него. Если вы его забудете, все записи будут потеряны навсегда. Сохраните пароль в менеджере паролей или запишите и уберите в надёжное место.
        </Callout>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-fg">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent-700)]" />
          Я сохранил пароль и понимаю, что восстановить его нельзя
        </label>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          Создать vault
        </Button>
      </form>
    </Card>
  );
}

function StrengthMeter({ score, label }: { score: number; label: string }) {
  const color = score <= 1 ? "bg-red-500" : score === 2 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="-mt-1 flex items-center gap-3">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cx("h-1.5 flex-1 rounded-full", i <= score ? color : "bg-line")} />
        ))}
      </div>
      <span className="w-28 text-right text-xs text-muted">{label}</span>
    </div>
  );
}

function UnlockVault({ onDone, autoUnlock }: { onDone: () => Promise<void>; autoUnlock: boolean }) {
  const toast = useToast();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pass) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.vaultUnlock(pass);
      setPass("");
      toast("Vault разблокирован");
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-warn-soft text-warn ring-1 ring-warn-line">
          <Lock className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-fg">Разблокировать vault</h2>
          <p className="mt-1 text-sm text-muted">Пока vault запечатан, агенты не могут войти на сайты и использовать API-ключи.</p>
          {autoUnlock && <p className="mt-1 text-sm text-warn">Автоматическая разблокировка из файла настроена, но не сработала — проверьте логи хаба.</p>}
        </div>
      </div>
      <form onSubmit={submit} className="mt-5 flex max-w-md flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <PasswordInput aria-label="Пароль vault" placeholder="Пароль vault" autoComplete="current-password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!pass} icon={<LockOpen className="size-4" />}>
          Разблокировать
        </Button>
      </form>
      <div className="mt-3">
        <ErrorText>{error}</ErrorText>
      </div>
    </Card>
  );
}

function ChangePassphrase({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [oldP, setOld] = useState("");
  const [newP, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const strength = passphraseStrength(newP);
  const valid = oldP && newP.length >= 8 && newP === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.vaultPassphrase(oldP, newP);
      setOld("");
      setNew("");
      setConfirm("");
      setOpen(false);
      toast("Пароль vault изменён");
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <button type="button" className="flex items-center gap-1.5 text-sm font-medium text-muted hover:text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={cx("size-4 transition-transform", open && "rotate-180")} />
        Сменить пароль vault
      </button>
      {open && (
        <Card className="mt-3 p-5">
          <form onSubmit={submit} className="max-w-md space-y-4">
            <Field label="Текущий пароль vault" htmlFor="cp-old">
              <PasswordInput id="cp-old" autoComplete="current-password" value={oldP} onChange={(e) => setOld(e.target.value)} />
            </Field>
            <Field label="Новый пароль vault" htmlFor="cp-new" hint="Минимум 8 символов">
              <PasswordInput id="cp-new" autoComplete="new-password" value={newP} onChange={(e) => setNew(e.target.value)} />
            </Field>
            {newP && <StrengthMeter score={strength.score} label={strength.label} />}
            <Field label="Повторите новый пароль" htmlFor="cp-confirm" error={confirm && confirm !== newP ? "Пароли не совпадают" : undefined}>
              <PasswordInput id="cp-confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <p className="text-xs text-muted">Записи не перешифровываются — меняется только ключ, которым защищён ключ данных. Новый пароль тоже нельзя будет восстановить.</p>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
              Сменить пароль
            </Button>
          </form>
        </Card>
      )}
    </section>
  );
}

// ---------- templates ----------

function Templates({ items, onPick }: { items: VaultItemMeta[]; onPick: (t: VaultTemplate) => void }) {
  // Expanded for a fresh vault; once there are items it mostly gets in the way (especially on a phone).
  const [open, setOpen] = useState(items.length === 0);
  return (
    <section className="mt-2">
      <button type="button" className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown className={cx("size-4 text-muted transition-transform", !open && "-rotate-90")} />
        Быстрое добавление
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((t) => {
            const exists = items.some((i) => i.id === t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t)}
                className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand-line hover:bg-brand-soft/40"
              >
                <span className={cx("inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1", exists ? "bg-ok-soft text-ok ring-ok-line" : "bg-inset text-muted ring-line group-hover:text-brand-fg")}>
                  {exists ? <KeyRound className="size-4" /> : <Plus className="size-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{t.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{exists ? `${t.id} · уже есть` : t.id}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------- item row + reveal ----------

const REVEAL_SECONDS = 30;

const FIELD_LABELS: Record<string, string> = {
  url: "URL",
  username: "Имя пользователя",
  password: "Пароль",
  totp: "TOTP-секрет",
  value: "Значение",
  text: "Текст",
};

function ItemRow({ item, unlocked, onEdit, onChanged }: { item: VaultItemMeta; unlocked: boolean; onEdit: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [revealed, setRevealed] = useState<VaultItem>();
  const [left, setLeft] = useState(0);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  const hide = () => {
    clearInterval(timer.current);
    setRevealed(undefined);
    setLeft(0);
  };
  useEffect(() => () => clearInterval(timer.current), []);
  // Hide when the vault is sealed underneath us or the item was just changed.
  useEffect(() => {
    hide();
  }, [unlocked, item.updatedAt]);

  const reveal = async () => {
    if (revealed) return hide();
    setLoading(true);
    try {
      const full = await api.vaultItem(item.id);
      setRevealed(full);
      setLeft(REVEAL_SECONDS);
      clearInterval(timer.current);
      const until = Date.now() + REVEAL_SECONDS * 1000;
      timer.current = setInterval(() => {
        const s = Math.ceil((until - Date.now()) / 1000);
        if (s <= 0) hide();
        else setLeft(s);
      }, 250);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setLoading(false);
    }
  };

  const s = item.scope;
  const hints = Object.entries(item.hints ?? {});
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:p-4">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-inset text-muted ring-1 ring-line">{TYPE_ICONS[item.type]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-medium text-fg">{item.name}</span>
              <Badge>{TYPE_LABELS[item.type]}</Badge>
              {s.revealToModel && (
                <Badge tone="warn" title="Модель может прочитать значение">
                  <Eye className="size-3" /> видно модели
                </Badge>
              )}
              {s.mode === "ask" && <Badge tone="brand">спрашивать</Badge>}
            </div>
            <div className="mt-1 flex items-center gap-1">
              <span className="truncate font-mono text-[13px] text-brand-fg">vault://{item.id}</span>
              <CopyButton text={`vault://${item.id}`} label="Копировать ссылку" className="size-7" />
            </div>
            {hints.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                {hints.map(([k, v]) => (
                  <span key={k} className="min-w-0 truncate">
                    {FIELD_LABELS[k] ?? k}: <span className="font-mono text-fg">{v}</span>
                  </span>
                ))}
              </div>
            )}
            <ScopeSummary scope={s} />
          </div>
        </div>
        {unlocked && (
          <div className="flex shrink-0 items-center gap-1.5 sm:pt-0.5">
            <Button size="sm" variant={revealed ? "secondary" : "ghost"} loading={loading} icon={revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => void reveal()} className="border-line">
              {revealed ? "Скрыть" : "Показать"}
            </Button>
            <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={onEdit}>
              Изменить
            </Button>
            <IconButton label="Удалить запись" onClick={() => setConfirmDelete(true)} className="hover:text-danger">
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        )}
      </div>

      {revealed && (
        <div className="border-t border-line bg-inset/70 px-3.5 py-3 sm:px-4">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert className="size-3.5 text-warn" /> Просмотр записан в аудит
            </span>
            <span className="tabular-nums">скроется через {left} с</span>
          </div>
          <div className="space-y-2">
            {Object.entries(revealed.fields).map(([k, val]) => (
              <div key={k} className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted">{FIELD_LABELS[k] ?? k}</div>
                  <div className="mt-0.5 font-mono text-sm break-all whitespace-pre-wrap text-fg">{val || <span className="text-faint italic">пусто</span>}</div>
                </div>
                {val && <CopyButton text={val} />}
              </div>
            ))}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-accent-500 transition-[width] duration-300 ease-linear" style={{ width: `${(left / REVEAL_SECONDS) * 100}%` }} />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Удалить запись?"
        confirmLabel="Удалить навсегда"
        onConfirm={async () => {
          await api.vaultRemove(item.id);
          toast(`Запись vault://${item.id} удалена`);
          await onChanged();
        }}
      >
        <p>
          Запись <span className="font-medium text-fg">«{item.name}»</span> (<span className="font-mono text-fg">vault://{item.id}</span>) будет удалена без возможности восстановления.
        </p>
        <p>Агенты, плагины и настройки, которые ссылаются на неё, перестанут работать.</p>
      </ConfirmDialog>
    </Card>
  );
}

function ScopeSummary({ scope }: { scope: VaultScope }) {
  const parts: Array<{ icon: ReactNode; label: string; values: string[] }> = [
    { icon: <Globe className="size-3" />, label: "домены", values: scope.domains },
    { icon: <Puzzle className="size-3" />, label: "плагины", values: scope.plugins },
    { icon: <Bot className="size-3" />, label: "агенты", values: scope.agents },
    { icon: <Wrench className="size-3" />, label: "инструменты", values: scope.tools },
  ].filter((p) => p.values.length > 0);
  if (!parts.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {parts.map((p) => (
        <span key={p.label} className="inline-flex max-w-full items-center gap-1 rounded-md bg-inset px-1.5 py-0.5 text-xs text-muted ring-1 ring-line" title={`${p.label}: ${p.values.join(", ")}`}>
          {p.icon}
          <span className="truncate">
            {p.label}: <span className="font-mono text-fg">{p.values.join(", ")}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------- editor ----------

function draftFromMeta(meta: VaultItemMeta): VaultDraft {
  const d = emptyDraft(meta.type);
  return {
    ...d,
    name: meta.name,
    id: meta.id,
    url: meta.hints?.url ?? "",
    username: meta.hints?.username ?? "",
    identity: [],
    scope: { ...DEFAULT_SCOPE, ...meta.scope },
  };
}

function ItemEditor({ state, existingIds, onClose, onSaved }: { state: EditorState; existingIds: string[]; onClose: () => void; onSaved: (meta: VaultItemMeta, created: boolean) => void }) {
  const editing = state.mode === "edit";
  const template = state.mode === "create" ? state.template : TEMPLATES.find((t) => t.id === state.meta.id);
  const [draft, setDraft] = useState<VaultDraft>(() => (state.mode === "edit" ? draftFromMeta(state.meta) : state.draft));
  const [loaded, setLoaded] = useState(false);
  const [loadingValues, setLoadingValues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [scopeOpen, setScopeOpen] = useState(false);
  const set = (patch: Partial<VaultDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const loadValues = async () => {
    if (state.mode !== "edit") return;
    setLoadingValues(true);
    setError(undefined);
    try {
      const full = await api.vaultItem(state.meta.id);
      const f = full.fields;
      setDraft((d) => ({
        ...d,
        url: f.url ?? d.url,
        username: f.username ?? d.username,
        password: f.password ?? "",
        totp: f.totp ?? "",
        value: f.value ?? "",
        text: f.text ?? "",
        identity: Object.entries(f).map(([key, value]) => ({ key, value })),
      }));
      setLoaded(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingValues(false);
    }
  };

  // Identity fields are user-defined keys: editing them requires the current set.
  useEffect(() => {
    if (state.mode === "edit" && state.meta.type === "identity") void loadValues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const r = buildPayload(draft, { editing, existingIds });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const meta = await api.vaultUpsert(r.payload);
      onSaved(meta, !editing);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const keepHint = editing && !loaded ? "Пусто — оставить текущее значение" : undefined;
  const idError = !editing ? validateId(draft.id.trim()) : undefined;
  const effectiveId = draft.id.trim() || slugify(draft.name);
  const idTaken = !editing && !!effectiveId && existingIds.includes(effectiveId);
  const identityBlocked = editing && draft.type === "identity" && !loaded;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Изменить «${state.meta.name}»` : template ? template.name : "Новая запись"}
      description={editing ? <span className="font-mono">vault://{state.meta.id}</span> : TYPE_HINTS[draft.type]}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={identityBlocked}>
            {editing ? "Сохранить" : "Добавить в vault"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {template && (
          <Callout tone="brand" title="Где взять">
            {template.hint}
          </Callout>
        )}

        {!editing && !template && (
          <Field label="Тип">
            <div role="radiogroup" aria-label="Тип записи" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(Object.keys(TYPE_LABELS) as VaultItemType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={draft.type === t}
                  onClick={() => setDraft((d) => ({ ...d, type: t, scope: { ...d.scope, plugins: t === "login" && d.scope.plugins.length === 0 ? ["browser"] : d.scope.plugins } }))}
                  className={cx(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors",
                    draft.type === t ? "border-accent-600 bg-brand-soft text-brand-fg ring-1 ring-accent-600" : "border-line-strong bg-surface text-muted hover:text-fg",
                  )}
                >
                  {TYPE_ICONS[t]}
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Название" htmlFor="vi-name">
            <Input id="vi-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={NAME_PLACEHOLDER[draft.type]} autoFocus={!editing && !template} />
          </Field>
          <Field
            label="Id"
            htmlFor="vi-id"
            error={idError ?? (idTaken ? "Такой id уже есть" : undefined)}
            hint={
              editing ? (
                "Id нельзя изменить: на него ссылаются агенты и настройки"
              ) : (
                <>
                  Агенты ссылаются на запись как <span className="font-mono text-fg">vault://{effectiveId || "…"}</span>
                  {!draft.id.trim() && (effectiveId ? " (из названия)" : " — будет сгенерирован")}
                </>
              )
            }
          >
            <Input id="vi-id" mono value={draft.id} disabled={editing || !!template} onChange={(e) => set({ id: e.target.value.toLowerCase() })} placeholder={slugify(draft.name) || ID_PLACEHOLDER[draft.type]} autoCapitalize="off" spellCheck={false} />
          </Field>
        </div>

        {editing && draft.type !== "identity" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-inset px-3 py-2 text-xs text-muted">
            <span>{loaded ? "Текущие значения загружены (записано в аудит)." : "Секретные поля пустые: заполните только те, что хотите заменить."}</span>
            {!loaded && (
              <Button size="sm" loading={loadingValues} icon={<Download className="size-3.5" />} onClick={() => void loadValues()}>
                Загрузить текущие значения
              </Button>
            )}
          </div>
        )}

        <TypeFields draft={draft} set={set} keepHint={keepHint} template={template} loadingIdentity={editing && draft.type === "identity" && loadingValues} />

        <div className="rounded-xl border border-line">
          <button type="button" className="flex w-full items-center gap-2 px-3.5 py-3 text-left" onClick={() => setScopeOpen((o) => !o)} aria-expanded={scopeOpen}>
            <ChevronDown className={cx("size-4 text-muted transition-transform", !scopeOpen && "-rotate-90")} />
            <span className="text-sm font-medium text-fg">Область доступа</span>
            <span className="ml-auto truncate text-xs text-muted">{scopeLine(draft.scope)}</span>
          </button>
          {scopeOpen && (
            <div className="border-t border-line p-3.5">
              <ScopeEditor scope={draft.scope} type={draft.type} onChange={(scope) => set({ scope })} />
            </div>
          )}
        </div>

        {draft.scope.revealToModel && !scopeOpen && (
          <Callout tone="warn" title="Значение будет видно модели">
            Откройте «Область доступа», чтобы изменить.
          </Callout>
        )}
        <ErrorText>{error}</ErrorText>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function scopeLine(s: VaultScope): string {
  const parts: string[] = [];
  if (s.domains.length) parts.push(`домены: ${s.domains.length}`);
  if (s.plugins.length) parts.push(`плагины: ${s.plugins.join(", ")}`);
  if (s.agents.length) parts.push(`агенты: ${s.agents.length}`);
  if (s.tools.length) parts.push(`инструменты: ${s.tools.length}`);
  parts.push(s.mode === "ask" ? "спрашивать" : "авто");
  if (s.revealToModel) parts.push("видно модели");
  return parts.join(" · ");
}

function TypeFields({ draft, set, keepHint, template, loadingIdentity }: { draft: VaultDraft; set: (p: Partial<VaultDraft>) => void; keepHint?: string; template?: VaultTemplate; loadingIdentity: boolean }) {
  switch (draft.type) {
    case "login":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="URL сайта" htmlFor="vf-url" hint="Логин подставляется только на этом домене (или доменах из области доступа)" className="sm:col-span-2">
            <Input id="vf-url" mono type="url" inputMode="url" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://github.com/login" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="Имя пользователя" htmlFor="vf-user">
            <Input id="vf-user" mono value={draft.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="Пароль" htmlFor="vf-pass" hint={keepHint}>
            <PasswordInput id="vf-pass" value={draft.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={keepHint ? "без изменений" : ""} />
          </Field>
          <Field label="TOTP-секрет (2FA)" htmlFor="vf-totp" hint={keepHint ?? "Необязательно: base32-секрет из QR-кода двухфакторной аутентификации"} className="sm:col-span-2">
            <PasswordInput id="vf-totp" value={draft.totp} onChange={(e) => set({ totp: e.target.value })} autoComplete="off" placeholder={keepHint ? "без изменений" : "JBSWY3DPEHPK3PXP"} />
          </Field>
        </div>
      );
    case "secret":
      return (
        <Field label="Значение" htmlFor="vf-value" hint={keepHint ?? "Ключ или токен целиком"}>
          <PasswordInput id="vf-value" value={draft.value} onChange={(e) => set({ value: e.target.value })} autoComplete="off" placeholder={keepHint ? "без изменений" : template?.placeholder} autoFocus={!!template && !keepHint} />
        </Field>
      );
    case "note":
      return (
        <Field label="Текст" htmlFor="vf-text" hint={keepHint}>
          <Textarea id="vf-text" rows={6} value={draft.text} onChange={(e) => set({ text: e.target.value })} placeholder={keepHint ? "Без изменений" : ""} />
        </Field>
      );
    case "identity":
      if (loadingIdentity) {
        return (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        );
      }
      return <IdentityRows draft={draft} set={set} />;
  }
}

function IdentityRows({ draft, set }: { draft: VaultDraft; set: (p: Partial<VaultDraft>) => void }) {
  const rows = draft.identity;
  const update = (i: number, patch: Partial<{ key: string; value: string }>) => set({ identity: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const used = new Set(rows.map((r) => r.key));
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-fg">Поля</div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
            <Input mono aria-label="Название поля" value={r.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="email" autoCapitalize="off" spellCheck={false} />
            <IconButton label="Удалить поле" className="size-10 sm:order-last" onClick={() => set({ identity: rows.filter((_, j) => j !== i) })}>
              <Trash2 className="size-4" />
            </IconButton>
            <Input aria-label="Значение" value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="значение" className="col-span-2 sm:col-span-1" />
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => set({ identity: [...rows, { key: "", value: "" }] })}>
          Поле
        </Button>
        {IDENTITY_SUGGESTIONS.filter((s) => !used.has(s.key)).map((s) => (
          <button
            key={s.key}
            type="button"
            className="rounded-md border border-dashed border-line-strong px-2 py-1 text-xs text-muted hover:border-brand-line hover:text-brand-fg"
            onClick={() => {
              const empty = rows.findIndex((r) => !r.key && !r.value);
              if (empty >= 0) update(empty, { key: s.key });
              else set({ identity: [...rows, { key: s.key, value: "" }] });
            }}
          >
            + {s.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Пустое значение при редактировании — оставить текущее.</p>
    </div>
  );
}

function ScopeEditor({ scope, type, onChange }: { scope: VaultScope; type: VaultItemType; onChange: (s: VaultScope) => void }) {
  const tools = useTools();
  const plugins = useAsync<PluginInfo[]>(() => api.plugins(), []);
  const pluginIds = useMemo(() => (plugins.data ?? []).map((p) => p.id), [plugins.data]);
  const toolNames = useMemo(() => tools.map((t) => t.name), [tools]);
  const set = (patch: Partial<VaultScope>) => onChange({ ...scope, ...patch });
  return (
    <div className="space-y-4">
      {type === "login" && (
        <Field label="Домены" hint="Где можно подставлять логин. Пусто — только домен из URL записи. *.example.com — с поддоменами.">
          <ChipsInput value={scope.domains} onChange={(domains) => set({ domains })} placeholder="github.com" />
        </Field>
      )}
      <Field
        label="Плагины"
        hint={type === "login" ? "Каким плагинам можно получить запись. Для логинов пусто — никаким." : "Каким плагинам можно получить запись (плагин также должен объявить её в правах). Пусто — любым с таким правом."}
      >
        <ChipsInput value={scope.plugins} onChange={(p) => set({ plugins: p })} placeholder="browser" suggestions={pluginIds} />
      </Field>
      <Field label="Агенты" hint="id агентов. Пусто — все агенты.">
        <ChipsInput value={scope.agents} onChange={(agents) => set({ agents })} placeholder="assistant" />
      </Field>
      <Field label="Инструменты" hint="Точные имена инструментов, которым можно передавать ссылку. Пусто — любые.">
        <ChipsInput value={scope.tools} onChange={(t) => set({ tools: t })} placeholder="mail_send" suggestions={toolNames} />
      </Field>
      <Field label="Режим" hint={scope.mode === "ask" ? "Каждое использование записи требует вашего подтверждения." : "Подставлять без вопросов в пределах области."}>
        <Segmented
          value={scope.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "auto", label: "Автоматически" },
            { value: "ask", label: "Спрашивать" },
          ]}
        />
      </Field>
      <div className="rounded-lg border border-line p-3">
        <Switch
          checked={scope.revealToModel}
          onChange={(revealToModel) => set({ revealToModel })}
          label="Разрешить модели читать значение"
          description="По умолчанию модель видит только ссылку vault://id, а значения вырезаются из всех ответов."
        />
        {scope.revealToModel && (
          <Callout tone="danger" className="mt-3" title="Значение попадёт в контекст модели">
            Его увидит провайдер LLM, оно может оказаться в транскриптах и ответах и больше не будет вырезаться. Включайте только для неопасных данных (например, адрес доставки), никогда — для паролей и ключей.
          </Callout>
        )}
      </div>
    </div>
  );
}

