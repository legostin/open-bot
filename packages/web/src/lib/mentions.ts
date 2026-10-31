// @mention autocomplete for the composer of a group chat (the hub routes with parseMentions from @piomio/shared/group).

import { MENTION_ALL, type Mentionable } from "@piomio/shared/group";

/** What the autocomplete offers: a member, or everyone ("@all"). */
export interface MentionOption {
  id: string;
  name: string;
  all?: boolean;
}

/** The "@word" being typed right before the caret: where its "@" is and the word so far, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[^\p{L}\p{N}_@-])@([\p{L}\p{N}_-]*)$/u.exec(before);
  if (!m) return null;
  return { start: before.length - m[1].length - 1, query: m[1] };
}

/**
 * Members matching the query: id or name (or a word of it) starting with it first, then the ones containing it; "@all"
 * last when it matches too. An empty query offers everyone. `everyone` is the word for "@all" in the UI's language
 * ("all" or its Russian form); the one the user started typing wins. Null offers no "@all" (an agent's dialog, where a
 * mention names one teammate).
 */
export function filterMentions(members: readonly Mentionable[], query: string, limit = 8, everyone: string | null = "all"): MentionOption[] {
  const q = query.toLocaleLowerCase();
  const starts: MentionOption[] = [];
  const contains: MentionOption[] = [];
  for (const m of members) {
    const id = m.id.toLocaleLowerCase();
    const name = m.name.toLocaleLowerCase();
    if (id.startsWith(q) || name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) starts.push({ id: m.id, name: m.name });
    else if (id.includes(q) || name.includes(q)) contains.push({ id: m.id, name: m.name });
  }
  const out = [...starts, ...contains].slice(0, limit);
  if (everyone === null) return out;
  const words = [...MENTION_ALL].sort((a, b) => (a === everyone ? -1 : b === everyone ? 1 : 0));
  const all = words.find((a) => a.startsWith(q));
  if (members.length > 1 && all) out.push({ id: all, name: all, all: true });
  return out;
}

/** The text with the "@word" at `start` replaced by "@id " and the caret right after it. */
export function applyMention(text: string, caret: number, start: number, id: string): { text: string; caret: number } {
  // The rest of the word under the caret goes too, and a space already there is reused.
  const rest = text.slice(caret).replace(/^[\p{L}\p{N}_-]*/u, "");
  const head = `${text.slice(0, start)}@${id} `;
  return { text: head + (rest.startsWith(" ") ? rest.slice(1) : rest), caret: head.length };
}
