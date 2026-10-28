// What an agent knows about itself at the moment of a turn. Every brain session of an agent (its dialog, a group chat,
// a task, a thread with a teammate) is one person: the `[You now]` block tells each of them where this session runs,
// what else the agent is doing, what each teammate is busy with, the computers and where the user is. The runner puts
// it before a turn's input whenever it changed since the session last saw it (the first turn always gets it).
import type { MachineActivity, Task, TaskStatus } from "@owlbot/shared";

/** How an open task stands, for the model. */
export const TASK_STATE: Partial<Record<TaskStatus, string>> = {
  queued: "waiting to start",
  running: "working",
  waiting_approval: "waiting for the user's approval",
  waiting_input: "waiting for an answer",
  paused: "paused until its brain's limit resets",
  interrupted: "interrupted",
};

/** Tasks listed per agent; the rest are counted. */
const MAX_OWN = 8;
const MAX_TEAMMATE = 3;

export interface SituationFacts {
  /** The agent whose turn it is. */
  agentId: string;
  /** This session: what it is and the computer its brain runs on. */
  session: { kind: "dialog" | "group" | "task" | "thread"; conversationId: string; machine: string; local: boolean; task?: Task; groupTitle?: string };
  /** The whole team, this agent included: id and display name. */
  team: Array<{ id: string; name: string }>;
  /** The hub's open tasks, any agent's. */
  tasks: Task[];
  /** Turns in progress on each computer. */
  activity: MachineActivity[];
  /** The agent who started a task (a thread's sender, the agent of the conversation it came from), if an agent did. */
  starter: (task: Task) => string | undefined;
  /** The computer a task runs on. */
  machineOf: (task: Task) => string;
  /** A moment in the user's time zone: "23:02", or "27 Oct, 23:02" on another day. */
  time: (iso: string) => string;
  /** Where the user is, when their phone shares it. */
  user?: string;
}

/** The `[You now]` block. */
export function situation(f: SituationFacts): string {
  const name = (id: string) => f.team.find((a) => a.id === id)?.name ?? id;
  const own = f.session.task?.id;
  const lines = ["[You now]", `This session: ${sessionLine(f, name)}, on the computer "${f.session.machine}"${f.session.local ? " (the hub's own)" : ""}.`];

  // The agent's other sessions: its tasks and threads, its dialog or a group chat mid-turn.
  const mine = f.tasks.filter((t) => t.agentId === f.agentId && t.id !== own);
  const talking = turnsOf(f, f.agentId).filter((w) => w.conversationId !== f.session.conversationId);
  const other = [
    ...talking.map((w) => `- ${w.title ? `the group chat “${w.title}”` : "your dialog with the user"}: replying now`),
    ...mine.slice(0, MAX_OWN).map((t) => `- ${taskLine(f, t, name, "you")}`),
  ];
  if (mine.length > MAX_OWN) other.push(`- and ${mine.length - MAX_OWN} more tasks`);
  if (other.length) lines.push("Your other work (all of it is you, in other sessions):", ...other);
  else lines.push("Your other work: none; this session is all you are doing now.");

  const mates = f.team.filter((a) => a.id !== f.agentId);
  if (mates.length) lines.push("Team now:", ...mates.map((a) => `- ${a.id} (${a.name}): ${busy(f, a.id, name)}`));
  if (f.activity.length > 1) {
    lines.push(`Computers: ${f.activity.map((m) => `${m.name}${m.id === "local" ? " (the hub's own)" : ""} ${m.online ? "online" : "offline"}`).join(", ")}.`);
  }
  if (f.user) lines.push(`The user: ${f.user}`);
  return lines.join("\n");
}

/** What a teammate is busy with, in one line: its turns in progress and its open tasks, or "free". */
export function busy(f: Pick<SituationFacts, "tasks" | "activity" | "starter" | "machineOf" | "time">, agentId: string, name: (id: string) => string): string {
  const parts = turnsOf(f, agentId).map((w) => (w.title ? `replying in the group chat “${w.title}”` : "replying in its dialog with the user"));
  const tasks = f.tasks.filter((t) => t.agentId === agentId);
  if (tasks.length) {
    const listed = tasks.slice(0, MAX_TEAMMATE).map((t) => taskLine(f, t, name, name(agentId)));
    parts.push(`${listed.join("; ")}${tasks.length > MAX_TEAMMATE ? `; and ${tasks.length - MAX_TEAMMATE} more tasks` : ""}`);
  }
  return parts.join("; ") || "free";
}

function sessionLine(f: SituationFacts, name: (id: string) => string): string {
  const t = f.session.task;
  if (f.session.kind === "thread" && t) return `your thread ${t.id} answering ${name(t.from ?? "")}, who wrote to you`;
  if (t) return `your ${t.background ? "background " : ""}task ${t.id} “${t.title}”${from(f, t, name, "you")}, since ${f.time(t.createdAt)}`;
  if (f.session.kind === "group") return `the group chat “${f.session.groupTitle ?? ""}”`;
  return "your dialog with the user";
}

/** One open task: "t_1 “Title”: a task from the user, on MacBook, since 23:02; working". */
function taskLine(f: Pick<SituationFacts, "starter" | "machineOf" | "time">, t: Task, name: (id: string) => string, self: string): string {
  const state = TASK_STATE[t.status] ?? t.status;
  if (t.kind === "message") return `${t.id} a thread answering ${name(t.from ?? "")}: ${t.status === "running" ? "answering" : state}`;
  return `${t.id} “${t.title}”: a task${from(f, t, name, self)}, on ${f.machineOf(t)}, since ${f.time(t.createdAt)}; ${state}${t.question ? ", asked a question" : ""}`;
}

function from(f: Pick<SituationFacts, "starter">, t: Task, name: (id: string) => string, self: string): string {
  if (t.createdBy === "user") return " from the user";
  if (t.createdBy === "trigger") return " from a trigger";
  const by = f.starter(t);
  return by ? ` from ${by === t.agentId ? self : name(by)}` : "";
}

/** The agent's turns in progress that are not tasks: its dialog, group chats. */
function turnsOf(f: Pick<SituationFacts, "activity">, agentId: string) {
  return f.activity.flatMap((m) => m.work).filter((w) => w.agentId === agentId && !w.taskId);
}
