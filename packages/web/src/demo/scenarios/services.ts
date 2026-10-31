// Services: "connect my Notion" brings the integration card into the chat, one sign-in connects it, and Ada books the
// meeting in the calendar (with the person's yes) and makes the notes page.

import { t as ui } from "../../i18n";
import type { Chapter } from "./types";

export const services: Chapter = {
  id: "services",
  agent: "ada",
  async play({ d, h, c, clock }) {
    const t = c.chapters.services;
    await d.open("ada");
    await d.wait(500);
    await d.say(t.ask);

    const card = h.reply("ada");
    await card.think(500);
    await card.tool("integration_connect", { id: "notion" }, "card shown", 400, "tool", "integration_connect");
    await card.write(t.cardIntro);
    card.push({ type: "integration", id: "notion" });
    card.done();
    await d.wait(1200);

    const started = h.hub.waitSignal("signin:notion");
    await d.pressText(ui("integrations.signIn", { name: "Notion" }));
    await clock.until(started);
    // The service's own page opens in the person's browser; here it takes a moment and comes back signed in.
    await d.wait(2000);
    h.hub.setIntegration("notion", { status: "connected", account: t.account });
    await d.wait(700);
    await h.say("ada", t.connected, { think: 400 });
    await d.wait(1100);

    await d.say(t.bookAsk);
    const book = h.reply("ada");
    await book.think(500);
    await book.tool("calendar_free_busy", { day: "thursday" }, "free 14:00–17:00", 700, "tool", "google calendar");
    const ap = await book.approval({ tool: "calendar_create_event", input: { when: "thursday 15:00" }, summary: t.eventSummary });
    await d.decide(ap.id, "approve", 1500);
    await book.tool("calendar_create_event", { when: "thursday 15:00" }, "created", 600, "tool", "google calendar");
    await book.tool("notion_create_page", { parent: "Meetings" }, "created", 800, "tool", "notion");
    await book.write(t.booked);
    book.done();
    await d.wait(1500);
  },
};
