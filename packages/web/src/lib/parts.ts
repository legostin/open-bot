// Group message parts for rendering: a tool_call is shown together with its tool_result.

import type { MessagePart } from "@owlbot/shared";

export type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
export type ToolResultPart = Extract<MessagePart, { type: "tool_result" }>;

export type RenderItem =
  | { kind: "part"; part: Exclude<MessagePart, ToolCallPart | ToolResultPart>; key: string }
  | { kind: "tool"; call: ToolCallPart; result?: ToolResultPart; key: string }
  | { kind: "orphan_result"; result: ToolResultPart; key: string };

export function groupParts(parts: MessagePart[]): RenderItem[] {
  const results = new Map<string, ToolResultPart>();
  const calls = new Set<string>();
  for (const p of parts) {
    if (p.type === "tool_result") results.set(p.id, p);
    if (p.type === "tool_call") calls.add(p.id);
  }
  const out: RenderItem[] = [];
  parts.forEach((p, i) => {
    if (p.type === "tool_call") out.push({ kind: "tool", call: p, result: results.get(p.id), key: `tool-${p.id}-${i}` });
    else if (p.type === "tool_result") {
      if (!calls.has(p.id)) out.push({ kind: "orphan_result", result: p, key: `res-${p.id}-${i}` });
    } else out.push({ kind: "part", part: p, key: `${p.type}-${i}` });
  });
  return out;
}

/** Pretty JSON for tool inputs; strings that contain JSON are parsed first. */
export function prettyJson(v: unknown): string {
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return v;
      }
    }
    return v;
  }
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** One-line preview of a tool input, e.g. `url: "https://…", query: "x"`. */
export function inputPreview(v: unknown, max = 90): string {
  let s: string;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    s = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${typeof val === "string" ? JSON.stringify(val) : JSON.stringify(val) ?? String(val)}`)
      .join(", ");
  } else s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
