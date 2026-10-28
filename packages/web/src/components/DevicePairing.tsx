// Connecting phones (the Owlbot app): where the phones' own HTTPS port listens at home, and the one-time QR, link and
// code. Used by the Devices section and by the chat card the assistant shows when the user wants Owlbot on the phone.

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Device, DeviceNetwork, DevicePairing } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { countdown, groupedCode } from "../lib/format";
import { hubEvents, reconnected } from "../state/app";
import { useRemote } from "../state/remote";
import { toast } from "../state/toast";
import { Badge, Button, CopyButton, ErrorNote, Spinner, cx } from "./ui";
import { t } from "../i18n";

/** The paired phones and the device port's state, kept current by `device.updated` and `devices.network`. */
export function useDevices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [network, setNetwork] = useState<DeviceNetwork | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ devices: Device[]; network: DeviceNetwork }>("/api/devices");
      setDevices(r.devices);
      setNetwork(r.network);
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const off = hubEvents.on((e) => {
      if (e.type === "device.updated") void load();
      if (e.type === "devices.network") setNetwork(e.data);
    });
    const off2 = reconnected.on(() => void load());
    return () => {
      off();
      off2();
    };
  }, [load]);

  return { devices, network, error, load };
}

/** The device port on the home network: its addresses, or why phones cannot use it (OWLBOT_DEVICES=0, a busy port). */
export function PhoneAccess({ network }: { network: DeviceNetwork }) {
  const link = useRemote()?.deviceUrl;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{t("devices.home")}</span>
      {!network.enabled ? (
        <p className="text-xs text-muted">{t("devices.homeOff")}</p>
      ) : (
        network.listening &&
        (network.urls.length ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {network.urls
                .filter((u) => u !== link)
                .map((u) => (
                  <code key={u} className="rounded-lg bg-surface-2 px-2 py-0.5 font-mono text-xs">
                    {u}
                  </code>
                ))}
            </div>
            <p className="text-xs leading-relaxed text-muted">{t("devices.homeHint", { port: network.port })}</p>
          </>
        ) : (
          <p className="text-xs text-warning">{t("devices.noAddress")}</p>
        ))
      )}
      {network.error && <ErrorNote>{network.error}</ErrorNote>}
    </div>
  );
}

/** Phones already announced in a toast: the settings section and a chat card may both have a QR open. */
const announced = new Set<string>();

/**
 * The one-time QR, link and code for a phone. It asks the hub for a code when it opens and, once a phone that was not
 * in `devices` at that moment shows up, says so in a toast and calls `onPaired` (the parent closes the block).
 */
export function PairingBlock({ devices, onPaired, onClose }: { devices: Device[] | null; onPaired: (d: Device) => void; onClose?: () => void }) {
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const remote = useRemote();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());

  const create = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPairing(await api.post<DevicePairing>("/api/devices/pairing"));
      setNow(Date.now());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // One code per opening (StrictMode runs effects twice in development).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);

  const left = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  const expired = !!pairing && left === 0;
  useEffect(() => {
    if (!pairing || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing, expired]);

  // The phones there were when the block opened: one more is the phone that just scanned the code.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!devices) return;
    if (!known.current) {
      known.current = new Set(devices.map((d) => d.id));
      return;
    }
    const added = devices.find((d) => !known.current!.has(d.id));
    if (!added) return;
    known.current.add(added.id);
    if (!announced.has(added.id)) toast(t("devices.paired", { name: added.name }), "success");
    announced.add(added.id);
    onPaired(added);
  }, [devices, onPaired]);

  if (!pairing) {
    if (error) return <ErrorNote onRetry={() => void create()}>{error}</ErrorNote>;
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> {t("common.loading")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div
        role="img"
        aria-label={t("devices.qr")}
        className={cx("size-[180px] shrink-0 self-center rounded-2xl bg-white p-2.5 shadow-sm transition-opacity sm:self-start [&_svg]:block [&_svg]:size-full", expired && "opacity-25")}
        // The SVG comes from our own hub (packages/core/src/pairing.ts) and only encodes the link below.
        dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-sm">{t("devices.scan")}</p>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">{t("devices.link")}</div>
          <div className="flex items-center gap-1 rounded-xl border border-border bg-code-bg py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={pairing.link}>
              {pairing.link}
            </code>
            <CopyButton text={pairing.link} className="shrink-0" />
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">{t("devices.code")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-lg border border-border bg-code-bg px-2.5 py-1 font-mono text-base font-semibold tracking-widest select-all">{groupedCode(pairing.code)}</code>
            {expired ? <Badge tone="danger">{t("devices.expired")}</Badge> : <Badge tone="info">{t("devices.validFor", { time: countdown(left) })}</Badge>}
          </div>
        </div>
        <p className="text-xs text-muted">{t(remote?.state === "running" ? "devices.anywhere" : "devices.sameNetwork")}</p>
        {error && <ErrorNote>{error}</ErrorNote>}
        {(expired || onClose) && (
          <div className="flex flex-wrap gap-2">
            {expired && (
              <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void create()}>
                {t("devices.newCode")}
              </Button>
            )}
            {onClose && (
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t("common.close")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
