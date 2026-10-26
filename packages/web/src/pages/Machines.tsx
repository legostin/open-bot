// Machines: connected owlbot-node daemons, pairing, rename, revoke.

import { useCallback, useEffect, useState } from "react";
import { Check, Laptop, Link2, Pencil, Trash2, X } from "lucide-react";
import type { Machine } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { relativeTime } from "../lib/format";
import { pairLink } from "../lib/desktop";
import { hubEvents } from "../state/app";
import { toast } from "../state/toast";
import { t, tRich } from "../i18n";
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
      title={t("nav.machines")}
      subtitle={t("machines.subtitle")}
      actions={
        <Button variant="primary" icon={<Link2 className="size-4" />} onClick={() => setPairOpen(true)}>
          {t("machines.pair")}
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && <EmptyState icon="laptop" title={t("machines.empty")} hint={t("machines.emptyHint")} />}
      <div className="grid gap-3 md:grid-cols-2">
        {list?.map((m) => (
          <MachineCard key={m.id} m={m} onChanged={load} onRevoke={() => setRevoking(m)} />
        ))}
      </div>

      {pairOpen && <PairModal onClose={() => setPairOpen(false)} />}
      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={t("machines.revokeTitle", { name: revoking?.name })}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const m = revoking!;
                setRevoking(null);
                try {
                  await api.del(`/api/machines/${encodeURIComponent(m.id)}`);
                  toast(t("machines.revoked"), "success");
                  await load();
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              {t("machines.revoke")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("machines.revokeText")}</p>
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
              <IconButton label={t("common.save")} onClick={() => void save()} className="size-8 shrink-0">
                <Check className="size-4" />
              </IconButton>
              <IconButton
                label={t("common.cancel")}
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
                {online ? t("machines.online") : t("machines.offline")}
              </Badge>
              <IconButton label={t("common.rename")} onClick={() => setEditing(true)} className="size-7">
                <Pencil className="size-3.5" />
              </IconButton>
            </div>
          )}
          <div className="mt-0.5 text-xs text-muted">
            {m.info ? `${m.info.os} · ${m.info.arch} · ${m.info.hostname}` : t("machines.noInfo")}
            {m.info?.nodeVersion && ` · node ${m.info.nodeVersion}`}
          </div>
          <div className="text-xs text-muted">
            {online ? t("machines.connected") : m.lastSeenAt ? t("machines.lastSeen", { time: relativeTime(m.lastSeenAt) }) : t("machines.neverConnected")}
          </div>
        </div>
      </div>
      {m.info?.clis && m.info.clis.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {m.info.clis.map((c) => (
            <Badge key={c.brainId} tone={c.authenticated ? "success" : c.available ? "warning" : "neutral"}>
              {c.brainId}
              {c.version ? ` ${c.version}` : ""}
              {!c.available ? ` — ${t("machines.cliMissing")}` : !c.authenticated ? ` — ${t("machines.cliNeedsLogin")}` : ""}
            </Badge>
          ))}
        </div>
      )}
      {m.info?.allowedDirs && m.info.allowedDirs.length > 0 && (
        <div className="mt-2 text-xs text-muted">
          {tRich("machines.folders", { list: <span className="font-mono">{m.info.allowedDirs.join(", ")}</span> })}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onRevoke}>
          {t("machines.revoke")}
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
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(
    () =>
      hubEvents.on((e) => {
        if (e.type === "machine.updated" && pairing && e.data?.name) {
          toast(t("machines.paired", { name: e.data.name }), "success");
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
      title={t("machines.pair")}
      footer={
        pairing ? (
          <>
            {expired && (
              <Button onClick={() => void create()} loading={busy}>
                {t("machines.newCode")}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {t("common.done")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => void create()} loading={busy}>
              {t("machines.getCode")}
            </Button>
          </>
        )
      }
    >
      {!pairing ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("machines.intro")}</p>
          <Field label={t("machines.name")} hint={t("machines.nameHint")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("machines.namePlaceholder")} maxLength={60} autoFocus />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 text-sm font-medium">{t("machines.step1")}</div>
            <CodeLine>{`npx owlbot-node pair ${pairing.hubUrl} ${pairing.code}`}</CodeLine>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">{t("machines.step2")}</div>
            <CodeLine>npx owlbot-node run</CodeLine>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-muted">{t("machines.orApp")}</span>
            <a className="font-medium text-accent-text hover:underline" href={pairLink(pairing.hubUrl, pairing.code)}>
              {t("machines.openInApp")}
            </a>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {t("machines.code")} <span className="font-mono text-base font-semibold tracking-widest">{pairing.code}</span>
            {expired ? (
              <Badge tone="danger">{t("machines.expired")}</Badge>
            ) : (
              <Badge tone="info">{t("machines.validFor", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })}</Badge>
            )}
          </div>
          <p className="text-xs text-muted">{t("machines.otherNetwork")}</p>
        </div>
      )}
    </Modal>
  );
}
