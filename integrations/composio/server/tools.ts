// How a Composio tool becomes one of the agents' tools: its name (composio_<slug>, within 64 characters), what it does
// to the world (a read only when Composio tags it readOnlyHint; anything else asks), and its spec.

import { createHash } from "node:crypto";
import type { ToolEffect, ToolSpec } from "@owlbot/shared";
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

/** A read only when Composio says it only reads; its tags are best effort, so anything else (untagged too) writes. */
export function effectOf(tags: string[]): ToolEffect {
  return tags.includes("readOnlyHint") ? "read" : "external";
}

/** The agents' tool for a Composio tool of `app` ("Slack"): every result came from outside. */
export function specOf(tool: ComposioTool, app: string): ToolSpec {
  return {
    name: toolName(tool.slug),
    description: `${app} through Composio: ${tool.description || tool.name}`.slice(0, 1500),
    inputSchema: tool.inputSchema,
    effect: effectOf(tool.tags),
    source: true,
    approvalSummary: `${app}: ${tool.name}`.replace(/[{}]/g, ""),
  };
}

/** A tool's result for the model: the data as JSON, cut to a size a reply can carry. */
export function resultText(data: unknown, max = 24_000): string {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  return text.length > max ? `${text.slice(0, max)}… (cut: ${text.length - max} more characters)` : text;
}
