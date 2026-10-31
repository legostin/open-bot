// The team in the sidebar: order, and the route of each agent's dialog.

import type { AgentDef, TeamMember } from "@piomio/shared";

export interface TeamEntry {
  agent: Pick<AgentDef, "id" | "name">;
  member?: TeamMember;
}

/** The default agent first, then whoever talked last; agents with an empty dialog by name. */
export function teamOrder<E extends TeamEntry>(entries: E[], defaultAgent: string | undefined): E[] {
  const activity = (e: TeamEntry) => (e.member?.lastMessage ? e.member.lastActivityAt : "");
  return entries.slice().sort((a, b) => {
    if (a.agent.id === defaultAgent) return -1;
    if (b.agent.id === defaultAgent) return 1;
    const x = activity(a);
    const y = activity(b);
    if (x !== y) return x < y ? 1 : -1;
    return a.agent.name.localeCompare(b.agent.name);
  });
}

/** The route of an agent's dialog: "/" for the default agent. */
export function agentPath(agentId: string, defaultAgent: string | undefined): string {
  return agentId === defaultAgent ? "/" : `/agent/${encodeURIComponent(agentId)}`;
}

/** Whose dialog a route shows, if any. */
export function agentForPath(path: string, defaultAgent: string | undefined): string | undefined {
  if (path === "/" || path === "") return defaultAgent;
  const m = /^\/agent\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// ---------- group chats ----------

/** The route of a group chat. */
export function groupPath(conversationId: string): string {
  return `/chat/${encodeURIComponent(conversationId)}`;
}

/** Which conversation a "/chat/:id" route shows, if any. */
export function chatForPath(path: string): string | undefined {
  const m = /^\/chat\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The latest activity first. */
export function groupOrder<G extends { lastActivityAt: string; title: string }>(groups: G[]): G[] {
  return groups.slice().sort((a, b) => (a.lastActivityAt !== b.lastActivityAt ? (a.lastActivityAt < b.lastActivityAt ? 1 : -1) : a.title.localeCompare(b.title)));
}

/** A title for a group nobody named: the first members' names, "+N" for the rest. */
export function suggestedTitle(names: string[], shown = 3): string {
  const head = names.slice(0, shown).join(", ");
  return names.length > shown ? `${head} +${names.length - shown}` : head;
}
