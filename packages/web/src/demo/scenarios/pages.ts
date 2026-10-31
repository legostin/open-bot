// Pages: "make me a page for a Saturday walk" → Pio looks things up, makes a real page on the pages kit, its card
// arrives in the chat and the page opens in the in-app viewer (the walk page compiled for the demo, pages/walk-<locale>/).

import type { PageView } from "@piomio/shared";
import { t as ui } from "../../i18n";
import { iso } from "../world";
import type { Chapter } from "./types";

export const pages: Chapter = {
  id: "pages",
  agent: "pio",
  async play({ d, h, c }) {
    const t = c.chapters.pages;
    await d.open("pio");
    await d.wait(500);
    await d.say(t.ask);

    const r = h.reply("pio");
    await r.think(600);
    for (const q of t.searching) await r.tool("web_search", { query: q }, "…", 900, "web", q);
    await r.tool("page_create", { title: t.title }, "created", 1600, "tool", "page_create");
    const dir = `pages/walk-${c.locale}/`;
    const page: PageView = {
      id: "page_walk",
      title: t.title,
      summary: t.summary,
      cover: `https://media.demo.invalid/${dir}art/hero-${c.locale}.svg`,
      agentId: "pio",
      conversationId: r.conversationId,
      url: new URL(dir, document.baseURI).href,
      version: 1,
      createdAt: iso(),
      updatedAt: iso(),
    };
    h.hub.world.pages.push(page);
    h.hub.emit({ type: "page.updated", data: page });
    r.push({ type: "page", pageId: page.id });
    await r.write(t.intro);
    r.done();
    await d.wait(1500);
    // The whole card is the button that opens the page.
    await d.press(() => [...document.querySelectorAll("button")].filter((b) => b.textContent?.includes(t.title) && b.textContent.includes(ui("page.open"))).at(-1), "the page's card");
    await d.wait(9000);
  },
};
