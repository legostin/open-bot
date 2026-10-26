import type { Rule } from "@owlbot/shared";
import { newId, nowIso } from "@owlbot/shared";
import { json, type Db } from "../db.ts";

const fromRow = (r: any): Rule => ({
  id: r.id,
  tool: r.tool,
  agentId: r.agent_id ?? undefined,
  conditions: json(r.conditions, []),
  decision: r.decision,
  note: r.note ?? undefined,
  createdAt: r.created_at,
  createdVia: r.created_via,
});

export class RuleStore {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(): Rule[] {
    return this.db.prepare("select * from rules order by created_at desc").all().map(fromRow);
  }

  get(id: string): Rule | undefined {
    const r = this.db.prepare("select * from rules where id = ?").get(id);
    return r ? fromRow(r) : undefined;
  }

  create(r: Omit<Rule, "id" | "createdAt">): Rule {
    const rule: Rule = { ...r, id: newId("r_"), createdAt: nowIso() };
    this.db
      .prepare("insert into rules(id, tool, agent_id, conditions, decision, note, created_at, created_via) values (?,?,?,?,?,?,?,?)")
      .run(rule.id, rule.tool, rule.agentId ?? null, JSON.stringify(rule.conditions), rule.decision, rule.note ?? null, rule.createdAt, rule.createdVia);
    return rule;
  }

  update(id: string, patch: Partial<Pick<Rule, "tool" | "agentId" | "conditions" | "decision" | "note">>): Rule | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare("update rules set tool = ?, agent_id = ?, conditions = ?, decision = ?, note = ? where id = ?")
      .run(next.tool, next.agentId ?? null, JSON.stringify(next.conditions), next.decision, next.note ?? null, id);
    return this.get(id);
  }

  remove(id: string): void {
    this.db.prepare("delete from rules where id = ?").run(id);
  }

  isKnownTarget(t: string): boolean {
    return !!this.db.prepare("select 1 from approved_targets where value = ?").get(t.toLowerCase());
  }

  addKnownTargets(targets: string[]): void {
    const st = this.db.prepare("insert or ignore into approved_targets(value, created_at) values (?, ?)");
    for (const t of targets) st.run(t.toLowerCase(), nowIso());
  }
}
