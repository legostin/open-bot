// How the agents think on this hub (AgentDef.thinking): what each kind of work comes to on the brains that are here,
// for the header picker, the chat card and the phone, and the change they make.

import type { AgentDef, ProbeResult, WorkKind } from "@owlbot/shared";
import {
  brainsFor,
  expandBrains,
  formatBrainRef,
  parseBrainRef,
  patchChoice,
  resolveThinking,
  sameBrain,
  thinkingFor,
  withChoice,
  WORK_KINDS,
  type ThinkingBrain,
  type ThinkingPatch,
  type ThinkingView,
} from "@owlbot/shared";
import type { BrainRegistry } from "./brains.ts";
import type { Db } from "./db.ts";

const norm = (ref: string) => formatBrainRef(parseBrainRef(ref));

/** Brains over a limit now, by ref. */
export function limitedBrains(db: Db): Set<string> {
  const rows = db.prepare("select brain_ref, until from brain_limits").all() as Array<{ brain_ref: string; until: string }>;
  return new Set(rows.filter((r) => Date.parse(r.until) > Date.now()).map((r) => r.brain_ref));
}

export async function thinkingView(brains: BrainRegistry, db: Db, agent: AgentDef): Promise<ThinkingView> {
  const listed = brains.list();
  const refs: string[] = [];
  const add = (r: string) => {
    const k = norm(r);
    if (!refs.includes(k)) refs.push(k);
  };
  for (const k of WORK_KINDS) for (const r of expandBrains(brainsFor(agent, k), listed.map((b) => b.ref))) add(r);
  for (const b of listed) add(b.ref);
  const limited = limitedBrains(db);
  const probes = new Map<string, ProbeResult | undefined>();
  const options: ThinkingBrain[] = await Promise.all(
    refs.map(async (ref) => {
      const b = listed.find((x) => x.ref === ref);
      const probe = b ? await brains.probe(ref, 5 * 60_000).catch(() => undefined) : undefined;
      probes.set(ref, probe);
      return {
        ref,
        label: b?.label ?? ref,
        ready: !!b && !!probe?.available && !!probe.authenticated && !limited.has(ref),
        models: (probe?.models ?? []).map((id) => ({ id, name: probe?.modelNames?.[id] ?? id })),
        ...(probe?.model ? { model: probe.model } : {}),
        efforts: probe?.efforts ?? [],
        presets: probe?.presets ?? {},
      };
    }),
  );
  const ready = new Set(options.filter((o) => o.ready).map((o) => o.ref));
  const kinds = WORK_KINDS.map((kind) => {
    const choice = thinkingFor(agent, kind);
    const order = expandBrains(brainsFor(agent, kind), listed.map((b) => b.ref)).map(norm);
    const brain = order.find((r) => ready.has(r)) ?? order[0];
    const own = agent.thinking?.[kind];
    return { kind, ...(own ? { own } : {}), choice, ...(brain ? { brain } : {}), ...(brain ? resolveThinking(choice, brain, probes.get(brain), agent.model) : {}) };
  });
  return { agentId: agent.id, kinds, brains: options };
}

/**
 * The agent with one kind's choice changed. An exact model or effort is for the brain it was chosen on (`brain`, the
 * kind's brain now); in the chat a new brain also moves to the front of the agent's order, and a new depth replaces
 * the agent-wide `model` from before.
 */
export function applyThinking(agent: AgentDef, kind: WorkKind, patch: ThinkingPatch, brainNow?: string): AgentDef {
  let next = patchChoice(agent.thinking?.[kind], patch);
  if (next && (next.model || next.effort) && !next.brain && brainNow) next = { ...next, brain: brainNow };
  const brains = kind === "chat" && patch.brain ? [patch.brain, ...agent.brains.filter((b) => !sameBrain(b, patch.brain!))] : agent.brains;
  const depth = kind === "chat" && (patch.follow || patch.preset || patch.model !== undefined || patch.effort !== undefined);
  return { ...agent, brains, thinking: withChoice(agent.thinking, kind, next), model: depth ? undefined : agent.model };
}

/** What a kind comes to, in a line for the model (tool results). */
export function describeKind(view: ThinkingView, kind: WorkKind): string {
  const k = view.kinds.find((x) => x.kind === kind)!;
  const b = view.brains.find((x) => x.ref === k.brain);
  const model = k.model ? (b?.models.find((m) => m.id === k.model)?.name ?? k.model) : (b?.model ?? "its default model");
  const how = [`model ${model}`, k.effort ? `effort ${k.effort}` : "", k.preset ? `the "${k.preset}" preset` : k.own || kind === "chat" ? "" : "same as the chat"].filter(Boolean).join(", ");
  return `${kind}: ${b?.label ?? k.brain ?? "no brain"} (${how})`;
}
