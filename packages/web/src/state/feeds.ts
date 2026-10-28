// The user's channels (/api/feeds) and their posts, kept current by "feed.updated", "feed.deleted" and "feed.post".
import type { Feed, FeedPost, UiEvent } from "@owlbot/shared";
import { api } from "../lib/api";
import { createStore } from "../lib/store";

export const feeds = createStore<Feed[] | null>(null);

/** Posts by channel, newest first; `done` once the oldest is loaded. */
export const feedPosts = createStore<Record<string, { posts: FeedPost[]; done: boolean }>>({});

const PAGE = 30;

const upsert = (list: Feed[], f: Feed): Feed[] => {
  const i = list.findIndex((x) => x.id === f.id);
  if (i < 0) return [...list, f];
  const next = list.slice();
  next[i] = f;
  return next;
};

/** A channel from an API reply: the socket's "feed.updated" for it may have come first and is newer (a run that ended). */
const adopt = (list: Feed[] | null, f: Feed): Feed[] => (list?.some((x) => x.id === f.id) ? list : upsert(list ?? [], f));

let loading: Promise<void> | undefined;

export function refreshFeeds(): Promise<void> {
  loading ??= (async () => {
    try {
      feeds.set(await api.get<Feed[]>("/api/feeds"));
    } catch {
      /* a hub from before channels: the tab stays empty */
      if (!feeds.get()) feeds.set([]);
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

export function ensureFeeds(): void {
  if (!feeds.get() && !loading) void refreshFeeds();
}

export function clearFeeds(): void {
  feeds.set(null);
  feedPosts.set({});
}

/** The newest posts, or `more` older ones. */
export async function loadPosts(id: string, more = false): Promise<void> {
  const cur = feedPosts.get()[id];
  if (more && (!cur || cur.done)) return;
  const before = more ? cur!.posts[cur!.posts.length - 1]?.id : undefined;
  const page = await api.get<FeedPost[]>(`/api/feeds/${encodeURIComponent(id)}/posts?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
  feedPosts.set((all) => {
    const have = more ? (all[id]?.posts ?? []) : [];
    const seen = new Set(have.map((p) => p.id));
    return { ...all, [id]: { posts: [...have, ...page.filter((p) => !seen.has(p.id))], done: page.length < PAGE } };
  });
}

export async function createFeed(input: { brief: string; times: string[]; weekdays?: number[]; agentId?: string }): Promise<Feed> {
  const f = await api.post<Feed>("/api/feeds", input);
  feeds.set((list) => adopt(list, f));
  return f;
}

export async function updateFeed(id: string, patch: Partial<Pick<Feed, "title" | "brief" | "agentId" | "times" | "weekdays" | "enabled">>): Promise<Feed> {
  const f = await api.patch<Feed>(`/api/feeds/${encodeURIComponent(id)}`, patch);
  feeds.set((list) => adopt(list, f));
  return f;
}

export async function deleteFeed(id: string): Promise<void> {
  await api.del(`/api/feeds/${encodeURIComponent(id)}`);
  feeds.set((list) => (list ? list.filter((f) => f.id !== id) : list));
}

export async function runFeed(id: string): Promise<void> {
  await api.post(`/api/feeds/${encodeURIComponent(id)}/run`, {});
}

/** Seen: nothing unread in the channel. */
export async function markFeedRead(id: string): Promise<void> {
  feeds.set((list) => (list ? list.map((f) => (f.id === id && f.unread ? { ...f, unread: 0 } : f)) : list));
  try {
    await api.post(`/api/feeds/${encodeURIComponent(id)}/read`, {});
  } catch {
    /* the next update corrects the count */
  }
}

export function onFeedEvent(e: UiEvent): void {
  switch (e.type) {
    case "feed.updated":
      feeds.set((list) => (list ? upsert(list, e.data) : list));
      break;
    case "feed.deleted":
      feeds.set((list) => (list ? list.filter((f) => f.id !== e.data.id) : list));
      break;
    case "feed.post":
      feedPosts.set((all) => {
        const cur = all[e.data.feedId];
        if (!cur || cur.posts.some((p) => p.id === e.data.id)) return all;
        return { ...all, [e.data.feedId]: { ...cur, posts: [e.data, ...cur.posts] } };
      });
      break;
  }
}

/** Unread posts in all channels: the Channels tab shows it. */
export function unreadPosts(list: Feed[] | null): number {
  return (list ?? []).reduce((n, f) => n + f.unread, 0);
}
