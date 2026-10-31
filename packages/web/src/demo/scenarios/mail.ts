// "Go through my mail": Ada reads the morning's letters with live steps and sums them up, then offers to answer.

import type { Content } from "../content/types";
import type { Agents } from "../director/agents";
import type { Chapter } from "./types";

/** The chapter's end, for the chapters that continue from it. */
export function seedMail(h: Agents, c: Content, minutesAgo = 3): void {
  const t = c.chapters.mail;
  h.seed("ada", [{ type: "text", text: t.ask }], { role: "user", minutesAgo: minutesAgo + 1 });
  h.seed("ada", [{ type: "text", text: t.summary }, { type: "choices", options: [...t.choices] }], { minutesAgo });
}

export const mail: Chapter = {
  id: "mail",
  agent: "ada",
  async play({ d, h, c }) {
    const t = c.chapters.mail;
    await d.open("ada");
    await d.wait(500);
    await d.say(t.ask);
    const r = h.reply("ada");
    await r.think(650);
    await r.tool("gmail_search", { query: t.query, max: 50 }, t.found, 1000, "reading", t.reading[0]);
    for (const what of t.reading.slice(1)) await r.tool("gmail_read", { id: what }, "…", 620, "reading", what);
    await r.tool("gmail_modify", { archive: 38 }, "38 archived", 500, "tool", "gmail");
    await r.write(t.summary);
    r.push({ type: "choices", options: [...t.choices] });
    r.done();
    await d.wait(1200);
  },
};
