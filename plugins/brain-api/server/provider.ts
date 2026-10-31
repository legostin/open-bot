// Interface between the agent loop and the provider adapters (Anthropic Messages, OpenAI Responses, Chat Completions).

import type { BrainEvent } from "@piomio/shared";
import type { HistoryMessage, Part } from "./history.ts";
import type { McpTool } from "./mcp.ts";

export interface ModelCall {
  model: string;
  system: string;
  tools: McpTool[];
  messages: HistoryMessage[];
  maxTokens: number;
  signal: AbortSignal;
  /** Number of messages sent by the previous request in this session (an extra cache read point). */
  prevMessageCount?: number;
  /** Reasoning effort for this request (the session's); unset: the adapter's default. */
  effort?: string;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "pause" | "aborted";

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CallResult {
  /** Assistant message content in history form. */
  parts: Part[];
  stop: StopKind;
  /** Refusal category / content filter detail. */
  stopDetail?: string;
  usage: Usage;
  /** Model that produced the message (may differ after a server-side fallback). */
  model?: string;
}

/** Streams text deltas as BrainEvents and returns the complete assistant message. Throws LlmError. */
export type ModelStream = AsyncGenerator<BrainEvent, CallResult>;

export const zeroUsage = (): Usage => ({ input: 0, output: 0 });

/** JSON Schema for a tool's input that every provider accepts. */
export function toolSchema(t: McpTool): Record<string, unknown> {
  const s = (t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {}) as Record<string, unknown>;
  return { ...s, type: "object", properties: (s.properties as Record<string, unknown>) ?? {} };
}

export function sortedTools(tools: McpTool[]): McpTool[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Parse streamed tool arguments; anything but a JSON object is invalid. */
export function parseToolInput(raw: string, fallback: unknown = {}): { input: unknown; invalid?: string } {
  if (!raw.trim()) return { input: fallback ?? {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { input: v };
  } catch {
    /* invalid */
  }
  return { input: {}, invalid: raw };
}
