// The card the assistant's hub_device_pairing tool puts in the chat: the switch while phones cannot reach the hub,
// then the QR on request. The card stays in the history, so the one-time code is made only when the user asks for it.

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, QrCode, Smartphone } from "lucide-react";
import type { Device } from "@owlbot/shared";
import { PairingBlock, PhoneAccess, useDevices } from "../../components/DevicePairing";
import { Button, Spinner, cx } from "../../components/ui";
import { t } from "../../i18n";

export function DevicePairingCard() {
  const { devices, network, setNetwork, error } = useDevices();
  const [open, setOpen] = useState(false);
  const [paired, setPaired] = useState<string>();
  // Once shown the switch stays, so turning it on does not pull it away from under the cursor.
  const [showSwitch, setShowSwitch] = useState(false);
  const listening = !!network?.listening;
  useEffect(() => {
    if (network && !listening) {
      setShowSwitch(true);
      setOpen(false);
    }
  }, [network, listening]);
  const onPaired = useCallback((d: Device) => {
    setOpen(false);
    setPaired(d.name);
  }, []);

  if (!network) return error ? <div className="my-2 text-sm text-danger">{error}</div> : <Spinner />;
  return (
    <div className={cx("my-2 flex flex-col gap-3 rounded-xl border px-3 py-2.5", open ? "border-accent/35 bg-accent-soft/40" : "border-border bg-surface-2/50")}>
      <div className="flex flex-wrap items-center gap-2">
        <Smartphone className={cx("size-4", open ? "text-accent-text" : "text-muted")} />
        <span className="text-sm font-semibold">{t("devices.connect")}</span>
      </div>
      {(showSwitch || !listening) && <PhoneAccess network={network} onChange={setNetwork} />}
      {paired && !open && (
        <div className="flex items-center gap-1.5 text-sm text-success">
          <CircleCheck className="size-4 shrink-0" /> {t("devices.paired", { name: paired })}
        </div>
      )}
      {listening &&
        (open ? (
          <PairingBlock devices={devices} onPaired={onPaired} onClose={() => setOpen(false)} />
        ) : (
          <div>
            <Button
              variant="primary"
              size="sm"
              icon={<QrCode className="size-3.5" />}
              onClick={() => {
                setPaired(undefined);
                setOpen(true);
              }}
            >
              {t("devices.showQr")}
            </Button>
          </div>
        ))}
    </div>
  );
}
