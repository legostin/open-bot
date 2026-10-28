// The tools agents use with the user's channels (feeds.ts): any agent reads them and makes one when the user wants
// regular news; the editor, in a channel's run, posts, keeps its sources and may rename it.
import type { Feed, MessagePart, NewsItem, ToolDescriptor, ToolResult } from "@owlbot/shared";
import type { ToolRegistry } from "./registry.ts";
import type { Store } from "../store.ts";
import type { AgentRegistry } from "../agents.ts";
import type { Feeds } from "../feeds.ts";
import { agentName } from "../agents.ts";
import { hubLocale } from "../i18n.ts";

export interface FeedToolDeps {
  registry: ToolRegistry;
  feeds: Feeds;
  store: Store;
  agents: AgentRegistry;
  timezone: () => string;
  /** Add a card to the reply the agent is writing (SessionRunner.attachPart). */
  attachPart: (conversationId: string, part: MessagePart) => void;
}

const MAX_NEWS = 12;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const SCHEDULE = {
  times: { type: "array", items: { type: "string" }, description: 'Local "HH:MM" times to gather it, e.g. ["08:00", "19:00"] (default: morning and evening)' },
  weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "Days to gather it, 0 = Sunday … 6 = Saturday (default: every day)" },
};

export function registerFeedTools(d: FeedToolDeps): void {
  const reg = (spec: Omit<ToolDescriptor, "owner">, fn: (input: any, ctx: any) => Promise<ToolResult> | ToolResult) =>
    d.registry.register({ ...spec, owner: "core" }, async (input, ctx) => fn(input ?? {}, ctx));
  const name = (id: string) => {
    const a = d.agents.get(id);
    return a ? agentName(a, hubLocale()) : id;
  };
  const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: d.timezone(), dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  /** The channel named in `feed`, or the one this run gathers. */
  const which = (key: unknown, ctx: { taskId?: string }): Feed | string => {
    if (typeof key === "string" && key.trim()) return d.feeds.find(key) ?? `No channel "${key}". See feed_list.`;
    const own = ctx.taskId ? d.store.getTask(ctx.taskId)?.feedId : undefined;
    return (own && d.feeds.get(own)) || "Say which channel (feed: its id or name). See feed_list.";
  };
  const describe = (f: Feed) =>
    `- ${f.id} “${f.title}”, edited by ${name(f.agentId)}: ${f.times.join(", ")}${f.weekdays.length ? ` on days ${f.weekdays.join(",")}` : " daily"}${f.enabled ? "" : " (paused)"}` +
    `${f.runningTaskId ? ", gathering now" : ""}; ${f.unread} unread${f.lastPost ? `, last post ${when(f.lastPost.createdAt)} “${f.lastPost.title}”` : ", no posts yet"}\n  About: ${f.brief}`;

  reg(
    {
      name: "feed_list",
      description: "The user's channels: news on topics they chose, which agents of the team gather on a schedule. Who edits each, when, what is unread.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const list = d.feeds.list();
      return text(list.length ? list.map(describe).join("\n") : "The user has no channels yet. Make one with feed_create when they want regular news on something.");
    },
  );

  reg(
    {
      name: "feed_read",
      description: "The latest posts of one of the user's channels, newest first, with their ids: to answer about the news, sum up the day (show_news shows chosen posts as cards), or use them in your work.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { feed: { type: "string", description: "The channel's id or name" }, limit: { type: "integer", minimum: 1, maximum: 50, description: "Posts (default 10)" } },
        required: ["feed"],
      },
    },
    (i, ctx) => {
      const f = which(i.feed, ctx);
      if (typeof f === "string") return text(f, true);
      const posts = d.feeds.posts(f.id, { limit: Math.min(Number(i.limit) || 10, 50) });
      if (!posts.length) return text(`“${f.title}” has no posts yet.`);
      return text(posts.map((p) => `- [${p.id}] ${when(p.createdAt)} “${p.title}”${p.source ? ` (${p.source})` : ""}${p.url ? ` ${p.url}` : ""}\n  ${p.text.replace(/\s+/g, " ")}`).join("\n"));
    },
  );

  reg(
    {
      name: "feed_create",
      description:
        "Make a channel for the user: news on a topic they describe, gathered on a schedule by an agent of the team (its editor) from whatever fits: RSS, the web, a browser, scripts, plugins. " +
        "Its first run starts at once. Use the user's own words for what they want, with what to leave out.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          brief: { type: "string", description: "What the channel is about, in the user's words: topics, what matters, what to skip, tone" },
          title: { type: "string", description: "A short name, 1–4 words (default: from the brief)" },
          agent: { type: "string", description: "The editor's agent id (default: the hub's default agent). See task_agents." },
          ...SCHEDULE,
        },
        required: ["brief"],
      },
    },
    (i, ctx) => {
      try {
        // Made in a "New channel" chat: that chat becomes the channel's, where its settings are talked over.
        const conv = d.store.getConversation(ctx.conversationId);
        const setup = conv?.kind === "setup" && conv.purpose === "feed" && !conv.entity ? conv : undefined;
        const f = d.feeds.create({ brief: i.brief, title: i.title, agentId: i.agent, times: i.times, weekdays: i.weekdays }, setup ? { chatId: setup.id } : {});
        d.attachPart(ctx.conversationId, { type: "feed", feedId: f.id });
        if (setup) d.store.setEntity(setup.id, f.id);
        return text(`Channel ${f.id} “${f.title}” made, edited by ${name(f.agentId)}, gathered at ${f.times.join(", ")}. Its first run has started. The user sees its card with buttons under your reply and the channel in the Channels tab.`);
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  reg(
    {
      name: "feed_update",
      description: "Change one of the user's channels: its name, what it is about, its editor, when it is gathered, or pause it. In a channel's run, without `feed` it is that channel.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          feed: { type: "string", description: "The channel's id or name" },
          title: { type: "string" },
          brief: { type: "string" },
          agent: { type: "string", description: "The new editor's agent id" },
          enabled: { type: "boolean", description: "false pauses it" },
          ...SCHEDULE,
        },
      },
    },
    (i, ctx) => {
      const f = which(i.feed, ctx);
      if (typeof f === "string") return text(f, true);
      try {
        const n = d.feeds.update(f.id, { title: i.title, brief: i.brief, agentId: i.agent, times: i.times, weekdays: i.weekdays, enabled: i.enabled });
        // In a conversation with the person (not inside the channel's own run), its card shows the change.
        if (!ctx.taskId || d.store.getTask(ctx.taskId)?.feedId !== f.id) d.attachPart(ctx.conversationId, { type: "feed", feedId: f.id });
        return text(`Channel “${n.title}” updated.`);
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  reg(
    {
      name: "feed_show",
      description: "Show the person a channel's card in the chat: its state and buttons (open it, gather now, how often, pause, delete). Use it when they want to see or set up a channel.",
      effect: "read",
      availability: "interactive",
      inputSchema: { type: "object", properties: { feed: { type: "string", description: "The channel's id or name" } }, required: ["feed"] },
    },
    (i, ctx) => {
      const f = which(i.feed, ctx);
      if (typeof f === "string") return text(f, true);
      d.attachPart(ctx.conversationId, { type: "feed", feedId: f.id });
      return text(`The person sees the card of “${f.title}” under your reply. ${describe(f)}`);
    },
  );

  reg(
    {
      name: "feed_sources",
      description: 'Save the list of what a channel is gathered from, one line each ("rss <url>", "page <url>", "search <query>", "script <file>", "tool <name> …"): the next runs start from it. In a channel\'s run, without `feed` it is that channel.',
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: { feed: { type: "string" }, sources: { type: "array", items: { type: "string" }, maxItems: 50 } },
        required: ["sources"],
      },
    },
    (i, ctx) => {
      const f = which(i.feed, ctx);
      if (typeof f === "string") return text(f, true);
      const n = d.feeds.setSources(f.id, i.sources);
      return text(`Sources of “${n.title}” saved (${n.sources.length}).`);
    },
  );

  reg(
    {
      name: "feed_post",
      description:
        "Publish one news item in a channel: a short title, the gist itself (the key facts and numbers, what changed and why it matters, so the person need not open the link; markdown, a few bullets are fine; never a teaser), the link, the source's name and the item's picture. " +
        "The hub refuses what the channel already has. In a channel's run, without `feed` it is that channel.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          feed: { type: "string" },
          title: { type: "string", description: "≤ 200 chars" },
          text: { type: "string", description: "The gist, ≤ 2000 chars" },
          url: { type: "string", description: "The item's own page" },
          source: { type: "string", description: "Where it comes from: the site's or the feed's name" },
          image: { type: "string", description: "The item's own picture, http(s): the page's Picture from web_fetch (og:image) or the feed's. Add it whenever there is one." },
        },
        required: ["title", "text"],
      },
    },
    (i, ctx) => {
      const f = which(i.feed, ctx);
      if (typeof f === "string") return text(f, true);
      const r = d.feeds.post(f.id, i);
      return "error" in r ? text(r.error, true) : text(`Posted in “${f.title}”.`);
    },
  );

  reg(
    {
      name: "show_news",
      description:
        "Show the user news as cards in the chat: posts of their channels (ids from feed_read) or items you found yourself (title, a line or two, link, source, picture). " +
        "Use it when you tell them the news; around it write only what ties the items together, not the items again.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Above the cards, e.g. “Morning news” (≤ 80 chars)" },
          feed: { type: "string", description: "The channel the posts are from: the cards link to it" },
          posts: { type: "array", items: { type: "string" }, maxItems: MAX_NEWS, description: "Post ids from feed_read" },
          items: {
            type: "array",
            maxItems: MAX_NEWS,
            items: {
              type: "object",
              properties: { title: { type: "string" }, text: { type: "string" }, url: { type: "string" }, source: { type: "string" }, image: { type: "string" } },
              required: ["title"],
            },
          },
        },
      },
    },
    (i, ctx) => {
      const clip = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);
      const web = (v: unknown) => (typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : undefined);
      const posts = d.feeds.postsById(Array.isArray(i.posts) ? i.posts.map(String) : []);
      const items: NewsItem[] = posts.map((p) => ({ title: p.title, text: p.text, ...(p.url ? { url: p.url } : {}), ...(p.source ? { source: p.source } : {}), ...(p.image ? { image: p.image } : {}), at: p.createdAt }));
      for (const raw of Array.isArray(i.items) ? i.items : []) {
        const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const title = clip(x.title, 200);
        if (!title) continue;
        const [text, url, source, image] = [clip(x.text, 600), web(x.url), clip(x.source, 100), web(x.image)];
        items.push({ title, ...(text ? { text } : {}), ...(url ? { url } : {}), ...(source ? { source } : {}), ...(image ? { image } : {}) });
      }
      if (!items.length) return text("Nothing to show: give post ids from feed_read or items with a title.", true);
      const feed = typeof i.feed === "string" && i.feed.trim() ? d.feeds.find(i.feed) : posts[0] ? d.feeds.get(posts[0].feedId) : undefined;
      const title = clip(i.title, 80);
      d.attachPart(ctx.conversationId, { type: "news", ...(title ? { title } : {}), ...(feed ? { feedId: feed.id } : {}), items: items.slice(0, MAX_NEWS) });
      return text(`The user now sees ${Math.min(items.length, MAX_NEWS)} news cards in the chat. Do not repeat them as text.`);
    },
  );

  reg(
    {
      name: "feed_run",
      description: "Gather one of the user's channels now, outside its schedule (when they ask for fresh news).",
      effect: "local-write",
      inputSchema: { type: "object", properties: { feed: { type: "string", description: "The channel's id or name" } }, required: ["feed"] },
    },
    (i, ctx) => {
      const f = which(i.feed, ctx);
      if (typeof f === "string") return text(f, true);
      try {
        const task = d.feeds.run(f.id);
        return text(`“${f.title}” is being gathered (task ${task.id}); its posts appear in the channel.`);
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );
}
