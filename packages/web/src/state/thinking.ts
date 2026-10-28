// How each agent thinks (GET /api/agents/:id/thinking): what every kind of work comes to on the brains here, for the
// header picker and the chat card. Refreshed when agents or brains change (sign-ins, limits, another tab's choice).

import type { ThinkingPatch, ThinkingView, WorkKind } from "@owlbot/shared";
import { api } from "../lib/api";
import { createStore } from "../lib/store";
import { hubEvents, refreshAgents, reconnected } from "./app";
import { t, type MessageKey } from "../i18n";

export const thinking = createStore<Record<string, ThinkingView>>({});

const loading = new Map<string, Promise<void>>();
let wired = false;

export function refreshThinking(agentId: string): Promise<void> {
  const running = loading.get(agentId);
  if (running) return running;
  const p = api
    .get<ThinkingView>(`/api/agents/${encodeURIComponent(agentId)}/thinking`)
    .then((v) => thinking.set((all) => ({ ...all, [agentId]: v })))
    .catch(() => {})
    .finally(() => loading.delete(agentId));
  loading.set(agentId, p);
  return p;
}

export function ensureThinking(agentId: string): void {
  if (!wired) {
    wired = true;
    const again = () => {
      for (const id of Object.keys(thinking.get())) void refreshThinking(id);
    };
    hubEvents.on((e) => {
      if (e.type === "agents.updated" || e.type === "brains.updated" || e.type === "plugins.updated") again();
    });
    reconnected.on(again);
  }
  if (!thinking.get()[agentId]) void refreshThinking(agentId);
}

/** Change how the agent thinks for one kind of work; the view comes back current. */
export async function setThinking(agentId: string, kind: WorkKind, patch: ThinkingPatch): Promise<ThinkingView> {
  const v = await api.put<ThinkingView>(`/api/agents/${encodeURIComponent(agentId)}/thinking/${kind}`, patch);
  thinking.set((all) => ({ ...all, [agentId]: v }));
  // The brain order may have changed with it (the header's brain).
  void refreshAgents().catch(() => {});
  return v;
}

const EFFORT_KEYS: Record<string, MessageKey> = {
  none: "thinking.effortName.none",
  minimal: "thinking.effortName.minimal",
  low: "thinking.effortName.low",
  medium: "thinking.effortName.medium",
  high: "thinking.effortName.high",
  xhigh: "thinking.effortName.xhigh",
  max: "thinking.effortName.max",
  ultra: "thinking.effortName.ultra",
};

/** An effort as people read it ("extra high"); an effort we do not know by its own name. */
export function effortName(effort: string): string {
  const key = EFFORT_KEYS[effort];
  return key ? t(key) : effort;
}

/** A model's name on its brain ("Opus"), or the id itself. */
export function modelName(v: ThinkingView | undefined, brain: string | undefined, model: string | undefined): string | undefined {
  if (!model) return undefined;
  return v?.brains.find((b) => b.ref === brain)?.models.find((m) => m.id === model)?.name ?? model;
}

/** "Opus · high effort", "Opus", "medium effort" or undefined: what a model and an effort come to. */
export function describeThinking(v: ThinkingView | undefined, brain: string | undefined, model: string | undefined, effort: string | undefined): string | undefined {
  const name = modelName(v, brain, model ?? v?.brains.find((b) => b.ref === brain)?.model);
  if (name && effort) return t("thinking.modelEffort", { model: name, effort: effortName(effort) });
  if (effort) return t("thinking.effortOnly", { effort: effortName(effort) });
  return name;
}
