// The team's side of a chapter: what the agents do, pushed through the demo hub as a real hub's runner would (a
// streaming message, its text in deltas, tool calls, cards, the live step line, approvals that wait for the person).

import type { Approval, ApprovalAsk, Message, MessagePart, Task, ToolEffect, WorkStep } from "@piomio/shared";
import type { DemoHub } from "../hub/hub";
import { dialogOf, iso, newId, type AgentId } from "../world";
import type { Clock } from "./clock";

export interface ApprovalSpec {
  tool: string;
  input: unknown;
  summary: string;
  ask?: ApprovalAsk;
  effect?: ToolEffect;
  tainted?: boolean;
}

/** One reply being written. Every step pushes the same events a hub would. */
export class Reply {
  readonly id: string;
  readonly agent: AgentId;
  readonly conversationId: string;
  private hub: DemoHub;
  private clock: Clock;
  private machine: string;
  private brainId: string;
  private taskId?: string;

  constructor(hub: DemoHub, clock: Clock, m: Message, machine: string) {
    this.hub = hub;
    this.clock = clock;
    this.id = m.id;
    this.agent = m.agentId as AgentId;
    this.conversationId = m.conversationId;
    this.machine = machine;
    this.brainId = (m.brainRef ?? "claude-code").split("@")[0];
    this.taskId = m.taskId;
  }

  /** What the live line under the reply says (the machine's activity). */
  step(step: WorkStep, detail?: string): void {
    const machines = this.hub.world.machines.map((mc) => ({ ...mc, work: mc.work.filter((w) => w.conversationId !== this.conversationId) }));
    const mc = machines.find((x) => x.id === this.machine) ?? machines[0];
    mc.work.push({ agentId: this.agent, conversationId: this.conversationId, ...(this.taskId ? { taskId: this.taskId } : {}), brainId: this.brainId, step, ...(detail ? { detail } : {}), startedAt: iso() });
    this.hub.world.machines = machines;
    this.hub.emit({ type: "machines.activity", data: machines });
  }

  async think(ms = 900, detail?: string): Promise<void> {
    this.step("thinking", detail);
    await this.clock.wait(ms);
  }

  /** A tool call and its result (shown in the details mode; the live line says what it does). */
  async tool(name: string, input: unknown, output: string, ms = 700, step: WorkStep = "tool", detail?: string): Promise<void> {
    const id = newId("call");
    this.step(step, detail ?? name);
    this.push({ type: "tool_call", id, name, input });
    await this.clock.wait(ms);
    this.push({ type: "tool_result", id, output });
  }

  /** Text streamed in small pieces, at a writer's pace. */
  async write(text: string): Promise<void> {
    this.step("writing");
    let i = 0;
    while (i < text.length) {
      const n = 2 + Math.floor(Math.random() * 5);
      this.hub.delta(this.id, text.slice(i, i + n));
      i += n;
      await this.clock.wait(16 + Math.random() * 18);
    }
  }

  push(part: MessagePart): void {
    this.hub.updateMessage(this.id, (m) => ({ ...m, parts: [...m.parts, part] }));
  }

  /** An action that needs the person's yes: the card in this reply. Resolves with the answer. */
  async approval(spec: ApprovalSpec): Promise<{ id: string; answer: Promise<{ status: "approved" | "denied"; remember: boolean }> }> {
    const a: Approval = {
      id: newId("apr"),
      sessionId: "demo",
      conversationId: this.conversationId,
      agentId: this.agent,
      tool: spec.tool,
      input: spec.input,
      summary: spec.summary,
      ...(spec.ask ? { ask: spec.ask } : {}),
      effect: spec.effect ?? "external",
      tainted: spec.tainted ?? false,
      status: "pending",
      createdAt: iso(),
    };
    this.hub.raiseApproval(a);
    this.push({ type: "approval", approvalId: a.id, summary: a.summary, status: "pending", ...(a.ask ? { ask: a.ask } : {}) });
    this.step("approval");
    return { id: a.id, answer: this.hub.waitApproval(a.id) };
  }

  done(): void {
    this.hub.updateMessage(this.id, (m) => ({ ...m, status: "complete" }));
    const machines = this.hub.world.machines.map((mc) => ({ ...mc, work: mc.work.filter((w) => w.conversationId !== this.conversationId) }));
    this.hub.world.machines = machines;
    this.hub.emit({ type: "machines.activity", data: machines });
    this.hub.setRunning(this.conversationId, false);
  }
}

export class Agents {
  readonly hub: DemoHub;
  private clock: Clock;

  constructor(hub: DemoHub, clock: Clock) {
    this.hub = hub;
    this.clock = clock;
  }

  /** Starts a reply in an agent's dialog (or another conversation). */
  reply(agent: AgentId, opts: { conversationId?: string; taskId?: string; model?: string; machine?: string; brain?: "claude-code" | "codex" } = {}): Reply {
    const conversationId = opts.conversationId ?? dialogOf(agent);
    const brainRef = `${opts.brain ?? "claude-code"}@${opts.machine ?? "local"}`;
    const m: Message = {
      id: newId("msg"),
      conversationId,
      role: "assistant",
      parts: [],
      status: "streaming",
      agentId: agent,
      brainRef,
      model: opts.model ?? (opts.brain === "codex" ? "gpt-5.5-codex" : "opus"),
      effort: "medium",
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      createdAt: iso(),
    };
    this.hub.setRunning(conversationId, true);
    this.hub.addMessage(m);
    return new Reply(this.hub, this.clock, m, opts.machine ?? "local");
  }

  /** A whole short reply: think, write, done. */
  async say(agent: AgentId, text: string, opts: { conversationId?: string; think?: number } = {}): Promise<Reply> {
    const r = this.reply(agent, opts);
    await r.think(opts.think ?? 700);
    await r.write(text);
    r.done();
    return r;
  }

  /** A message that arrives whole (a digest, a notice): no streaming. */
  arrive(agent: AgentId, parts: MessagePart[], opts: { conversationId?: string } = {}): Message {
    const m: Message = {
      id: newId("msg"),
      conversationId: opts.conversationId ?? dialogOf(agent),
      role: "assistant",
      parts,
      status: "complete",
      agentId: agent,
      createdAt: iso(),
    };
    return this.hub.addMessage(m);
  }

  /** A message that is simply there (seeding a chapter with what happened before it). */
  seed(agent: AgentId, parts: MessagePart[], opts: { conversationId?: string; minutesAgo?: number; role?: Message["role"] } = {}): Message {
    const role = opts.role ?? "assistant";
    const m: Message = {
      id: newId("msg"),
      conversationId: opts.conversationId ?? dialogOf(agent),
      role,
      parts,
      status: "complete",
      ...(role === "assistant" ? { agentId: agent, brainRef: "claude-code@local", model: "opus", effort: "medium" } : { channel: "web" }),
      createdAt: iso((opts.minutesAgo ?? 0) * 60_000),
    };
    this.hub.messagesOf(m.conversationId).push(m);
    this.hub.touch(m.conversationId, m.createdAt);
    this.hub.markRead(m.conversationId, m.createdAt);
    return m;
  }

  /** A task an agent works on: shown as a line in the dialog that started it and in Tasks. */
  task(spec: Omit<Task, "id" | "createdAt" | "updatedAt" | "conversationId" | "background" | "createdBy"> & Partial<Pick<Task, "createdBy">>): Task {
    const task: Task = { id: newId("task"), conversationId: newId("conv"), background: false, createdBy: spec.createdBy ?? "agent", createdAt: iso(), updatedAt: iso(), ...spec };
    this.hub.world.tasks.push(task);
    this.hub.world.conversations.push({ id: task.conversationId, kind: "task", title: task.title, agentId: task.agentId, taskId: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt });
    this.hub.world.messages[task.conversationId] = [];
    this.hub.emit({ type: "task.updated", data: task });
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const t = this.hub.world.tasks.find((x) => x.id === id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: iso() });
    this.hub.emit({ type: "task.updated", data: { ...t } });
    return t;
  }
}
