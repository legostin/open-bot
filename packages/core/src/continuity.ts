// Continuity across sessions: when an agent's conversation goes on in a fresh brain session (another brain took over,
// the old session's history is gone or too full), the new session starts with a recap of what came before, so the
// agent carries on as if nothing happened. The user never sees it: it is input for the model only.

import type { Message, MessagePart } from "@owlbot/shared";
import { truncate } from "@owlbot/shared";

/** How long the recap may get, in characters, and how it is split. */
const RECAP_CHARS = 16_000;
const RECENT_SHARE = 0.6;
const FIRST_CHARS = 1500;
const RECENT_MESSAGE_CHARS = 2500;
const OLDER_LINE_CHARS = 220;

/** A message's parts as text for the model: its words, and what was done ([called x], [showed a map]). */
export function partsText(parts: MessagePart[]): string {
  return parts
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "tool_call"
          ? `[called ${p.name}]`
          : p.type === "notification"
            ? `[notification: ${p.title}]`
            : p.type === "attachment"
              ? `[file: ${p.name}]${p.transcript ? ` ${p.transcript}` : ""}`
              : p.type === "images"
                ? `[showed ${p.items.length} image(s)${p.items.some((it) => it.caption) ? `: ${p.items.map((it) => it.caption ?? "").filter(Boolean).join("; ")}` : ""}]`
                : p.type === "map"
                  ? `[showed a map${p.title ? ` of ${p.title}` : ""} at ${p.lat}, ${p.lon}]`
                  : p.type === "news"
                    ? `[showed news: ${p.items.map((n) => n.title).join("; ")}]`
                    : p.type === "choices"
                      ? `[offered: ${p.options.join(" / ")}${p.chosen !== undefined ? `; chosen: ${p.options[p.chosen]}` : ""}]`
                      : p.type === "task" && p.text !== undefined
                        ? `[wrote to a teammate (thread ${p.taskId}): ${p.text}]${p.reply ? ` [reply: ${p.reply}]` : ""}`
                        : p.type === "task"
                          ? `[started task ${p.taskId}]`
                          : "",
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * The messages before the input of the turn now starting: what follows the agent's last reply (the user's new
 * messages, notes for it) is that input, which the turn gets anyway.
 */
export function before(messages: Message[]): Message[] {
  const last = messages.findLastIndex((m) => m.role === "assistant");
  return last < 0 ? [] : messages.slice(0, last + 1);
}

export interface RecapOptions {
  /** Who wrote a message, as the agent reads it ("User", "You", a teammate's name). */
  speaker: (m: Message) => string;
  /** The agent's name. */
  self: string;
  /** The conversation's first message when `messages` do not reach back to it (a task's goal). */
  first?: Message;
  maxChars?: number;
}

/**
 * What a fresh session needs to go on with a conversation: how it started, the older part in short (a line per
 * message, the newest kept first), and the recent turns in full, in a fixed budget. Undefined when the agent has not
 * replied yet: then there is nothing to go on with.
 */
export function recap(messages: Message[], o: RecapOptions): string | undefined {
  const shown = (m: Message) => !!partsText(m.parts);
  const past = before(messages).filter(shown);
  if (!past.some((m) => m.role === "assistant")) return undefined;
  const budget = o.maxChars ?? RECAP_CHARS;
  const line = (m: Message, max: number) => `${o.speaker(m)}: ${truncate(partsText(m.parts).replace(/\s+/g, " "), max)}`;

  const first = o.first && shown(o.first) ? o.first : past[0];
  const startsHere = past[0]?.id === first?.id;
  const recent: string[] = [];
  let used = 0;
  let i = past.length - 1;
  for (; i >= (startsHere ? 1 : 0); i--) {
    const l = line(past[i], RECENT_MESSAGE_CHARS);
    if (recent.length >= 2 && used + l.length > budget * RECENT_SHARE) break;
    recent.unshift(l);
    used += l.length + 2;
  }
  const older: string[] = [];
  let j = i;
  for (; j >= (startsHere ? 1 : 0); j--) {
    const l = `- ${line(past[j], OLDER_LINE_CHARS)}`;
    if (used + l.length > budget - FIRST_CHARS) break;
    older.unshift(l);
    used += l.length + 1;
  }
  const left = j - (startsHere ? 1 : 0) + 1;

  const out = [
    `[System] Your session in this conversation was renewed: you are still ${o.self}, and for the user nothing changed, so do not mention this note — just go on. What came before, for your continuity:`,
  ];
  if (first) out.push("", "It started with:", line(first, FIRST_CHARS));
  if (older.length) out.push("", `Earlier, in short (oldest first${left > 0 ? `; ${left} older messages left out` : ""}):`, ...older);
  out.push("", "Most recent:", recent.join("\n\n"));
  return out.join("\n");
}
