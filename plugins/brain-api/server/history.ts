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
  if (!isSafeSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
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

// ---------- compaction: a summary instead of the older part ----------

/** Model-facing header of the summary that stands in for the older part of the conversation. */
export const SUMMARY_HEAD = "[System] Summary of the earlier part of this conversation (it stands in for those messages, which are no longer here):";

/** Instructions for the request that writes the summary. */
export const SUMMARY_SYSTEM = [
  "You keep the memory of an AI agent in a long conversation with its user. The older part of the conversation is about to be replaced by your summary, and the agent will go on from it as if it remembered everything.",
  "Summarize the transcript you are given. Keep: who the user is and what they want; what was said, asked and decided; facts and results found (names, numbers, dates, links, file paths, ids); what the agent did, promised or still has to do; open tasks and questions; the user's preferences and the agent's own commitments and way of working with them.",
  'Write it from the agent\'s point of view ("I", "the user"), in English, quoting the user\'s exact words where they matter. Be concise but leave nothing important out: short sections with bullet points, no preamble. If the transcript starts with an earlier summary, fold it in.',
].join("\n");

const isSummaryMessage = (m: HistoryMessage | undefined) => m?.role === "user" && m.parts[0]?.type === "text" && (m.parts[0].text.startsWith(SUMMARY_HEAD) || m.parts[0].text === TRIM_NOTE);

/**
 * Where to cut for compaction: the kept part (the latest messages, about `keepShare` of `budget`) starts at a cut point.
 * 0 when there is nothing to fold (a single message is bigger than that).
 */
export function compactionCut(messages: HistoryMessage[], budget: number, keepShare = 0.4): number {
  if (messages.length < 3) return 0;
  const target = Math.floor(budget * keepShare);
  let cut = 0;
  let acc = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    acc += estimateTokens([messages[i]]);
    if (acc > target && cut) break;
    if (isCutPoint(messages[i])) cut = i;
  }
  // Only an earlier summary before the cut: nothing new to fold.
  return cut === 1 && isSummaryMessage(messages[0]) ? 0 : cut;
}

/** The part to summarize as a plain transcript: tool calls and results shortened, pictures as placeholders. */
export function transcriptOf(messages: HistoryMessage[], maxChars = 300_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (isSummaryMessage(m)) {
      lines.push(`Earlier summary:\n${(m.parts[0] as TextPart).text.replace(SUMMARY_HEAD, "").trim()}`);
      continue;
    }
    const who = m.role === "user" ? "User" : "Agent";
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) lines.push(`${who}: ${truncate(p.text.trim(), 6000)}`);
      else if (p.type === "image") lines.push(`${who}: [image]`);
      else if (p.type === "tool_call") lines.push(`Agent called ${p.name}(${truncate(JSON.stringify(p.input ?? {}), 600)})`);
      else if (p.type === "tool_result") lines.push(`Result${p.isError ? " (error)" : ""}: ${truncate(contentText(p.content).trim(), 1500)}`);
    }
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `…\n${text.slice(text.length - maxChars)}`;
}

/** A summary without the model (it could not write one): the older part as a line per message, newest kept. */
export function digest(messages: HistoryMessage[], maxChars = 12_000): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const line = isSummaryMessage(m)
      ? truncate((m.parts[0] as TextPart).text.replace(SUMMARY_HEAD, "").trim(), 4000)
      : `- ${m.role === "user" ? "User" : "Me"}: ${truncate(
          m.parts
            .map((p) => (p.type === "text" ? p.text : p.type === "tool_call" ? `[called ${p.name}]` : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
          240,
        )}`;
    if (line.endsWith(": ")) continue;
    if (used + line.length > maxChars) {
      lines.unshift(`(${i + 1} earlier messages left out)`);
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** The history after compaction: the summary first, then the kept messages (thinking stripped: its signatures covered the rest). */
export function compacted(messages: HistoryMessage[], cut: number, summary: string): HistoryMessage[] {
  return stripThinking([{ role: "user", parts: [{ type: "text", text: `${SUMMARY_HEAD}\n${summary.trim()}` }] }, ...messages.slice(cut)]);
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
  return content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated: ${s.length - max} more characters]`;
}
