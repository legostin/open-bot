// A task the agent started (a `task` part): one quiet line in its reply with who works on it, where, and how it goes,
// kept live by "task.updated". It opens the task; the work itself stays there.

import { useEffect, useMemo } from "react";
import { Link } from "wouter";
import { parseBrainRef } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { taskStatus } from "../../lib/format";
import { agents, ensureAgents, ensureMachineActivity, ensureTasks, machineActivity, tasks } from "../../state/app";
import { AgentAvatar } from "../../components/AgentAvatar";
import { cx } from "../../components/ui";

export function TaskLine({ taskId }: { taskId: string }) {
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
  const agent = agentList?.find((a) => a.id === task.agentId);
  const name = agent?.name ?? task.agentId;
  const machineId = task.brainRef ? parseBrainRef(task.brainRef).machineId : "local";
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
      <span
        className={cx(
          "shrink-0",
          st.tone === "warning" ? "text-warning" : st.tone === "danger" ? "text-danger" : st.tone === "success" ? "text-success" : "text-muted",
          working && "animate-pulse",
        )}
      >
        {st.label}
      </span>
    </Link>
  );
}
