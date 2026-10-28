// The card the assistant's hub_device_pairing tool puts in the chat: the QR on request, or why phones cannot reach the
// hub. The card stays in the history, so the one-time code is made only when the user asks for it.

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, QrCode, Smartphone } from "lucide-react";
import type { Device } from "@owlbot/shared";
import { PairingBlock, PhoneAccess, useDevices } from "../../components/DevicePairing";
import { Button, Spinner, cx } from "../../components/ui";
import { useRemote } from "../../state/remote";
import { t } from "../../i18n";

export function DevicePairingCard() {
  const { devices, network, error } = useDevices();
  const [open, setOpen] = useState(false);
  const [paired, setPaired] = useState<string>();
  const remote = useRemote();
  // A phone pairs over the home network's port or through the link.
  const canPair = !!network?.listening || (remote?.state === "running" && !!remote.deviceUrl);
  useEffect(() => {
    if (network && !canPair) setOpen(false);
  }, [network, canPair]);
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
      {!canPair && <PhoneAccess network={network} />}
      {paired && !open && (
        <div className="flex items-center gap-1.5 text-sm text-success">
          <CircleCheck className="size-4 shrink-0" /> {t("devices.paired", { name: paired })}
        </div>
      )}
      {canPair &&
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
