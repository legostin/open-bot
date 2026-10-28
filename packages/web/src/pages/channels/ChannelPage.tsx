// A channel: its posts newest first under their day, like a channel in a messenger, with the editor gathering in the
// background. The header says who edits it and when; "refresh" gathers now; "settings" opens the editor's chat, where
// the channel's card has its buttons.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { RotateCw, SlidersHorizontal } from "lucide-react";
import type { FeedPost } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { cadenceOf, dayKey } from "../../lib/feeds";
import { mediaSrc } from "../../lib/media";
import { agents, ensureAgents } from "../../state/app";
import { ensureFeeds, feedPosts, feeds, loadPosts, markFeedRead, runFeed } from "../../state/feeds";
import { askInChat } from "../../state/ask";
import { toast } from "../../state/toast";
import { Markdown } from "../../components/markdown";
import { Button, EmptyState, IconButton, Loading, Spinner } from "../../components/ui";
import { TopBar } from "../../components/Layout";
import { formatDate, t } from "../../i18n";

const CADENCE_LABEL = {
  morning: "channel.cadence.morning",
  twice: "channel.cadence.twice",
  thrice: "channel.cadence.thrice",
  weekly: "channel.cadence.weekly",
} as const;

/** One news item: its picture, the title (the link), the gist, the source and the time. */
export function PostCard({ post }: { post: FeedPost }) {
  const img = post.image ? mediaSrc(post.image) : undefined;
  return (
    <article className="py-4">
      {img && (
        <a href={post.url ?? post.image} target="_blank" rel="noopener noreferrer" className="mb-3 block">
          <img src={img} alt="" loading="lazy" className="aspect-[16/9] w-full rounded-xl border border-border bg-surface-2 object-cover" />
        </a>
      )}
      <div className="min-w-0">
        <h3 className="text-[15px] leading-snug font-semibold">
          {post.url ? (
            <a href={post.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {post.title}
            </a>
          ) : (
            post.title
          )}
        </h3>
        <Markdown text={post.text} className="mt-1 text-[14px] text-fg/85" />
        <div className="mt-1 text-xs text-muted">
          {post.source ? `${post.source} · ` : ""}
          {formatTime(post.createdAt)}
        </div>
      </div>
    </article>
  );
}

export function ChannelPage({ id }: { id: string }) {
  const list = useStore(feeds);
  const all = useStore(feedPosts);
  const team = useStore(agents);
  const [, navigate] = useLocation();
  const [more, setMore] = useState(false);
  const feed = list?.find((f) => f.id === id);
  const page = all[id];
  useEffect(() => {
    ensureFeeds();
    ensureAgents();
  }, []);
  useEffect(() => {
    loadPosts(id).catch((e) => toast(errorText(e), "error"));
  }, [id]);
  // Open is read: what came while it was open too.
  useEffect(() => {
    if (feed?.unread) void markFeedRead(id);
  }, [id, feed?.unread]);

  const days = useMemo(() => {
    const out: Array<{ key: string; posts: FeedPost[] }> = [];
    for (const p of page?.posts ?? []) {
      const key = dayKey(p.createdAt);
      if (out[out.length - 1]?.key !== key) out.push({ key, posts: [] });
      out[out.length - 1].posts.push(p);
    }
    return out;
  }, [page?.posts]);

  if (list && !feed) {
    return (
      <>
        <TopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon="newspaper" title={t("channel.notFound")} />
        </div>
      </>
    );
  }

  const running = !!feed?.runningTaskId;
  const editor = team?.find((a) => a.id === feed?.agentId)?.name ?? feed?.agentId;
  const cadence = feed ? cadenceOf(feed) : undefined;
  const when = feed ? (feed.enabled ? (cadence ? t(CADENCE_LABEL[cadence]) : feed.times.join(", ")) : t("channel.paused")) : "";
  const refresh = async () => {
    try {
      await runFeed(id);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <>
      <TopBar>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-[15px] font-semibold">{feed?.title ?? ""}</div>
          {feed && <div className="truncate text-xs text-muted">{t("channel.byline", { editor: editor ?? "", when })}</div>}
        </div>
        {feed && (
          <>
            <IconButton label={running ? t("channel.gathering") : t("channel.refresh")} onClick={() => void refresh()} disabled={running}>
              <RotateCw className={running ? "size-[18px] animate-spin" : "size-[18px]"} />
            </IconButton>
            <IconButton
              label={t("channel.settings")}
              onClick={() => askInChat(feed.agentId, t("channel.settingsRequest", { title: feed.title }), navigate).catch((e) => toast(errorText(e), "error"))}
            >
              <SlidersHorizontal className="size-[18px]" />
            </IconButton>
          </>
        )}
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-2 pb-10">
          {!page && <Loading />}
          {page && running && (
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
              <Spinner size={14} />
              {page.posts.length ? t("channel.gathering") : t("channel.gatheringFirst")}
            </div>
          )}
          {page && !page.posts.length && !running && <p className="mt-10 text-center text-sm text-muted">{t("channel.noPosts")}</p>}
          {days.map((d) => (
            <section key={d.key}>
              <h2 className="sticky top-0 z-[1] -mx-4 bg-bg/90 px-4 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted uppercase backdrop-blur">
                {formatDate(d.posts[0].createdAt, { weekday: "long", day: "numeric", month: "long" })}
              </h2>
              <div className="divide-y divide-border">
                {d.posts.map((p) => (
                  <PostCard key={p.id} post={p} />
                ))}
              </div>
            </section>
          ))}
          {page && !page.done && page.posts.length > 0 && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                loading={more}
                onClick={() => {
                  setMore(true);
                  loadPosts(id, true)
                    .catch((e) => toast(errorText(e), "error"))
                    .finally(() => setMore(false));
                }}
              >
                {t("channel.more")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
