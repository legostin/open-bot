// New agents put together in the chat. The default agent starts a draft from what the user said (a name, then a
// description and instructions it writes itself); the user adjusts it in words or in the card (look, proactivity).
// Nothing joins the team until the draft is created (Hub.createAgentFromDraft).

import type { AgentDraft } from "@owlbot/shared";
import { defaultAvatar, newId, nowIso, parseAvatar } from "@owlbot/shared";
import type { Db } from "./db.ts";
import { json } from "./db.ts";
import type { EventBus } from "./bus.ts";
import { LocalizedError } from "./i18n.ts";

export type DraftPatch = Partial<Pick<AgentDraft, "name" | "description" | "prompt" | "avatar" | "initiative" | "brains">>;
type DraftField = keyof DraftPatch;

const LIMITS = { name: 60, description: 600, prompt: 12_000 } as const;

/** The fields of untrusted input (a tool call, an API body) that may change, checked. Unknown keys are ignored. */
export function draftPatch(input: Record<string, unknown>, allowed: readonly DraftField[] = ["name", "description", "prompt", "avatar", "initiative", "brains"]): DraftPatch {
  const out: DraftPatch = {};
  const has = (k: DraftField) => allowed.includes(k) && input[k] !== undefined && input[k] !== null;
  for (const k of ["name", "description", "prompt"] as const) {
    if (!has(k)) continue;
    const v = String(input[k]).trim();
    if (k === "name" && !v) throw new LocalizedError("agentDraft.nameRequired", undefined, 400);
    if (v.length > LIMITS[k]) throw new LocalizedError("agentDraft.tooLong", { field: k, max: LIMITS[k] }, 400);
    out[k] = v;
  }
  if (has("avatar")) {
    const a = parseAvatar(input.avatar);
    if (!a) throw new LocalizedError("agentDraft.badAvatar", undefined, 400);
    out.avatar = a;
  }
  if (has("initiative")) {
    const n = Number(input.initiative);
    if (n !== 0 && n !== 1 && n !== 2) throw new LocalizedError("agentDraft.badInitiative", undefined, 400);
    out.initiative = n;
  }
  if (has("brains")) {
    if (!Array.isArray(input.brains)) throw new LocalizedError("agentDraft.badBrains", undefined, 400);
    out.brains = input.brains.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

interface Deps {
  db: Db;
  bus: EventBus;
}

export class AgentDrafts {
  private d: Deps;

  constructor(d: Deps) {
    this.d = d;
  }

  create(input: DraftPatch & { conversationId: string; name: string; brains: string[] }): AgentDraft {
    const id = newId("ad_");
    const now = nowIso();
    const draft: AgentDraft = {
      id,
      conversationId: input.conversationId,
      name: input.name,
      description: input.description ?? "",
      prompt: input.prompt ?? "",
      avatar: input.avatar ?? defaultAvatar(id),
      ...(input.initiative !== undefined ? { initiative: input.initiative } : {}),
      brains: input.brains,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.d.db
      .prepare("insert into agent_drafts(id, conversation_id, data, status, agent_id, created_at, updated_at) values (?,?,?,?,?,?,?)")
      .run(id, draft.conversationId, JSON.stringify(dataOf(draft)), draft.status, null, now, now);
    this.d.bus.emit("agent_draft.updated", draft);
    return draft;
  }

  get(id: string): AgentDraft | undefined {
    const r: any = this.d.db.prepare("select * from agent_drafts where id = ?").get(id);
    if (!r) return undefined;
    const data = json<Record<string, unknown>>(r.data, {});
    return {
      id: r.id,
      conversationId: r.conversation_id,
      name: String(data.name ?? ""),
      description: String(data.description ?? ""),
      prompt: String(data.prompt ?? ""),
      avatar: parseAvatar(data.avatar) ?? defaultAvatar(r.id),
      ...(data.initiative === 0 || data.initiative === 1 || data.initiative === 2 ? { initiative: data.initiative } : {}),
      brains: Array.isArray(data.brains) ? data.brains.map(String) : [],
      status: r.status === "created" ? "created" : "draft",
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** A draft that is still a draft, or a localized error for the API and the tool. */
  open(id: string): AgentDraft {
    const d = this.get(id);
    if (!d) throw new LocalizedError("agentDraft.notFound", undefined, 404);
    if (d.status === "created") throw new LocalizedError("agentDraft.alreadyCreated", { name: d.name }, 409);
    return d;
  }

  update(id: string, patch: DraftPatch): AgentDraft {
    const next: AgentDraft = { ...this.open(id), ...patch, updatedAt: nowIso() };
    this.d.db.prepare("update agent_drafts set data = ?, updated_at = ? where id = ?").run(JSON.stringify(dataOf(next)), next.updatedAt, id);
    this.d.bus.emit("agent_draft.updated", next);
    return next;
  }

  markCreated(id: string, agentId: string): AgentDraft {
    const now = nowIso();
    this.d.db.prepare("update agent_drafts set status = 'created', agent_id = ?, updated_at = ? where id = ?").run(agentId, now, id);
    const d = this.get(id)!;
    this.d.bus.emit("agent_draft.updated", d);
    return d;
  }
}

function dataOf(d: AgentDraft): Record<string, unknown> {
  return { name: d.name, description: d.description, prompt: d.prompt, avatar: d.avatar, initiative: d.initiative, brains: d.brains };
}
