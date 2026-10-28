// The Channels tab of the sidebar: each channel with its newest post (or "gathering" while its editor works) and
// what is unread; "New channel" asks for one in the chat with the default agent.

import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Plus } from "lucide-react";
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
import { AddRow } from "../chat/TeamList";
import { ChannelTile } from "./ChannelTile";
import { t } from "../../i18n";

function ChannelRow({ feed, active, onNavigate }: { feed: Feed; active: boolean; onNavigate?: () => void }) {
  const running = !!feed.runningTaskId;
  const preview = feed.lastPost?.title ?? (running ? t("channel.gatheringFirst") : feed.brief);
  return (
    <Link
      href={feedPath(feed.id)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx("press flex items-center gap-3 rounded-2xl px-2.5 py-2", active ? "bg-surface shadow-card" : "hover:bg-surface/55")}
    >
      <ChannelTile feedId={feed.id} size={38} running={running} paused={!feed.enabled} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[14px]", feed.unread ? "font-semibold" : "font-medium")}>{feed.title}</span>
          {feed.lastPost && <span className={cx("shrink-0 text-[11px] tabular-nums", feed.unread ? "font-medium text-accent-text" : "text-muted")}>{shortTime(feed.lastPost.createdAt)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", running && !feed.lastPost ? "font-medium text-accent-text" : feed.unread ? "text-fg" : "text-muted")}>{preview}</span>
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
      {list && <AddRow label={t("channel.new")} icon={<Plus className="size-4" />} onClick={create} />}
      {list?.length === 0 && <p className="px-3 pt-2 text-xs leading-relaxed text-muted">{t("channel.emptyHint")}</p>}
    </>
  );
}
