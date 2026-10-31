// Morning: Pio's digest arrives by itself, Pio nudges about the day, sets a reminder and books the dentist.

import type { Chapter } from "./types";

export const morning: Chapter = {
  id: "morning",
  agent: "pio",
  async play({ d, h, c }) {
    const t = c.chapters.morning;
    await d.open("pio");
    await d.wait(900);
    h.arrive("pio", [{ type: "notification", level: "digest", title: t.digestTitle, body: t.digest }]);
    await d.wait(2200);

    const nudge = h.reply("pio");
    await nudge.think(600);
    await nudge.write(t.nudge);
    nudge.push({ type: "choices", options: [...t.choices] });
    nudge.done();
    await d.wait(1300);
    await d.choose(t.choices[0]);

    const set = h.reply("pio");
    await set.think(400);
    await set.tool("trigger_create", { kind: "once", at: "12:25", text: t.choices[0] }, "created", 500, "tool", "trigger_create");
    await set.write(t.reminderSet);
    set.done();
    await d.wait(1100);

    await d.say(t.dentistAsk);
    const book = h.reply("pio");
    await book.think(500);
    await book.tool("browser_open", { url: `https://${t.clinic}/booking` }, "ok", 1100, "web", t.clinic);
    await book.tool("calendar_free_busy", { day: "thursday" }, "free 09:00–12:00", 600, "tool", "google calendar");
    const ap = await book.approval({ tool: "browser_submit", input: { url: `https://${t.clinic}/booking`, label: "11:30" }, summary: t.dentistSummary });
    await d.decide(ap.id, "approve", 1300);
    await book.tool("browser_submit", { label: "11:30" }, "booked", 700, "web", t.clinic);
    await book.write(t.dentistBooked);
    book.done();
    await d.wait(1500);
  },
};
