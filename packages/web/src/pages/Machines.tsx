// Machines: connected openbot-node daemons, pairing, rename, revoke.

import { useCallback, useEffect, useState } from "react";
import { Check, Laptop, Link2, Pencil, Trash2, X } from "lucide-react";
import type { Machine } from "@openbot/shared";
import { api, errorText } from "../lib/api";
import { relativeTime } from "../lib/format";
import { hubEvents } from "../state/app";
import { toast } from "../state/toast";
import { Badge, Button, CodeLine, EmptyState, ErrorNote, Field, IconButton, Input, Loading, Modal, Page } from "../components/ui";

interface Pairing {
  code: string;
  expiresAt: string;
  hubUrl: string;
}

export function MachinesPage() {
  const [list, setList] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string>();
  const [pairOpen, setPairOpen] = useState(false);
  const [revoking, setRevoking] = useState<Machine | null>(null);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setList(await api.get<Machine[]>("/api/machines"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return hubEvents.on((e) => {
      if (e.type === "machine.updated") void load();
    });
  }, [load]);

  return (
    <Page
      title="Машины"
      subtitle="Ваши компьютеры, на которых агенты могут запускать Claude Code и Codex и работать с файлами."
      actions={
        <Button variant="primary" icon={<Link2 className="size-4" />} onClick={() => setPairOpen(true)}>
          Подключить машину
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && (
        <EmptyState icon="laptop" title="Машин пока нет" hint="Подключите ноутбук или рабочий компьютер — агенты смогут работать с кодом там, где он лежит." />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {list?.map((m) => (
          <MachineCard key={m.id} m={m} onChanged={load} onRevoke={() => setRevoking(m)} />
        ))}
      </div>

      {pairOpen && <PairModal onClose={() => setPairOpen(false)} />}
      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Отключить «${revoking?.name}»?`}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Отмена</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const m = revoking!;
                setRevoking(null);
                try {
                  await api.del(`/api/machines/${encodeURIComponent(m.id)}`);
                  toast("Машина отключена", "success");
                  await load();
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              Отключить
            </Button>
          </>
        }
      >
        <p className="text-sm">Ключ машины будет отозван — демон больше не сможет подключиться. Чтобы вернуть машину, привяжите её заново.</p>
      </Modal>
    </Page>
  );
}

function MachineCard({ m, onChanged, onRevoke }: { m: Machine; onChanged: () => Promise<void>; onRevoke: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(m.name);
  const online = m.status === "online";
  const save = async () => {
    setEditing(false);
    if (!name.trim() || name.trim() === m.name) return setName(m.name);
    try {
      await api.patch(`/api/machines/${encodeURIComponent(m.id)}`, { name: name.trim() });
      await onChanged();
    } catch (e) {
      toast(errorText(e), "error");
      setName(m.name);
    }
  };
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Laptop className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-8" maxLength={60} />
              <IconButton label="Сохранить" onClick={() => void save()} className="size-8 shrink-0">
                <Check className="size-4" />
              </IconButton>
              <IconButton
                label="Отмена"
                onClick={() => {
                  setEditing(false);
                  setName(m.name);
                }}
                className="size-8 shrink-0"
              >
                <X className="size-4" />
              </IconButton>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{m.name}</span>
              <Badge tone={online ? "success" : "neutral"} dot>
                {online ? "онлайн" : "офлайн"}
              </Badge>
              <IconButton label="Переименовать" onClick={() => setEditing(true)} className="size-7">
                <Pencil className="size-3.5" />
              </IconButton>
            </div>
          )}
          <div className="mt-0.5 text-xs text-muted">
            {m.info ? `${m.info.os} · ${m.info.arch} · ${m.info.hostname}` : "нет данных о системе"}
            {m.info?.nodeVersion && ` · node ${m.info.nodeVersion}`}
          </div>
          <div className="text-xs text-muted">{online ? "на связи" : m.lastSeenAt ? `был ${relativeTime(m.lastSeenAt)}` : "ещё не подключался"}</div>
        </div>
      </div>
      {m.info?.clis && m.info.clis.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {m.info.clis.map((c) => (
            <Badge key={c.brainId} tone={c.authenticated ? "success" : c.available ? "warning" : "neutral"}>
              {c.brainId}
              {c.version ? ` ${c.version}` : ""}
              {!c.available ? " — нет" : !c.authenticated ? " — нужен вход" : ""}
            </Badge>
          ))}
        </div>
      )}
      {m.info?.allowedDirs && m.info.allowedDirs.length > 0 && (
        <div className="mt-2 text-xs text-muted">
          Папки: <span className="font-mono">{m.info.allowedDirs.join(", ")}</span>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onRevoke}>
          Отключить
        </Button>
      </div>
    </div>
  );
}

function PairModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  useEffect(
    () =>
      hubEvents.on((e) => {
        if (e.type === "machine.updated" && pairing && e.data?.name) {
          toast(`Машина «${e.data.name}» подключена`, "success");
          onClose();
        }
      }),
    [pairing, onClose],
  );

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPairing(await api.post<Pairing>("/api/machines/pairing-code", name.trim() ? { name: name.trim() } : {}));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const left = pairing ? Math.max(0, Math.floor((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  const expired = !!pairing && left === 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Подключить машину"
      footer={
        pairing ? (
          <>
            {expired && (
              <Button onClick={() => void create()} loading={busy}>
                Новый код
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Готово
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Отмена</Button>
            <Button variant="primary" onClick={() => void create()} loading={busy}>
              Получить код
            </Button>
          </>
        )
      }
    >
      {!pairing ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">На машине понадобится Node.js 24+. Демон подключится к хабу исходящим соединением — открывать порты не нужно.</p>
          <Field label="Название" hint="Необязательно — по умолчанию имя компьютера">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ноутбук" maxLength={60} autoFocus />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 text-sm font-medium">1. На машине выполните</div>
            <CodeLine>{`npx openbot-node pair ${pairing.hubUrl} ${pairing.code}`}</CodeLine>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">2. Затем запустите демон</div>
            <CodeLine>npx openbot-node run</CodeLine>
          </div>
          <div className="flex items-center gap-2 text-sm">
            Код: <span className="font-mono text-base font-semibold tracking-widest">{pairing.code}</span>
            {expired ? (
              <Badge tone="danger">истёк</Badge>
            ) : (
              <Badge tone="info">
                действует {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted">Если машина в другой сети, используйте Tailscale или укажите публичный адрес хаба (OPENBOT_PUBLIC_URL).</p>
        </div>
      )}
    </Modal>
  );
}
