// A task the agent started (a `task` part): one quiet line in its reply with who works on it, where, and how it goes,
// kept live by "task.updated". It opens the task; the work itself stays there.
// A message to a teammate (a `task` part with `text`) shows as the message itself: who wrote to whom, what, how it
// goes, and the answer right under it once it came. It opens the thread.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import type { AgentDef, Task } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { taskStatus, threadStatus, type Tone } from "../../lib/format";
import { agents, ensureAgents, ensureMachineActivity, ensureTasks, machineActivity, tasks } from "../../state/app";
import { brainMachine } from "../../state/brains";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Markdown } from "../../components/markdown";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

const toneText = (tone: Tone) => (tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-muted");

export function TaskLine({ taskId, text, reply, from }: { taskId: string; text?: string; reply?: string; from?: string }) {
  const list = useStore(tasks);
  const agentList = useStore(agents);
  const machines = useStore(machineActivity);
  useEffect(() => {
    ensureTasks();
    ensureAgents();
    ensureMachineActivity();
  }, []);
  const task = useMemo(() => list?.find((x) => x.id === taskId), [list, taskId]);
  if (!task) return null;
  if (text !== undefined) return <MessageLine task={task} text={text} reply={reply} from={from ?? task.from} agentList={agentList} />;
  const agent = agentList?.find((a) => a.id === task.agentId);
  const name = agent?.name ?? task.agentId;
  const machineId = task.brainRef ? brainMachine(task.brainRef) : "local";
  const where = machineId === "local" ? undefined : (machines?.find((m) => m.id === machineId)?.name ?? machineId);
  const st = taskStatus(task.status);
  const working = task.status === "running" || task.status === "queued";
  return (
    <Link
      href={`/tasks/${encodeURIComponent(task.id)}`}
      title={`${name}: ${task.title}`}
      className="animate-in -mx-1.5 my-0.5 flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs transition hover:bg-surface-2"
    >
      <AgentAvatar avatar={agent?.avatar} id={task.agentId} name={name} size={16} initial={false} />
      <span className="min-w-0 flex-1 truncate text-fg">{task.title}</span>
      {where && <span className="shrink-0 text-muted">{where}</span>}
      <span className={cx("shrink-0", toneText(st.tone), working && "animate-pulse")}>{st.label}</span>
    </Link>
  );
}

/** What one agent wrote to a teammate, and the teammate's answer under it. */
function MessageLine({ task, text, reply, from, agentList }: { task: Task; text: string; reply?: string; from?: string; agentList: AgentDef[] | null }) {
  const [open, setOpen] = useState(false);
  const [cutText, setCutText] = useState(false);
  const [cutAnswer, setCutAnswer] = useState(false);
  const sender = from ? agentList?.find((a) => a.id === from) : undefined;
  const to = agentList?.find((a) => a.id === task.agentId);
  const toName = to?.name ?? task.agentId;
  // One turn may answer two messages at once: the later line shows the thread's last answer.
  const answer = reply ?? (task.status === "done" ? task.result : undefined);
  const st = threadStatus(task.status);
  const working = task.status === "running" || task.status === "queued";
  return (
    <div className="animate-in my-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
      <Link
        href={`/tasks/${encodeURIComponent(task.id)}`}
        title={t("thread.open")}
        className="-mx-1.5 -my-0.5 flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-xs transition hover:bg-surface-2"
      >
        {from && <AgentAvatar avatar={sender?.avatar} id={from} name={sender?.name ?? from} size={16} initial={false} />}
        <ArrowRight className="size-3 shrink-0 text-muted" aria-hidden />
        <AgentAvatar avatar={to?.avatar} id={task.agentId} name={toName} size={16} initial={false} />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{toName}</span>
        <span className={cx("shrink-0", toneText(st.tone), working && "animate-pulse")}>{st.label}</span>
      </Link>
      <Clamp open={open} lines={answer ? 2 : 4} onCut={setCutText}>
        <div className="mt-1 whitespace-pre-wrap break-words text-fg">{text}</div>
      </Clamp>
      {answer && (
        <div className="mt-2 flex gap-2 border-t border-border pt-2">
          <AgentAvatar avatar={to?.avatar} id={task.agentId} name={toName} size={16} initial={false} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <Clamp open={open} lines={3} onCut={setCutAnswer}>
              <Markdown text={answer} className="text-sm" />
            </Clamp>
          </div>
        </div>
      )}
      {(open || cutText || (answer && cutAnswer)) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? t("task.collapse") : t("task.expand")}
        </button>
      )}
    </div>
  );
}

/** Its content cut to about `lines` lines and faded out unless `open`; `onCut` hears whether anything is cut off. */
function Clamp({ open, lines, onCut, children }: { open: boolean; lines: number; onCut: (cut: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => {
      const c = el.scrollHeight > el.clientHeight + 2;
      setCut(c);
      onCut(c);
    };
    check();
    const ro = new ResizeObserver(check);
    // The box stops growing at its cap; its content keeps growing (an answer arriving), so watch that too.
    for (const c of [el, ...Array.from(el.children)]) ro.observe(c);
    return () => ro.disconnect();
  }, [lines, open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      style={open ? undefined : { maxHeight: `${lines * 1.5}rem` }}
      className={cx(!open && "overflow-hidden", !open && cut && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}
    >
      {children}
    </div>
  );
}
