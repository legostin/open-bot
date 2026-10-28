// The card the assistant's hub_connect_device tool puts in the chat: one link for a computer or a phone, made on
// request. The card stays in the history, so the one-time invite is made only when the person asks for it.

import { useCallback, useState } from "react";
import { Link2, MonitorSmartphone } from "lucide-react";
import type { InviteUsed } from "@owlbot/shared";
import { InviteBlock, Joined } from "../../components/Invite";
import { Button, cx } from "../../components/ui";
import { t } from "../../i18n";

export function ConnectDeviceCard() {
  const [open, setOpen] = useState(false);
  const [joined, setJoined] = useState<InviteUsed>();
  const onJoined = useCallback((who: InviteUsed) => {
    setOpen(false);
    setJoined(who);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className={cx("my-2 flex flex-col gap-3 rounded-xl border px-3 py-2.5", open ? "border-accent/35 bg-accent-soft/40" : "border-border bg-surface-2/50")}>
      <div className="flex flex-wrap items-center gap-2">
        <MonitorSmartphone className={cx("size-4", open ? "text-accent-text" : "text-muted")} />
        <span className="text-sm font-semibold">{t("invite.title")}</span>
      </div>
      {joined && !open && <Joined who={joined} />}
      {open ? (
        <InviteBlock onJoined={onJoined} onClose={close} />
      ) : (
        <>
          {!joined && <p className="text-sm text-muted">{t("invite.intro")}</p>}
          <div>
            <Button
              variant="primary"
              size="sm"
              icon={<Link2 className="size-3.5" />}
              onClick={() => {
                setJoined(undefined);
                setOpen(true);
              }}
            >
              {t("invite.get")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
