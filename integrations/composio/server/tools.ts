// How a Composio tool becomes one of the agents' tools: its name (composio_<slug>, within 64 characters), what it does
// to the world (a read only when Composio tags it readOnlyHint; anything else asks), and its spec.

import { createHash } from "node:crypto";
import type { ToolEffect, ToolSpec } from "@piomio/shared";
import type { ComposioTool } from "./api.ts";

/** Longest short name: the hub adds "composio_" and a tool name is at most 64 characters. */
const MAX_NAME = 64 - "composio_".length;

/** The short name of a Composio tool ("SLACK_SEND_MESSAGE" → "slack_send_message"), cut with a hash when too long. */
export function toolName(slug: string): string {
  const name = slug.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (name.length <= MAX_NAME) return name;
  const hash = createHash("sha1").update(slug).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_NAME - 7)}_${hash}`;
}

/**
 * A read only when Composio says it only reads and nothing else: its tags are best effort, so a tool that also says
 * it creates, updates or deletes, or says nothing, writes (and asks).
 */
export function effectOf(tags: string[]): ToolEffect {
  const writes = ["createHint", "updateHint", "destructiveHint"].some((t) => tags.includes(t));
  return tags.includes("readOnlyHint") && !writes ? "read" : "external";
}

/** Placeholders an approval card shows: the tool's fields, required ones first, at most five. */
const SHOWN_FIELDS = 5;

/**
 * The approval card's text: the app, the action and what it is done with ("Gmail: Send email — recipient_email:
 * {recipient_email}, subject: {subject}…"), so the person sees where it goes before saying yes.
 */
export function approvalOf(tool: ComposioTool, app: string): string {
  const props = Object.keys((tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {}).filter((k) => /^[a-zA-Z0-9_]+$/.test(k));
  const required = new Set(Array.isArray(tool.inputSchema?.required) ? (tool.inputSchema.required as string[]) : []);
  const fields = [...props.filter((k) => required.has(k)), ...props.filter((k) => !required.has(k))].slice(0, SHOWN_FIELDS);
  const head = `${app}: ${tool.name}`.replace(/[{}]/g, "");
  return fields.length ? `${head} — ${fields.map((k) => `${k}: {${k}}`).join(", ")}` : head;
}

/** The agents' tool for a Composio tool of `app` ("Slack"): every result came from outside. */
export function specOf(tool: ComposioTool, app: string): ToolSpec {
  return {
    name: toolName(tool.slug),
    description: `${app} through Composio: ${tool.description || tool.name}`.slice(0, 1500),
    inputSchema: tool.inputSchema,
    effect: effectOf(tool.tags),
    source: true,
    approvalSummary: approvalOf(tool, app),
  };
}

/** A tool's result for the model: the data as JSON, cut to a size a reply can carry. */
export function resultText(data: unknown, max = 24_000): string {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  return text.length > max ? `${text.slice(0, max)}… (cut: ${text.length - max} more characters)` : text;
}
