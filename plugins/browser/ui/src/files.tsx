// A page asked for files (its file field was clicked while the person is in control): no file dialog can show in the
// agents' browser, so the live view offers the person's own — a computer's files, a phone's photos — and sends what
// they pick to the page.

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@piomio/ui";
import { host, t } from "./host.ts";
import { blobToBase64 } from "./voice.ts";

/** What the hub takes for one file. */
const MAX_BYTES = 25 * 1024 * 1024;

interface Ask {
  multiple: boolean;
  accept: string;
}

export function FileAsk({ phone }: { phone: boolean }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(
    () =>
      host.plugin.on("filechooser", (e: { open?: boolean; multiple?: boolean; accept?: string }) => {
        setAsk(e.open ? { multiple: !!e.multiple, accept: e.accept ?? "" } : null);
        setBusy(false);
        setError(null);
      }),
    [],
  );

  if (!ask) return null;

  const pick = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (input.current) input.current.value = "";
    if (!files.length) return;
    const big = files.find((f) => f.size > MAX_BYTES);
    if (big) {
      setError(t("ui.files.tooBig", { name: big.name }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { files: await Promise.all(files.map(async (f) => ({ name: f.name, data: await blobToBase64(f) }))) };
      const r = await host.plugin.http<{ ok: boolean; error?: string }>("POST", "upload/files", body);
      // On success the hub closes the request for every viewer ("filechooser" {open: false}).
      if (!r?.ok) setError(t("ui.files.failed", { detail: r?.error ?? "" }));
    } catch (e) {
      setError(t("ui.files.failed", { detail: (e as Error)?.message ?? String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`obb-files${phone ? " is-phone" : ""}`} role="status">
      <Upload aria-hidden className="obb-files-icon" />
      <span className="obb-files-text">{error ?? t(ask.multiple ? "ui.files.askMany" : "ui.files.ask")}</span>
      <input
        ref={input}
        type="file"
        hidden
        multiple={ask.multiple}
        accept={ask.accept || undefined}
        onChange={(e) => void pick(e.target.files)}
      />
      <Button size="sm" variant="primary" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? t("ui.files.sending") : t(ask.multiple ? "ui.files.chooseMany" : "ui.files.choose")}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void host.plugin.http("POST", "upload/cancel", {}).catch(() => {})}>
        {t("ui.files.cancel")}
      </Button>
    </div>
  );
}
