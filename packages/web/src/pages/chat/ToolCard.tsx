// Compact, collapsible card for a tool call and its result.

import { useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Loader2, Wrench } from "lucide-react";
import type { ToolCallPart, ToolResultPart } from "../../lib/parts";
import { inputPreview, prettyJson } from "../../lib/parts";
import { CopyButton, cx } from "../../components/ui";
import { t } from "../../i18n";

export function ToolCard({ call, result, running }: { call?: ToolCallPart; result?: ToolResultPart; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = call?.name ?? t("tool.default");
  const isError = !!result?.isError;
  const preview = call ? inputPreview(call.input) : "";
  const input = call ? prettyJson(call.input) : "";
  const output = result ? prettyJson(result.output) : "";
  return (
    <div className={cx("w-full max-w-xl overflow-hidden rounded-2xl border bg-surface/70 text-[13px]", isError ? "border-danger/40" : "border-hairline")}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2/70" aria-expanded={open}>
        <ChevronRight className={cx("size-3.5 shrink-0 text-muted transition", open && "rotate-90")} />
        <Wrench className="size-3.5 shrink-0 text-muted" />
        <span className="shrink-0 font-mono font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{preview}</span>
        {result ? (
          isError ? (
            <CircleX className="size-4 shrink-0 text-danger" aria-label={t("tool.statusError")} />
          ) : (
            <CircleCheck className="size-4 shrink-0 text-success" aria-label={t("tool.statusDone")} />
          )
        ) : running ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted" aria-label={t("tool.statusRunning")} />
        ) : null}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2.5">
          {call && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold tracking-wide text-muted uppercase">
                {t("tool.input")} <CopyButton text={input} label="" />
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg bg-code-bg p-2 font-mono text-xs whitespace-pre-wrap break-words">{input || "—"}</pre>
            </div>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold tracking-wide text-muted uppercase">
              {isError ? t("tool.error") : t("tool.result")} {result && <CopyButton text={output} label="" />}
            </div>
            {result ? (
              <pre className={cx("max-h-80 overflow-auto rounded-lg bg-code-bg p-2 font-mono text-xs whitespace-pre-wrap break-words", isError && "text-danger")}>{output || t("tool.empty")}</pre>
            ) : (
              <div className="text-xs text-muted">{running ? t("tool.running") : t("tool.noResult")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
