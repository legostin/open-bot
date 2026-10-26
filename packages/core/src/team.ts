// The user's team: every agent with its one long-lived dialog, as the web sidebar shows it.
// Changes in a dialog (new or finished messages, turns starting and ending, the read marker) go out as "team.updated".

import type { Conversation, Message, TeamMember } from "@owlbot/shared";
import { truncate } from "@owlbot/shared";
import type { Store } from "./store.ts";
import type { EventBus } from "./bus.ts";

const PREVIEW_CHARS = 160;
/** How far back to look for a message with something to preview (tool-only replies have none). */
const PREVIEW_LOOKBACK = 10;

/** Short plain text of a message for the sidebar, or "" when it has nothing to show. */
export function previewText(m: Message): string {
  const out: string[] = [];
  for (const p of m.parts) {
    // Text in system messages is a note for the model ("[System] …"); errors in them are for the user.
    if (p.type === "text" && m.role !== "system") out.push(p.text);
    else if (p.type === "notification") out.push(p.title);
    else if (p.type === "error") out.push(p.message);
    else if (p.type === "attachment") out.push(p.name);
  }
  const text = out
    .join("\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]+|^#+\s*|^>\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text, PREVIEW_CHARS);
}

export class Team {
  private store: Store;
  private agents: { list(): Array<{ id: string }> };
  private bus: EventBus;
  private isRunning: (conversationId: string) => boolean;
  private pending = new Set<string>();

  constructor(d: { store: Store; agents: { list(): Array<{ id: string }> }; bus: EventBus; isRunning: (conversationId: string) => boolean }) {
    this.store = d.store;
    this.agents = d.agents;
    this.bus = d.bus;
    this.isRunning = d.isRunning;
    d.bus.on("message.created", (m: Message) => this.changed(m.conversationId));
    d.bus.on("message.updated", (m: Message) => {
      if (m.status !== "streaming") this.changed(m.conversationId);
    });
    d.bus.on("conversation.activity", (a) => this.changed(a.conversationId));
  }

  /** Every agent with its dialog (created for agents that have none yet). */
  list(): TeamMember[] {
    return this.agents.list().map((a) => this.memberOf(this.store.agentConversation(a.id)));
  }

  member(agentId: string): TeamMember {
    return this.memberOf(this.store.agentConversation(agentId));
  }

  /** The user has seen the dialog up to `at` (a message's createdAt; default: now). */
  markRead(conversationId: string, at?: string): void {
    this.store.markRead(conversationId, at);
    this.changed(conversationId);
  }

  memberOf(conv: Conversation): TeamMember {
    const recent = this.store.listMessages(conv.id, { limit: PREVIEW_LOOKBACK });
    let lastMessage: TeamMember["lastMessage"];
    for (let i = recent.length - 1; i >= 0 && !lastMessage; i--) {
      const text = previewText(recent[i]);
      if (text) lastMessage = { role: recent[i].role, text, createdAt: recent[i].createdAt };
    }
    return {
      agentId: conv.agentId,
      conversationId: conv.id,
      lastMessage,
      lastActivityAt: conv.updatedAt,
      running: this.isRunning(conv.id),
      unread: this.store.unreadCount(conv.id),
    };
  }

  /** Push the dialog's new state after the events of this tick, so clients get the message itself first. */
  private changed(conversationId: string): void {
    if (!this.pending.size) setImmediate(() => this.flush());
    this.pending.add(conversationId);
  }

  private flush(): void {
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) {
      try {
        const conv = this.store.getConversation(id);
        if (conv?.kind === "main") this.bus.emit("team.updated", this.memberOf(conv));
      } catch {
        /* the hub is stopping: the database is closed */
      }
    }
  }
}
