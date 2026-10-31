// The files waiting in the composer: a thumbnail or a file icon, the name, the size or the upload's progress bar, and
// their buttons. A picture opens in the viewer (to look at it or mark it up before sending); the pencil goes straight
// to marking it up.

import { FileText, PenLine, RotateCcw, X } from "lucide-react";
import type { PendingFile } from "../../lib/attachments";
import { isImage } from "../../lib/attachments";
import { fileSize } from "../../lib/format";
import { discardFiles, retryFile } from "../../state/attachments";
import { openViewer } from "../../state/viewer";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

const action = "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg";

export function AttachmentChips({ conversationId, files }: { conversationId: string; files: PendingFile[] }) {
  return (
    <div className="flex flex-wrap gap-2 px-1 pt-0.5 pb-1.5">
      {files.map((f) => {
        const picture = !!f.preview && isImage(f.type);
        const key = `pending:${f.id}`;
        const open = (edit: boolean) => openViewer({ kind: "pending", conversationId }, key, { edit });
        const uploading = f.status === "uploading";
        const percent = Math.round((f.progress ?? 0) * 100);
        return (
          <div
            key={f.id}
            title={f.error ?? f.name}
            className={cx(
              "relative flex max-w-72 min-w-48 items-center gap-2 rounded-xl border bg-surface-2 p-1.5 pr-1 text-xs",
              f.status === "error" ? "border-danger/40" : "border-border",
            )}
          >
            {picture ? (
              <button
                type="button"
                data-media-key={key}
                onClick={() => open(false)}
                aria-label={t("viewer.open", { name: f.name })}
                className="relative flex size-10 shrink-0 cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-surface"
              >
                <img src={f.preview} alt="" className="size-full object-cover" />
                {uploading && <span className="absolute inset-0 bg-surface/45" />}
              </button>
            ) : (
              <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface text-muted">
                <FileText className="size-4" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{f.name}</span>
              {uploading ? (
                <span className="mt-1 flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("composer.uploadingPercent", { n: percent })}>
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
                    <span className="block h-full rounded-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${Math.max(3, percent)}%` }} />
                  </span>
                  <span className="shrink-0 text-[11px] text-muted tabular-nums">{percent}%</span>
                </span>
              ) : (
                <span className={cx("block truncate", f.status === "error" ? "text-danger" : "text-muted")}>
                  {f.status === "error" ? (f.error ?? t("composer.uploadFailed")) : [f.marked ? t("composer.marked") : "", fileSize(f.size)].filter(Boolean).join(" · ")}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center">
              {f.status === "error" && (
                <button type="button" onClick={() => retryFile(conversationId, f.id)} aria-label={t("composer.retryUpload", { name: f.name })} title={t("composer.retryUpload", { name: f.name })} className={action}>
                  <RotateCcw className="size-3.5" />
                </button>
              )}
              {picture && (
                <button type="button" onClick={() => open(true)} aria-label={t("composer.markup", { name: f.name })} title={t("composer.markup", { name: f.name })} className={action}>
                  <PenLine className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => discardFiles(conversationId, [f.id])}
                aria-label={t("composer.removeFile", { name: f.name })}
                title={t("composer.removeFile", { name: f.name })}
                className={action}
              >
                <X className="size-3.5" />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
