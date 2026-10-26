// Repositories for conversations, messages, tasks and brain sessions.

import { createHash, randomBytes } from "node:crypto";
import type { Conversation, Message, MessagePart, Task, TaskStatus } from "@openbot/shared";
import { newId, nowIso } from "@openbot/shared";
import { json, type Db } from "./db.ts";
import type { EventBus } from "./bus.ts";

export interface SessionRow {
  id: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  brainRef: string;
  resumeToken?: string;
  tainted: boolean;
  status: "active" | "closed";
  background: boolean;
  createdAt: string;
  updatedAt: string;
}

const convFrom = (r: any): Conversation => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  agentId: r.agent_id,
  taskId: r.task_id ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const msgFrom = (r: any): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  parts: json<MessagePart[]>(r.parts, []),
  status: r.status,
  agentId: r.agent_id ?? undefined,
  taskId: r.task_id ?? undefined,
  brainRef: r.brain_ref ?? undefined,
  channel: r.channel ?? undefined,
  createdAt: r.created_at,
});

const taskFrom = (r: any): Task => ({
  id: r.id,
  conversationId: r.conversation_id,
  parentConversationId: r.parent_conversation_id ?? undefined,
  parentTaskId: r.parent_task_id ?? undefined,
  agentId: r.agent_id,
  title: r.title,
  goal: r.goal,
  status: r.status,
  brainRef: r.brain_ref ?? undefined,
  createdBy: r.created_by,
  triggerId: r.trigger_id ?? undefined,
  background: !!r.background,
  result: r.result ?? undefined,
  error: r.error ?? undefined,
  resumeAt: r.resume_at ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const sessionFrom = (r: any): SessionRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  taskId: r.task_id ?? undefined,
  agentId: r.agent_id,
  brainRef: r.brain_ref,
  resumeToken: r.resume_token ?? undefined,
  tainted: !!r.tainted,
  status: r.status,
  background: !!r.background,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Store {
  db: Db;
  bus: EventBus;
  constructor(db: Db, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  // ---------- conversations ----------

  createConversation(c: { kind: Conversation["kind"]; title: string; agentId: string; taskId?: string; id?: string }): Conversation {
    const now = nowIso();
    const conv: Conversation = { id: c.id ?? newId("c_"), kind: c.kind, title: c.title, agentId: c.agentId, taskId: c.taskId, createdAt: now, updatedAt: now };
    this.db
      .prepare("insert into conversations(id, kind, title, agent_id, task_id, created_at, updated_at) values (?,?,?,?,?,?,?)")
      .run(conv.id, conv.kind, conv.title, conv.agentId, conv.taskId ?? null, now, now);
    this.bus.emit("conversation.updated", conv);
    return conv;
  }

  getConversation(id: string): Conversation | undefined {
    const r = this.db.prepare("select * from conversations where id = ?").get(id);
    return r ? convFrom(r) : undefined;
  }

  mainConversation(defaultAgent: string): Conversation {
    const r = this.db.prepare("select * from conversations where kind = 'main' order by created_at limit 1").get();
    if (r) return convFrom(r);
    return this.createConversation({ kind: "main", title: "Главный", agentId: defaultAgent, id: "main" });
  }

  listConversations(limit = 100): Conversation[] {
    return this.db.prepare("select * from conversations order by updated_at desc limit ?").all(limit).map(convFrom);
  }

  touchConversation(id: string): void {
    this.db.prepare("update conversations set updated_at = ? where id = ?").run(nowIso(), id);
  }

  updateConversation(id: string, patch: { title?: string; agentId?: string }): Conversation | undefined {
    if (patch.title !== undefined) this.db.prepare("update conversations set title = ? where id = ?").run(patch.title, id);
    if (patch.agentId !== undefined) this.db.prepare("update conversations set agent_id = ? where id = ?").run(patch.agentId, id);
    const c = this.getConversation(id);
    if (c) this.bus.emit("conversation.updated", c);
    return c;
  }

  // ---------- messages ----------

  addMessage(m: Omit<Message, "id" | "createdAt"> & { id?: string }): Message {
    const msg: Message = { ...m, id: m.id ?? newId("m_"), createdAt: nowIso() };
    this.db
      .prepare("insert into messages(id, conversation_id, role, parts, status, agent_id, task_id, brain_ref, channel, created_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(msg.id, msg.conversationId, msg.role, JSON.stringify(msg.parts), msg.status, msg.agentId ?? null, msg.taskId ?? null, msg.brainRef ?? null, msg.channel ?? null, msg.createdAt);
    this.touchConversation(msg.conversationId);
    this.bus.emit("message.created", msg);
    return msg;
  }

  updateMessage(id: string, patch: { parts?: MessagePart[]; status?: Message["status"]; brainRef?: string }, emit = true): Message | undefined {
    if (patch.parts) this.db.prepare("update messages set parts = ? where id = ?").run(JSON.stringify(patch.parts), id);
    if (patch.status) this.db.prepare("update messages set status = ? where id = ?").run(patch.status, id);
    if (patch.brainRef) this.db.prepare("update messages set brain_ref = ? where id = ?").run(patch.brainRef, id);
    const m = this.getMessage(id);
    if (m && emit) this.bus.emit("message.updated", m);
    return m;
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare("select * from messages where id = ?").get(id);
    return r ? msgFrom(r) : undefined;
  }

  listMessages(conversationId: string, opts: { limit?: number; before?: string } = {}): Message[] {
    const limit = opts.limit ?? 200;
    const rows = opts.before
      ? this.db.prepare("select * from messages where conversation_id = ? and created_at < ? order by created_at desc limit ?").all(conversationId, opts.before, limit)
      : this.db.prepare("select * from messages where conversation_id = ? order by created_at desc limit ?").all(conversationId, limit);
    return rows.map(msgFrom).reverse();
  }

  /** Mark leftover streaming messages as errored (after a crash). */
  failStreamingMessages(): void {
    const rows = this.db.prepare("select * from messages where status = 'streaming'").all().map(msgFrom);
    for (const m of rows) {
      this.updateMessage(m.id, { status: "error", parts: [...m.parts, { type: "error", message: "Прервано перезапуском хаба" }] }, false);
    }
  }

  // ---------- tasks ----------

  createTask(t: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "conversationId"> & { status?: TaskStatus }): Task {
    const id = newId("t_");
    const conv = this.createConversation({ kind: "task", title: t.title, agentId: t.agentId, taskId: id });
    const now = nowIso();
    const task: Task = { ...t, id, conversationId: conv.id, status: t.status ?? "queued", createdAt: now, updatedAt: now };
    this.db
      .prepare(
        "insert into tasks(id, conversation_id, parent_conversation_id, parent_task_id, agent_id, title, goal, status, brain_ref, created_by, trigger_id, background, result, error, resume_at, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        task.id,
        task.conversationId,
        task.parentConversationId ?? null,
        task.parentTaskId ?? null,
        task.agentId,
        task.title,
        task.goal,
        task.status,
        task.brainRef ?? null,
        task.createdBy,
        task.triggerId ?? null,
        task.background ? 1 : 0,
        null,
        null,
        null,
        now,
        now,
      );
    this.bus.emit("task.updated", task);
    return task;
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare("select * from tasks where id = ?").get(id);
    return r ? taskFrom(r) : undefined;
  }

  listTasks(opts: { status?: TaskStatus[]; limit?: number } = {}): Task[] {
    const limit = opts.limit ?? 200;
    if (opts.status?.length) {
      const q = `select * from tasks where status in (${opts.status.map(() => "?").join(",")}) order by created_at desc limit ?`;
      return this.db.prepare(q).all(...opts.status, limit).map(taskFrom);
    }
    return this.db.prepare("select * from tasks order by created_at desc limit ?").all(limit).map(taskFrom);
  }

  updateTask(id: string, patch: Partial<Pick<Task, "status" | "brainRef" | "result" | "error" | "resumeAt" | "title">>): Task | undefined {
    const cols: Record<string, string> = { status: "status", brainRef: "brain_ref", result: "result", error: "error", resumeAt: "resume_at", title: "title" };
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) this.db.prepare(`update tasks set ${col} = ? where id = ?`).run((patch as any)[k] ?? null, id);
    }
    this.db.prepare("update tasks set updated_at = ? where id = ?").run(nowIso(), id);
    const t = this.getTask(id);
    if (t) this.bus.emit("task.updated", t);
    return t;
  }

  // ---------- brain sessions ----------

  createSession(s: { conversationId: string; taskId?: string; agentId: string; brainRef: string; background: boolean; tainted?: boolean }): { row: SessionRow; token: string } {
    const id = newId("s_");
    const token = randomBytes(32).toString("base64url");
    const now = nowIso();
    this.db
      .prepare(
        "insert into sessions(id, conversation_id, task_id, agent_id, brain_ref, resume_token, tainted, status, background, token_hash, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, s.conversationId, s.taskId ?? null, s.agentId, s.brainRef, null, s.tainted ? 1 : 0, "active", s.background ? 1 : 0, hashToken(token), now, now);
    return { row: this.getSession(id)!, token };
  }

  /** Issue a fresh MCP token for an existing session (tokens are not stored in plain text). */
  rotateSessionToken(id: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("update sessions set token_hash = ?, updated_at = ? where id = ?").run(hashToken(token), nowIso(), id);
    return token;
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare("select * from sessions where id = ?").get(id);
    return r ? sessionFrom(r) : undefined;
  }

  sessionByToken(token: string): SessionRow | undefined {
    const r = this.db.prepare("select * from sessions where token_hash = ? and status = 'active'").get(hashToken(token));
    return r ? sessionFrom(r) : undefined;
  }

  activeSession(conversationId: string, agentId: string): SessionRow | undefined {
    const r = this.db
      .prepare("select * from sessions where conversation_id = ? and agent_id = ? and status = 'active' order by created_at desc limit 1")
      .get(conversationId, agentId);
    return r ? sessionFrom(r) : undefined;
  }

  updateSession(id: string, patch: { resumeToken?: string | null; tainted?: boolean; status?: SessionRow["status"]; brainRef?: string }): void {
    if (patch.resumeToken !== undefined) this.db.prepare("update sessions set resume_token = ? where id = ?").run(patch.resumeToken, id);
    if (patch.tainted !== undefined) this.db.prepare("update sessions set tainted = ? where id = ?").run(patch.tainted ? 1 : 0, id);
    if (patch.status) this.db.prepare("update sessions set status = ? where id = ?").run(patch.status, id);
    if (patch.brainRef) this.db.prepare("update sessions set brain_ref = ? where id = ?").run(patch.brainRef, id);
    this.db.prepare("update sessions set updated_at = ? where id = ?").run(nowIso(), id);
  }
}
