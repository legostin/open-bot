// The files waiting in the composer: a thumbnail or a file icon, the name, the size (or upload state) and a remove button.

import { FileText, Loader2, X } from "lucide-react";
import type { PendingFile } from "../../lib/attachments";
import { fileSize } from "../../lib/format";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

export function AttachmentChips({ files, onRemove }: { files: PendingFile[]; onRemove: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 px-1 pt-0.5 pb-1.5">
      {files.map((f) => (
        <div
          key={f.id}
          title={f.error ?? f.name}
          className={cx(
            "relative flex max-w-60 min-w-0 items-center gap-2 rounded-xl border bg-surface-2 p-1.5 pr-8 text-xs",
            f.status === "error" ? "border-danger/40" : "border-border",
          )}
        >
          <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface text-muted">
            {f.preview ? <img src={f.preview} alt="" className="size-full object-cover" /> : <FileText className="size-4" />}
            {f.status === "uploading" && (
              <span className="absolute inset-0 flex items-center justify-center bg-surface/70">
                <Loader2 className="size-4 animate-spin" />
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{f.name}</span>
            <span className={cx("block truncate", f.status === "error" ? "text-danger" : "text-muted")}>
              {f.status === "uploading" ? t("composer.uploading") : f.status === "error" ? (f.error ?? t("composer.uploadFailed")) : fileSize(f.size)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(f.id)}
            aria-label={t("composer.removeFile", { name: f.name })}
            title={t("composer.removeFile", { name: f.name })}
            className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
