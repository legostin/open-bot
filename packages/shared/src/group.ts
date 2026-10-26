// Group chats: the user with several agents. Who a message addresses (@mentions) and how many may take part.
// Browser-safe: the hub routes turns with it and the web UI uses it for the composer's autocomplete.

/** A group has 2 to 8 agents; the first of them leads (answers when nobody is mentioned). */
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 8;

/** "@all" and its Russian form "@все" address every member. */
export const MENTION_ALL = ["all", "все"] as const;

export interface Mentionable {
  id: string;
  name: string;
}

/** A character that continues a mention (so "@scouting" is not "@scout" and "bob@scout.io" is no mention). */
const WORD = /[\p{L}\p{N}_-]/u;

/** Mentions inside `code` or ``` blocks do not count. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * The members a text mentions with "@", by id or by name (case-insensitive), in the order of their first mention.
 * "@all" / "@все" stands for every member in member order, unless `all` is false (agents' own replies).
 */
export function parseMentions(text: string, members: readonly Mentionable[], opts: { all?: boolean } = {}): string[] {
  const lower = withoutCode(text).toLocaleLowerCase();
  // Longest first: "@Research Lead" wins over "@Research".
  const keys = members
    .flatMap((m) => [
      { key: m.id.toLocaleLowerCase(), id: m.id },
      { key: m.name.trim().toLocaleLowerCase(), id: m.id },
    ])
    .filter((k) => k.key)
    .sort((a, b) => b.key.length - a.key.length);
  const out: string[] = [];
  let everyone = false;
  for (let i = lower.indexOf("@"); i >= 0; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && WORD.test(lower[i - 1])) continue;
    const rest = lower.slice(i + 1);
    const whole = (n: number) => n >= rest.length || !WORD.test(rest[n]);
    if (opts.all !== false && MENTION_ALL.some((a) => rest.startsWith(a) && whole(a.length))) {
      everyone = true;
      continue;
    }
    const hit = keys.find((k) => rest.startsWith(k.key) && whole(k.key.length));
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return everyone ? [...new Set(members.map((m) => m.id))] : out;
}
