// What a turn is doing right now (machines.activity), where its reply will appear: "Reading plan.md…", "Running: npm
// test…", "Starting a task…", "Waiting for your permission". The three dots while nothing is known yet. A task's line
// shows the same words for its own turn.

import { useEffect } from "react";
import type { MachineWork } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { ensureMachineActivity, machineActivity } from "../../state/app";
import { cx } from "../../components/ui";
import { t, type MessageKey } from "../../i18n";

/** The turn in progress in a conversation (its agent's, when given), or a task's turn. */
export function useWork(match: { conversationId?: string; agentId?: string; taskId?: string }): MachineWork | undefined {
  const all = useStore(machineActivity);
  useEffect(() => ensureMachineActivity(), []);
  const work = (all ?? []).flatMap((m) => m.work);
  if (match.taskId) return work.find((w) => w.taskId === match.taskId);
  return work.find((w) => w.conversationId === match.conversationId && (!match.agentId || w.agentId === match.agentId));
}

/** The hub's tools that read better as words than as their names. */
const TOOL_WORDS: Array<[RegExp, MessageKey]> = [
  [/^task_(delegate|message)$/, "step.tool.task"],
  [/^team_message$/, "step.tool.teammate"],
  [/^memory_/, "step.tool.memory"],
  [/^page_/, "step.tool.page"],
  [/^show_map$/, "step.tool.map"],
  [/^(show_images|image_)/, "step.tool.images"],
  [/^browser_/, "step.tool.browser"],
];

/** The words for a step, with what it is about when that is known. */
export function stepText(w: Pick<MachineWork, "step" | "detail">): string {
  const detail = w.detail?.trim();
  if (w.step === "tool") {
    const known = detail ? TOOL_WORDS.find(([re]) => re.test(detail)) : undefined;
    if (known) return t(known[1]);
    return detail ? t("step.toolNamed", { tool: detail.replace(/_/g, " ") }) : t("step.tool");
  }
  if (detail && (w.step === "command" || w.step === "reading" || w.step === "editing" || w.step === "web")) return t(`step.${w.step}Named`, { detail });
  return t(`step.${w.step}`);
}

/** The line in place of the three dots: what the agent does now, breathing while it works. */
export function LiveStep({ conversationId, agentId, fallback }: { conversationId: string; agentId?: string; fallback: React.ReactNode }) {
  const work = useWork({ conversationId, agentId });
  // Writing shows the words themselves; thinking before anything is known keeps the dots.
  if (!work || work.step === "writing" || (work.step === "thinking" && !work.detail)) return <>{fallback}</>;
  const waiting = work.step === "approval";
  return (
    <span className={cx("inline-flex max-w-full items-center gap-2 px-1 py-1.5 text-[13px]", waiting ? "text-warning" : "text-muted")} aria-live="polite">
      <span className={cx("size-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : "live-dot")} />
      <span className="min-w-0 truncate">{stepText(work)}</span>
    </span>
  );
}
