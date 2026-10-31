// Devices: phones with the Piomio app. Where they reach the hub at home and away (the link), pairing by QR, rename,
// revoke.

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, QrCode, Smartphone, Trash2, X } from "lucide-react";
import type { Device } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { relativeTime } from "../lib/format";
import { toast } from "../state/toast";
import { useRemote } from "../state/remote";
import { openPanelItem } from "../state/panel";
import { t } from "../i18n";
import { PhoneAccess, useDevices } from "../components/DevicePairing";
import { InviteBlock } from "../components/Invite";
import { Button, EmptyState, ErrorNote, IconButton, Input, Loading, Modal, Page } from "../components/ui";

export function DevicesPage() {
  const { devices, network, error, load } = useDevices();
  const [pairOpen, setPairOpen] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const remote = useRemote();
  const linkUp = remote?.state === "running" && !!remote.deviceUrl;
  // A phone pairs over the home network's port or through the link.
  const canPair = !!network?.listening || linkUp;
  const closePairing = useCallback(() => setPairOpen(false), []);

  // The QR points at the addresses open now: when none is, the block closes.
  useEffect(() => {
    if (!canPair) setPairOpen(false);
  }, [canPair]);

  return (
    <Page
      title={t("nav.devices")}
      subtitle={t("devices.subtitle")}
      actions={
        <Button variant="primary" icon={<QrCode className="size-4" />} disabled={!canPair || pairOpen} onClick={() => setPairOpen(true)}>
          {t("devices.connect")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!network && !error && <Loading />}
        {network && (
          <section className="rounded-2xl border border-border bg-surface p-4 shadow-card">
            <PhoneAccess network={network} />
          </section>
        )}
        {remote?.available && (
          <section className="rounded-2xl border border-border bg-surface p-4 shadow-card">
            {linkUp ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t("remote.devicesAway")}</span>
                <code className="w-fit max-w-full truncate rounded-lg bg-surface-2 px-2 py-0.5 font-mono text-xs">{remote.deviceUrl}</code>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="min-w-0 flex-1 text-sm text-muted">{t("remote.devicesOff")}</p>
                <Button size="sm" onClick={() => openPanelItem("plugins", "remote-access")}>
                  {t("remote.devicesSetUp")}
                </Button>
              </div>
            )}
          </section>
        )}
        {pairOpen && canPair && (
          <section className="animate-in rounded-2xl border border-accent/25 bg-surface p-4 shadow-card">
            <div className="mb-3 font-semibold">{t("devices.connect")}</div>
            <InviteBlock onJoined={closePairing} onClose={closePairing} />
          </section>
        )}
        {devices && (
          <section>
            <div className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{t("devices.list")}</div>
            {devices.length === 0 ? (
              <EmptyState icon="smartphone" title={t("devices.empty")} hint={t("devices.emptyHint")} />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {devices.map((d) => (
                  <DeviceCard key={d.id} d={d} onChanged={load} onRevoke={() => setRevoking(d)} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={t("devices.revokeTitle", { name: revoking?.name })}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const d = revoking!;
                setRevoking(null);
                try {
                  await api.del(`/api/devices/${encodeURIComponent(d.id)}`);
                  toast(t("devices.revoked"), "success");
                  await load();
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              {t("devices.revoke")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("devices.revokeText")}</p>
      </Modal>
    </Page>
  );
}

function DeviceCard({ d, onChanged, onRevoke }: { d: Device; onChanged: () => Promise<void>; onRevoke: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const save = async () => {
    setEditing(false);
    if (!name.trim() || name.trim() === d.name) return setName(d.name);
    try {
      await api.patch(`/api/devices/${encodeURIComponent(d.id)}`, { name: name.trim() });
      await onChanged();
    } catch (e) {
      toast(errorText(e), "error");
      setName(d.name);
    }
  };
  const kind = [d.model, d.platform === "ios" ? t("devices.platform.ios") : d.platform].filter(Boolean).join(" · ");
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Smartphone className="size-5" />
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
                  setName(d.name);
                }}
                className="size-8 shrink-0"
              >
                <X className="size-4" />
              </IconButton>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{d.name}</span>
              <IconButton
                label={t("common.rename")}
                onClick={() => {
                  setName(d.name);
                  setEditing(true);
                }}
                className="size-7"
              >
                <Pencil className="size-3.5" />
              </IconButton>
            </div>
          )}
          {kind && <div className="mt-0.5 text-xs text-muted">{kind}</div>}
          <div className="text-xs text-muted">{d.lastSeenAt ? t("devices.lastSeen", { time: relativeTime(d.lastSeenAt) }) : t("devices.added", { time: relativeTime(d.createdAt) })}</div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onRevoke}>
          {t("devices.revoke")}
        </Button>
      </div>
    </div>
  );
}
