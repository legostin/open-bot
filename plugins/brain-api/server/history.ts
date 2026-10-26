// Provider-neutral conversation history, persisted per session and converted to Anthropic / OpenAI
// request shapes by the adapters. Conversion is a pure function of the stored history, so the
// prompt prefix stays byte-stable between requests (prompt caching, Anthropic preserved thinking).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mimeType: string; data: string };
export type ToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  /** Raw arguments when the model produced invalid JSON (input is then {}). */
  invalidJson?: string;
};
export type ToolResultPart = { type: "tool_result"; id: string; content: Array<TextPart | ImagePart>; isError?: boolean };
/** Provider-specific block kept verbatim for replay (Anthropic thinking / redacted_thinking / fallback ...). */
export type RawPart = { type: "raw"; provider: "anthropic"; block: Record<string, unknown> };
export type Part = TextPart | ImagePart | ToolCallPart | ToolResultPart | RawPart;

export interface HistoryMessage {
  role: "user" | "assistant";
  parts: Part[];
}

export interface SessionFile {
  version: 1;
  sessionId: string;
  variant: string;
  model?: string;
  /** Hash of system prompt + tool definitions the stored thinking blocks were produced under. */
  prefixHash?: string;
  updatedAt: string;
  messages: HistoryMessage[];
}

/** Model-facing marker inserted where old messages were dropped. */
export const TRIM_NOTE = "[System] Earlier messages of this conversation were omitted to fit the model's context window.";

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

export function sessionPath(dataDir: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`недопустимый идентификатор сессии: ${sessionId}`);
  return join(dataDir, "sessions", `${sessionId}.json`);
}

export function loadSession(dataDir: string, sessionId: string): SessionFile | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  const file = sessionPath(dataDir, sessionId);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionFile;
  if (!parsed || !Array.isArray(parsed.messages)) return undefined;
  return parsed;
}

export function saveSession(dataDir: string, data: SessionFile): void {
  const file = sessionPath(dataDir, data.sessionId);
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

// ---------- token estimates and trimming ----------

const IMAGE_TOKENS = 1600;

export function estimatePartTokens(p: Part): number {
  switch (p.type) {
    case "text":
      return Math.ceil(p.text.length / 4) + 2;
    case "image":
      return IMAGE_TOKENS;
    case "tool_call":
      return Math.ceil((p.name.length + JSON.stringify(p.input ?? {}).length) / 4) + 8;
    case "tool_result":
      return p.content.reduce((n, c) => n + estimatePartTokens(c), 8);
    case "raw":
      return Math.ceil(JSON.stringify(p.block).length / 4);
  }
}

export function estimateTokens(messages: HistoryMessage[]): number {
  let n = 0;
  for (const m of messages) for (const p of m.parts) n += estimatePartTokens(p);
  return n + messages.length * 4;
}

const isTrimNote = (m: HistoryMessage | undefined) => m?.role === "user" && m.parts.length === 1 && m.parts[0].type === "text" && m.parts[0].text === TRIM_NOTE;

/** A kept suffix may start at an assistant message or at a user message that carries no tool results. */
function isCutPoint(m: HistoryMessage): boolean {
  return m.role === "assistant" || !m.parts.some((p) => p.type === "tool_result");
}

/**
 * Keep the first user message plus the most recent messages within a token budget. When the history is over
 * `budget`, it is cut down to ~60% of it (so trimming, which invalidates the prompt cache, happens rarely).
 * After a trim every thinking block is stripped: their signatures cover the removed prefix.
 */
export function trimHistory(messages: HistoryMessage[], budget: number): { messages: HistoryMessage[]; trimmed: boolean } {
  if (messages.length < 3 || estimateTokens(messages) <= budget) return { messages, trimmed: false };
  const headLen = isTrimNote(messages[1]) ? 2 : 1;
  const head = messages.slice(0, headLen);
  const note: HistoryMessage = { role: "user", parts: [{ type: "text", text: TRIM_NOTE }] };
  const fixed = headLen === 2 ? head : [...head, note];
  const target = Math.floor(budget * 0.6) - estimateTokens(fixed);

  let start = -1;
  let acc = 0;
  for (let i = messages.length - 1; i >= headLen; i--) {
    acc += estimateTokens([messages[i]]);
    if (acc > target && start !== -1) break;
    if (isCutPoint(messages[i])) start = i;
  }
  if (start <= headLen) return { messages, trimmed: false };
  const kept = [...fixed, ...messages.slice(start)];
  return { messages: stripThinking(kept), trimmed: true };
}

export function hasThinking(messages: HistoryMessage[]): boolean {
  return messages.some((m) => m.parts.some((p) => p.type === "raw"));
}

/** Remove provider-specific raw blocks (thinking, redacted_thinking, fallback markers) from every message. */
export function stripThinking(messages: HistoryMessage[]): HistoryMessage[] {
  return messages
    .map((m) => (m.parts.some((p) => p.type === "raw") ? { ...m, parts: m.parts.filter((p) => p.type !== "raw") } : m))
    .filter((m) => m.parts.length > 0);
}

/** Text of tool result content for display (images become placeholders). */
export function contentText(content: Array<TextPart | ImagePart>): string {
  return content.map((c) => (c.type === "text" ? c.text : `[изображение ${c.mimeType}]`)).join("\n");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[обрезано: ещё ${s.length - max} символов]`;
}
