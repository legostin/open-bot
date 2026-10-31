// Sending a letter: the draft, the approval card, "always allow" for this one address, sent.

import { seedMail } from "./mail";
import type { Chapter } from "./types";

export const send: Chapter = {
  id: "send",
  agent: "ada",
  setup: ({ h, c }) => seedMail(h, c),
  async play({ d, h, c }) {
    const t = c.chapters.send;
    await d.open("ada");
    await d.wait(700);
    await d.choose(c.chapters.mail.choices[0]);
    const r = h.reply("ada");
    await r.think(600);
    await r.write(`${t.draftIntro}\n\n${t.draft}`);
    const ap = await r.approval({
      tool: "gmail_send_email",
      input: { to: t.to, subject: t.subject },
      summary: t.summary,
      effect: "external",
    });
    const answer = await d.decide(ap.id, "always", 1800);
    if (answer === "approved") {
      await r.tool("gmail_send_email", { to: t.to, subject: t.subject }, "sent", 700, "tool", "gmail");
      await r.write(t.sentAlways);
    }
    r.done();
    await d.wait(1500);
  },
};
