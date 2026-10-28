// The Channels tab of the sidebar: each channel with its newest post (or "gathering" while its editor works) and
// what is unread; "New channel" asks for one in the chat with the default agent.

import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Newspaper, Plus } from "lucide-react";
import type { Feed } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { shortTime } from "../../lib/format";
import { feedPath } from "../../lib/feeds";
import { ensureFeeds, feeds } from "../../state/feeds";
import { startSetup } from "../../state/ask";
import { toast } from "../../state/toast";
import { errorText } from "../../lib/api";
import { cx, Spinner } from "../../components/ui";
import { UnreadBadge } from "../../components/UnreadBadge";
import { t } from "../../i18n";

function ChannelRow({ feed, active, onNavigate }: { feed: Feed; active: boolean; onNavigate?: () => void }) {
  const running = !!feed.runningTaskId;
  const preview = feed.lastPost?.title ?? (running ? t("channel.gatheringFirst") : feed.brief);
  return (
    <Link
      href={feedPath(feed.id)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx("flex items-center gap-3 rounded-xl px-2.5 py-2 transition", active ? "bg-accent-soft" : "hover:bg-surface-2")}
    >
      <span className="relative shrink-0">
        <span className={cx("flex size-9 items-center justify-center rounded-xl bg-surface-2 text-muted", !feed.enabled && "opacity-50")}>
          <Newspaper className="size-[18px]" />
        </span>
        {running && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-surface">
            <span className="size-2 animate-pulse rounded-full bg-accent" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-sm", feed.unread ? "font-semibold" : "font-medium", active && "text-accent-text")}>{feed.title}</span>
          {feed.lastPost && <span className="shrink-0 text-[11px] text-muted">{shortTime(feed.lastPost.createdAt)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-xs", feed.unread ? "text-fg" : "text-muted")}>{preview}</span>
          {feed.unread > 0 && <UnreadBadge n={feed.unread} />}
        </span>
      </span>
    </Link>
  );
}

export function ChannelList({ activeId, onNavigate }: { activeId?: string; onNavigate?: () => void }) {
  const list = useStore(feeds);
  const [, navigate] = useLocation();
  useEffect(() => ensureFeeds(), []);
  const create = () => {
    onNavigate?.();
    startSetup("feed", navigate).catch((e) => toast(errorText(e), "error"));
  };
  return (
    <>
      {!list && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}
      {list?.map((f) => <ChannelRow key={f.id} feed={f} active={f.id === activeId} onNavigate={onNavigate} />)}
      {list && (
        <button
          type="button"
          onClick={create}
          className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium text-accent-text transition hover:bg-surface-2"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-dashed border-accent/60">
            <Plus className="size-4" />
          </span>
          {t("channel.new")}
        </button>
      )}
      {list?.length === 0 && <p className="px-3 pt-2 text-xs leading-relaxed text-muted">{t("channel.emptyHint")}</p>}
    </>
  );
}
