// Setup chats: "New channel" and "Add agent" open a short chat with the default agent, which asks at once (the hub
// writes its first question, so the answer is instant) and makes the thing from the talk. The chat then becomes what
// it made: a channel keeps it as its settings chat, a new agent's dialog takes over. Chats that made nothing go after
// a day.
import type { AgentDraft, Conversation, Locale, SetupPurpose } from "@owlbot/shared";
import type { Store } from "./store.ts";
import type { EventBus } from "./bus.ts";
import type { Settings } from "./settings.ts";
import { tFor } from "./i18n.ts";

const ABANDONED_MS = 24 * 3600_000;

export class SetupChats {
  store: Store;
  settings: Settings;

  constructor(d: { store: Store; bus: EventBus; settings: Settings }) {
    this.store = d.store;
    this.settings = d.settings;
    // A new agent made from a draft in an "Add agent" chat: the chat became that agent.
    d.bus.on("agent_draft.updated", (draft: AgentDraft) => {
      if (draft.status !== "created" || !draft.agentId) return;
      const conv = this.store.getConversation(draft.conversationId);
      if (conv?.kind === "setup" && conv.purpose === "agent" && !conv.entity) this.store.setEntity(conv.id, draft.agentId);
    });
  }

  /** A new setup chat with the agent's first question in it. */
  start(purpose: SetupPurpose, locale: Locale): Conversation {
    const t = tFor(locale);
    const agentId = this.settings.get().defaultAgent;
    const conv = this.store.createConversation({ kind: "setup", purpose, title: t(`setup.${purpose}.title`), agentId });
    this.store.addMessage({ conversationId: conv.id, role: "assistant", agentId, parts: [{ type: "text", text: t(`setup.${purpose}.ask`) }], status: "complete" });
    return this.store.getConversation(conv.id)!;
  }

  /** Setup chats that made nothing and were left a day ago. */
  sweep(now = Date.now()): number {
    const old = new Date(now - ABANDONED_MS).toISOString();
    const rows = this.store.db.prepare("select id from conversations where kind = 'setup' and entity is null and updated_at < ?").all(old) as Array<{ id: string }>;
    for (const r of rows) {
      this.store.db.prepare("delete from messages where conversation_id = ?").run(r.id);
      this.store.db.prepare("delete from sessions where conversation_id = ?").run(r.id);
      this.store.db.prepare("delete from conversations where id = ?").run(r.id);
    }
    return rows.length;
  }
}
