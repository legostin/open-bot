// Buttons inside the agent's messages (CLAUDE.md, "Interface"): quick replies (a `choices` part), and a channel's live
// card (a `feed` part) with what one does with a channel: open it, gather now, how often, pause, delete.

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Newspaper, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import type { MessagePart } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { api, errorText } from "../../lib/api";
import { CADENCES, cadenceOf, feedPath, type Cadence } from "../../lib/feeds";
import { formatTime } from "../../lib/format";
import { agents } from "../../state/app";
import { deleteFeed, ensureFeeds, feeds, runFeed, updateFeed } from "../../state/feeds";
import { toast } from "../../state/toast";
import { cx, Spinner } from "../../components/ui";
import { t } from "../../i18n";

/** Quick replies: a tap sends the option as the person's message; then the buttons rest on it. */
export function Choices({ part, messageId }: { part: Extract<MessagePart, { type: "choices" }>; messageId: string }) {
  const [busy, setBusy] = useState<number>();
  const done = part.chosen !== undefined;
  const choose = async (i: number) => {
    setBusy(i);
    try {
      await api.post(`/api/messages/${encodeURIComponent(messageId)}/choose`, { index: i });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="my-2 flex flex-wrap gap-1.5">
      {part.options.map((o, i) => (
        <button
          key={i}
          type="button"
          disabled={done || busy !== undefined}
          onClick={() => void choose(i)}
          className={cx(
            "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition select-none",
            part.chosen === i ? "border-accent bg-accent text-accent-fg" : done ? "border-border text-muted opacity-50" : "border-border bg-surface text-fg hover:border-fg/30 hover:bg-surface-2",
          )}
        >
          {busy === i && <Spinner size={14} />}
          {o}
        </button>
      ))}
    </div>
  );
}

const CADENCE_LABEL: Record<Cadence, "channel.cadence.morning" | "channel.cadence.twice" | "channel.cadence.thrice" | "channel.cadence.weekly"> = {
  morning: "channel.cadence.morning",
  twice: "channel.cadence.twice",
  thrice: "channel.cadence.thrice",
  weekly: "channel.cadence.weekly",
};

/** A channel's live card: what it follows, who edits it and when, and its buttons. */
export function FeedCard({ feedId }: { feedId: string }) {
  const list = useStore(feeds);
  const team = useStore(agents);
  const [armed, setArmed] = useState(false);
  useEffect(() => ensureFeeds(), []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  const feed = list?.find((f) => f.id === feedId);
  if (!list) return <div className="my-2 h-24 max-w-md animate-pulse rounded-2xl bg-surface-2" />;
  if (!feed) return <div className="my-2 max-w-md rounded-2xl border border-dashed border-border px-3 py-2.5 text-sm text-muted">{t("channel.gone")}</div>;

  const act = (fn: () => Promise<unknown>) => fn().catch((e) => toast(errorText(e), "error"));
  const cadence = cadenceOf(feed);
  const editor = team?.find((a) => a.id === feed.agentId)?.name ?? feed.agentId;
  const state = feed.runningTaskId ? t("channel.gathering") : !feed.enabled ? t("channel.paused") : feed.nextRunAt ? t("channel.next", { time: formatTime(feed.nextRunAt) }) : "";
  const button = "flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[13px] font-medium text-fg transition hover:bg-surface-2 disabled:opacity-50";

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-md">
      <Link href={feedPath(feed.id)} className="flex items-start gap-3 p-3 transition hover:bg-surface-2">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Newspaper className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{feed.title}</span>
          <span className="line-clamp-2 text-[13px] text-muted">{feed.brief}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">{[editor, state].filter(Boolean).join(" · ")}</span>
        </span>
      </Link>
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2.5">
        {(Object.keys(CADENCES) as Cadence[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => act(() => updateFeed(feed.id, CADENCES[c]))}
            className={cx(
              "h-8 rounded-full border px-3 text-[13px] font-medium transition",
              cadence === c ? "border-accent bg-accent text-accent-fg" : "border-border text-muted hover:border-fg/30 hover:text-fg",
            )}
          >
            {t(CADENCE_LABEL[c])}
          </button>
        ))}
        {!cadence && <span className="flex h-8 items-center rounded-full border border-accent bg-accent px-3 text-[13px] font-medium text-accent-fg">{feed.times.join(", ")}</span>}
      </div>
      <div className="flex divide-x divide-border border-t border-border">
        <button type="button" className={button} disabled={!!feed.runningTaskId} onClick={() => act(() => runFeed(feed.id))}>
          <RotateCw className={cx("size-4", feed.runningTaskId && "animate-spin")} />
          {t("channel.refresh")}
        </button>
        <button type="button" className={button} onClick={() => act(() => updateFeed(feed.id, { enabled: !feed.enabled }))}>
          {feed.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
          {feed.enabled ? t("channel.pause") : t("channel.resume")}
        </button>
        <button
          type="button"
          className={cx(button, "text-danger")}
          onClick={() => (armed ? act(() => deleteFeed(feed.id)) : setArmed(true))}
          aria-label={t("channel.delete")}
        >
          <Trash2 className="size-4" />
          {armed ? t("channel.deleteConfirm") : ""}
        </button>
      </div>
    </div>
  );
}
