// Phones (the Owlbot app): the paired list and where the phones' own HTTPS port listens at home. Connecting one is an
// invite (components/Invite.tsx).

import { useCallback, useEffect, useState } from "react";
import type { Device, DeviceNetwork } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { hubEvents, reconnected } from "../state/app";
import { useRemote } from "../state/remote";
import { ErrorNote } from "./ui";
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
