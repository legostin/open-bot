// The demo hub: a hub's state (the world) behind the API and the realtime socket the web UI talks to, all in this
// page. Routes answer from the world (routes.ts); the chapter scripts change it through the methods here, which push the
// same events a real hub would.

import type { Approval, Conversation, Feed, FeedPost, GroupChat, IntegrationView, Message, MessagePart, SecretRequest, TeamMember, UiEvent } from "@piomio/shared";
import type { ApiPeer } from "../shims";
import { iso, type World } from "../world";
import { Router } from "./router";
import type { DemoSocket, SocketPeer } from "./socket";

type Listener<T> = (v: T) => void;

/** The plain words of a message for a preview line, as the hub's team list shows it. */
function previewText(m: Message): string {
  const text = m.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

export class DemoHub implements ApiPeer, SocketPeer {
  world: World;
  readonly router: Router;
  private sockets = new Set<DemoSocket>();
  private posted: Array<Listener<Message>> = [];
  private pluginListeners: Array<(pluginId: string, payload: any) => void> = [];

  constructor(world: World, onUnknown?: (method: string, path: string) => void) {
    this.world = world;
    this.router = new Router(onUnknown);
  }

  // ----- transport -----

  handle(method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
    return this.router.handle(method, url, body);
  }

  connect(s: DemoSocket): void {
    this.sockets.add(s);
  }

  disconnect(s: DemoSocket): void {
    this.sockets.delete(s);
  }

  received(_s: DemoSocket, data: string): void {
    try {
      const msg = JSON.parse(data) as { type?: string; pluginId?: string; payload?: unknown };
      if (msg.type === "plugin.message" && msg.pluginId) for (const l of this.pluginListeners) l(msg.pluginId, msg.payload);
    } catch {
      /* not ours */
    }
  }

  emit(e: UiEvent): void {
    const data = JSON.stringify(e);
    for (const s of this.sockets) s.deliver(data);
  }

  onPluginMessage(cb: (pluginId: string, payload: any) => void): () => void {
    this.pluginListeners.push(cb);
    return () => (this.pluginListeners = this.pluginListeners.filter((x) => x !== cb));
  }

  pluginEvent(pluginId: string, channel: string, payload: unknown): void {
    this.emit({ type: "plugin.event", data: { pluginId, channel, payload } });
  }

  // ----- conversations and messages -----

  conversation(id: string): Conversation | undefined {
    return this.world.conversations.find((c) => c.id === id);
  }

  messagesOf(id: string): Message[] {
    return (this.world.messages[id] ??= []);
  }

  findMessage(id: string): Message | undefined {
    for (const list of Object.values(this.world.messages)) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    return undefined;
  }

  addMessage(m: Message): Message {
    this.messagesOf(m.conversationId).push(m);
    this.emit({ type: "message.created", data: m });
    this.touch(m.conversationId, m.createdAt);
    return m;
  }

  updateMessage(id: string, fn: (m: Message) => Message): Message | undefined {
    const m = this.findMessage(id);
    if (!m) return undefined;
    const list = this.messagesOf(m.conversationId);
    const next = fn(m);
    list[list.indexOf(m)] = next;
    this.emit({ type: "message.updated", data: next });
    this.changed(m.conversationId);
    return next;
  }

  /** Streamed text: extends the message's last text part (or starts one), as the hub's runner does. */
  delta(id: string, text: string): void {
    const m = this.findMessage(id);
    if (!m) return;
    const last = m.parts.at(-1);
    if (last?.type === "text") last.text += text;
    else m.parts.push({ type: "text", text });
    this.emit({ type: "message.delta", data: { id, conversationId: m.conversationId, delta: text } });
  }

  setRunning(conversationId: string, running: boolean): void {
    if (running) this.world.running.add(conversationId);
    else this.world.running.delete(conversationId);
    this.changed(conversationId);
  }

  /** The person's message as POSTed by the composer (or a quick reply): stored, pushed, and handed to the script. */
  userMessage(conversationId: string, text: string): Message {
    const m: Message = { id: `msg_${crypto.randomUUID().slice(0, 12)}`, conversationId, role: "user", parts: [{ type: "text", text }], status: "complete", channel: "web", createdAt: iso() };
    this.addMessage(m);
    this.markRead(conversationId, m.createdAt);
    const waiting = this.posted;
    this.posted = [];
    for (const l of waiting) l(m);
    return m;
  }

  /** The next message the person sends (the script waits for its own typing to arrive). */
  nextUserMessage(): Promise<Message> {
    return new Promise((resolve) => this.posted.push(resolve));
  }

  markRead(conversationId: string, at: string): void {
    const prev = this.world.readAt[conversationId];
    if (!prev || prev < at) this.world.readAt[conversationId] = at;
    this.changed(conversationId);
  }

  touch(conversationId: string, at: string): void {
    const c = this.conversation(conversationId);
    if (c && c.updatedAt < at) {
      c.updatedAt = at;
      this.emit({ type: "conversation.updated", data: c });
    }
    this.changed(conversationId);
  }

  // ----- approvals -----

  private approvalWaiters = new Map<string, Listener<{ status: "approved" | "denied"; remember: boolean }>>();

  /** An action that waits for the person: the card in its message and the count in the top bar. */
  raiseApproval(a: Approval): void {
    this.world.approvals.push(a);
    this.emit({ type: "approval.pending", data: { count: this.world.approvals.filter((x) => x.status === "pending").length } });
  }

  waitApproval(id: string): Promise<{ status: "approved" | "denied"; remember: boolean }> {
    const a = this.world.approvals.find((x) => x.id === id);
    if (a && a.status !== "pending") return Promise.resolve({ status: a.status === "denied" ? "denied" : "approved", remember: false });
    return new Promise((resolve) => this.approvalWaiters.set(id, resolve));
  }

  resolveApproval(id: string, status: "approved" | "denied", remember: boolean): void {
    const a = this.world.approvals.find((x) => x.id === id);
    if (!a || a.status !== "pending") return;
    a.status = status;
    a.resolvedAt = iso();
    a.resolvedVia = "web";
    for (const list of Object.values(this.world.messages))
      for (const m of list)
        if (m.parts.some((p) => p.type === "approval" && p.approvalId === id))
          this.updateMessage(m.id, (x) => ({ ...x, parts: x.parts.map((p) => (p.type === "approval" && p.approvalId === id ? { ...p, status } : p)) }));
    this.emit({ type: "approval.pending", data: { count: this.world.approvals.filter((x) => x.status === "pending").length } });
    const w = this.approvalWaiters.get(id);
    this.approvalWaiters.delete(id);
    w?.({ status, remember });
  }

  // ----- signals the scripts wait for -----

  private signals = new Map<string, Array<Listener<unknown>>>();

  /** Something the visitor's app did (a sign-in started, a secret saved) that a script may be waiting for. */
  signal(name: string, value?: unknown): void {
    const ls = this.signals.get(name) ?? [];
    this.signals.delete(name);
    for (const l of ls) l(value);
  }

  waitSignal<T = unknown>(name: string): Promise<T> {
    return new Promise((resolve) => {
      const ls = this.signals.get(name) ?? [];
      ls.push(resolve as Listener<unknown>);
      this.signals.set(name, ls);
    });
  }

  // ----- integrations, secrets, channels -----

  setIntegration(id: string, patch: Partial<IntegrationView>): void {
    const x = this.world.integrations.find((i) => i.id === id);
    if (!x) return;
    Object.assign(x, patch);
    this.emit({ type: "connections.updated", data: { provider: id } });
  }

  secretRequest(spec: Pick<SecretRequest, "vaultId" | "title" | "hint" | "conversationId">): SecretRequest {
    const r: SecretRequest = { id: `sr_${crypto.randomUUID().slice(0, 10)}`, status: "pending", createdAt: iso(), ...spec };
    this.world.secretRequests.push(r);
    this.emit({ type: "secret.request", data: r });
    return r;
  }

  saveSecret(id: string): SecretRequest | undefined {
    const r = this.world.secretRequests.find((x) => x.id === id);
    if (!r || r.status !== "pending") return r;
    r.status = "saved";
    r.exists = true;
    r.resolvedAt = iso();
    this.emit({ type: "secret.request", data: r });
    this.signal(`secret:${id}`);
    return r;
  }

  upsertFeed(f: Feed): void {
    const i = this.world.feeds.findIndex((x) => x.id === f.id);
    if (i < 0) this.world.feeds.push(f);
    else this.world.feeds[i] = f;
    this.emit({ type: "feed.updated", data: f });
  }

  post(p: FeedPost): void {
    this.world.posts.push(p);
    const f = this.world.feeds.find((x) => x.id === p.feedId);
    if (f) {
      f.unread += 1;
      f.lastPost = { title: p.title, createdAt: p.createdAt };
      f.updatedAt = p.createdAt;
    }
    this.emit({ type: "feed.post", data: p });
    if (f) this.emit({ type: "feed.updated", data: f });
  }

  // ----- the sidebar's view of the team -----

  private lastMessage(conversationId: string): GroupChat["lastMessage"] {
    const list = this.messagesOf(conversationId);
    for (let i = list.length - 1; i >= 0; i--) {
      const text = previewText(list[i]);
      if (text) return { role: list[i].role, text, createdAt: list[i].createdAt, ...(list[i].agentId ? { agentId: list[i].agentId } : {}) };
    }
    return undefined;
  }

  private unread(conversationId: string): number {
    const since = this.world.readAt[conversationId] ?? "";
    return this.messagesOf(conversationId).filter((m) => m.role !== "user" && m.createdAt > since && m.status !== "streaming").length;
  }

  memberOf(c: Conversation): TeamMember {
    const last = this.lastMessage(c.id);
    return {
      agentId: c.agentId,
      conversationId: c.id,
      ...(last ? { lastMessage: { role: last.role, text: last.text, createdAt: last.createdAt } } : {}),
      lastActivityAt: c.updatedAt,
      running: this.world.running.has(c.id),
      unread: this.unread(c.id),
    };
  }

  groupOf(c: Conversation): GroupChat {
    return {
      conversationId: c.id,
      title: c.title,
      members: c.members ?? [c.agentId],
      lastMessage: this.lastMessage(c.id),
      lastActivityAt: c.updatedAt,
      running: this.world.running.has(c.id),
      speaking: [],
      unread: this.unread(c.id),
    };
  }

  team(): TeamMember[] {
    return this.world.conversations.filter((c) => c.kind === "main").map((c) => this.memberOf(c));
  }

  groups(): GroupChat[] {
    return this.world.conversations.filter((c) => c.kind === "group").map((c) => this.groupOf(c));
  }

  private pending = new Set<string>();

  /** The sidebar's line for a dialog, after this tick's events (the message itself arrives first). */
  private changed(conversationId: string): void {
    if (!this.pending.size)
      queueMicrotask(() => {
        const ids = [...this.pending];
        this.pending.clear();
        for (const id of ids) {
          const c = this.conversation(id);
          if (c?.kind === "main") this.emit({ type: "team.updated", data: this.memberOf(c) });
          else if (c?.kind === "group") this.emit({ type: "group.updated", data: this.groupOf(c) });
        }
      });
    this.pending.add(conversationId);
  }
}
