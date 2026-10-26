// Drafts of new agents shown as cards in the chat. Loaded when a card first renders, kept live by agent_draft.updated.

import { useEffect } from "react";
import type { AgentAvatar, AgentDef, AgentDraft } from "@owlbot/shared";
import { api, ApiError } from "../lib/api";
import { createStore, useStore } from "../lib/store";
import { hubEvents, reconnected, refreshAgents, refreshTeam } from "./app";

/** "missing": the hub no longer has it (another install's history, a wiped database). */
type Entry = AgentDraft | "missing";

const drafts = createStore<Record<string, Entry>>({});
const loading = new Set<string>();
let wired = false;

function put(d: AgentDraft): void {
  drafts.set((all) => ({ ...all, [d.id]: d }));
}

function load(id: string): void {
  if (loading.has(id)) return;
  loading.add(id);
  api
    .get<AgentDraft>(`/api/agent-drafts/${encodeURIComponent(id)}`)
    .then(put)
    .catch((e) => {
      if (e instanceof ApiError && e.status === 404) drafts.set((all) => ({ ...all, [id]: "missing" }));
    })
    .finally(() => loading.delete(id));
}

function wire(): void {
  if (wired) return;
  wired = true;
  hubEvents.on((e) => {
    if (e.type === "agent_draft.updated") put(e.data);
  });
  reconnected.on(() => {
    for (const [id, d] of Object.entries(drafts.get())) if (d !== "missing" && d.status === "draft") load(id);
  });
}

export function useAgentDraft(id: string): Entry | undefined {
  const all = useStore(drafts);
  useEffect(() => {
    wire();
    if (!drafts.get()[id]) load(id);
  }, [id]);
  return all[id];
}

export async function updateDraft(id: string, patch: { avatar?: AgentAvatar; initiative?: 0 | 1 | 2 }): Promise<void> {
  put(await api.patch<AgentDraft>(`/api/agent-drafts/${encodeURIComponent(id)}`, patch));
}

export async function createFromDraft(id: string): Promise<AgentDef> {
  const r = await api.post<{ draft: AgentDraft; agent: AgentDef }>(`/api/agent-drafts/${encodeURIComponent(id)}/create`, {});
  put(r.draft);
  await Promise.all([refreshAgents(), refreshTeam()]);
  return r.agent;
}
