// Channels: "collect news every morning" becomes a channel Leo edits. Its card appears in the chat, the first issue
// is gathered at once, and the channel opens with the posts and their pictures.

import type { Feed } from "@piomio/shared";
import { feedPath } from "../../lib/feeds";
import { iso, newId } from "../world";
import type { Chapter } from "./types";

/** Pictures drawn for the demo (static/media/news/), shown through the hub's image proxy like any web picture. */
export function newsImage(name: string): string {
  return `https://media.demo.invalid/media/news/${name}`;
}

export const channels: Chapter = {
  id: "channels",
  agent: "leo",
  async play({ d, h, c }) {
    const t = c.chapters.channels;
    await d.open("leo");
    await d.wait(500);
    await d.say(t.ask);

    const q = h.reply("leo");
    await q.think(500);
    await q.write(t.question);
    q.push({ type: "choices", options: [...t.choices] });
    q.done();
    await d.wait(1200);
    await d.choose(t.choices[0]);

    const make = h.reply("leo");
    await make.think(500);
    await make.tool("feed_create", { title: t.feedTitle, times: ["08:00"] }, "created", 700, "tool", "feed_create");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    const feed: Feed = {
      id: "feed_ai_ev",
      title: t.feedTitle,
      brief: t.brief,
      agentId: "leo",
      times: ["08:00"],
      weekdays: [],
      sources: t.sources,
      enabled: true,
      chatId: make.conversationId,
      nextRunAt: tomorrow.toISOString(),
      unread: 0,
      createdAt: iso(),
      updatedAt: iso(),
    };
    h.hub.upsertFeed(feed);
    await make.write(t.created);
    make.push({ type: "feed", feedId: feed.id });
    await make.write(t.gathering);

    h.hub.upsertFeed({ ...feed, runningTaskId: newId("task") });
    for (const src of t.sources) await make.tool("web_rss", { src }, "…", 800, "web", src.replace(/^(rss|search) /, ""));
    for (const p of t.posts) {
      h.hub.post({ id: newId("post"), feedId: feed.id, title: p.title, text: p.text, source: p.source, image: newsImage(p.image), createdAt: iso() });
      await d.wait(700);
    }
    h.hub.upsertFeed({ ...h.hub.world.feeds.find((f) => f.id === feed.id)!, runningTaskId: undefined, lastRunAt: iso() });
    await make.write(t.issueIntro);
    make.push({ type: "news", feedId: feed.id, items: t.posts.map((p) => ({ title: p.title, text: p.text, source: p.source, image: newsImage(p.image), at: iso() })) });
    make.done();
    await d.wait(2200);
    await d.go(feedPath(feed.id));
    await d.wait(4000);
  },
};
