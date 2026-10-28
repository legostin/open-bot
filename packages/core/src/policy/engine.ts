// Policy decisions for tool calls. Pure functions: easy to test, no I/O.

import type { PolicyDecision, Rule, RuleCondition, ToolDescriptor } from "@owlbot/shared";
import { globToRegExp, hostMatches, hostOf } from "@owlbot/shared";
import { t } from "../i18n.ts";

export interface PolicyInput {
  tool: ToolDescriptor;
  input: unknown;
  agentId: string;
  tainted: boolean;
  background: boolean;
  initiative: 0 | 1 | 2;
  profile: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  ruleId?: string;
}

/** Tools background tasks may always use regardless of effect. */
// memory_remember: the nightly reflection is a background task; a remembered fact is local, shown and undoable.
export const BACKGROUND_ALWAYS_ALLOWED = ["notify", "task_status", "skill_load", "vault_list", "memory_search", "memory_read", "memory_list", "memory_remember", "feed_post", "feed_sources", "feed_update"];

function getField(input: unknown, path: string): unknown {
  let v: any = input;
  for (const k of path.split(".")) v = v?.[k];
  return v;
}

export function conditionMatches(c: RuleCondition, input: unknown): boolean {
  const raw = getField(input, c.field);
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.every((v) => v === undefined || v === null)) return false;
  return values.every((v) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    switch (c.op) {
      case "eq":
        return s === c.value;
      case "glob":
        return globToRegExp(c.value).test(s);
      case "domain": {
        const host = s.includes("@") && !s.includes("/") ? s.split("@").pop()!.toLowerCase() : hostOf(s.includes("://") ? s : `https://${s}`);
        return !!host && (hostMatches(host, c.value) || hostMatches(host, "*." + c.value.replace(/^\*\./, "")));
      }
    }
  });
}

export function ruleMatches(rule: Rule, tool: string, agentId: string, input: unknown): boolean {
  if (!globToRegExp(rule.tool).test(tool)) return false;
  if (rule.agentId && rule.agentId !== agentId) return false;
  return rule.conditions.every((c) => conditionMatches(c, input));
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Recipients and domains an action reaches: used to decide whether a tainted session may rely on "always" rules. */
export function extractTargets(input: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.match(EMAIL_RE) ?? []) out.add(m.toLowerCase());
      for (const m of v.match(URL_RE) ?? []) {
        const h = hostOf(m);
        if (h) out.add(h);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return [...out];
}

export function decide(p: PolicyInput, rules: Rule[], isKnownTarget: (t: string) => boolean): PolicyResult {
  const { tool, input, agentId } = p;

  for (const r of rules) {
    if (r.decision === "deny" && ruleMatches(r, tool.name, agentId, input)) {
      return { decision: "deny", reason: r.note ? t("policy.deniedByRuleNote", { note: r.note }) : t("policy.deniedByRule"), ruleId: r.id };
    }
  }

  if (p.background && p.initiative < 2 && tool.effect !== "read" && !BACKGROUND_ALWAYS_ALLOWED.includes(tool.name)) {
    return { decision: "deny", reason: t("policy.backgroundReadOnly") };
  }

  if (tool.effect === "read") return { decision: "allow", reason: t("policy.read") };
  if (tool.effect === "local-write") {
    if (p.profile === "strict") return { decision: "ask", reason: t("policy.strictLocalWrite") };
    // Changes that outlive the session (tool.askWhenTainted) need the user's yes after outside content; a call with no input only reads.
    const changes = !!input && typeof input === "object" && Object.keys(input).length > 0;
    if (p.tainted && changes && tool.askWhenTainted) return { decision: "ask", reason: t("policy.taintedLastingChange") };
    return { decision: "allow", reason: t("policy.localWrite") };
  }

  // external
  for (const r of rules) {
    if (r.decision === "allow" && ruleMatches(r, tool.name, agentId, input)) {
      if (p.tainted) {
        const unknown = extractTargets(input).filter((t) => !isKnownTarget(t));
        if (unknown.length > 0) {
          return { decision: "ask", reason: t("policy.taintedNewTargets", { targets: unknown.join(", ") }), ruleId: r.id };
        }
      }
      return { decision: "allow", reason: r.note ? t("policy.allowedByRuleNote", { note: r.note }) : t("policy.allowedByRule"), ruleId: r.id };
    }
  }
  return { decision: "ask", reason: t("policy.externalNeedsApproval") };
}

/** Build a rule that would allow this exact kind of action next time ("always for this"). */
export function suggestRule(tool: string, input: unknown, agentId?: string): Omit<Rule, "id" | "createdAt" | "createdVia"> {
  const conditions: RuleCondition[] = [];
  const targets = extractTargets(input);
  // Prefer narrowing by recipients/domains found in well-known fields.
  const fields = ["to", "recipient", "email", "chat", "chatId", "channel", "url", "domain", "host"];
  for (const f of fields) {
    const v = getField(input, f);
    if (typeof v === "string" && v) {
      const isUrl = v.includes("://");
      conditions.push(isUrl ? { field: f, op: "domain", value: hostOf(v) } : { field: f, op: "eq", value: v });
    }
  }
  if (conditions.length === 0 && targets.length === 1) {
    // Fall back to nothing specific: allow the tool for this agent only.
  }
  return { tool, agentId, conditions, decision: "allow" };
}
