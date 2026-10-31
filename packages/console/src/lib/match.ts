// Client-side port of the rule matcher (packages/core/src/policy/engine.ts + shared util),
// used to preview whether a rule being edited matches the approval it comes from.
// The server remains the authority; keep this in sync with the engine.

import type { RuleCondition } from "../types.ts";

export function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith("." + base);
  }
  return h === p;
}

export function getField(input: unknown, path: string): unknown {
  let v: any = input;
  for (const k of path.split(".")) v = v?.[k];
  return v;
}

export function conditionMatches(c: RuleCondition, input: unknown): boolean {
  const raw = getField(input, c.field);
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.every((v) => v === undefined || v === null)) return false;
  return values.every((v) => {
    if (c.op === "max") {
      // A finite number, or a string that is just one ("2400"), no larger than the limit.
      const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
      return Number.isFinite(n) && n <= c.value;
    }
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
      default:
        return false;
    }
  });
}

export function ruleMatchesInput(rule: { tool: string; agentId?: string; conditions: RuleCondition[] }, tool: string, agentId: string, input: unknown): boolean {
  if (!globToRegExp(rule.tool).test(tool)) return false;
  if (rule.agentId && rule.agentId !== agentId) return false;
  return rule.conditions.every((c) => conditionMatches(c, input));
}

/** Top-level and nested scalar field paths of a tool input, for the conditions builder. */
export function fieldPaths(input: unknown, prefix = "", depth = 0): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input) || depth > 3) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...fieldPaths(v, p, depth + 1));
    else out.push(p);
  }
  return out;
}
