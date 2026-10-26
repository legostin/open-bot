// Notifications feed with feedback buttons and "send digest now".

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { BellOff, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import type { Notification } from "@owlbot/shared";
import { api, errorText } from "../lib/api";
import { notifyLevel, relativeTime } from "../lib/format";
import { hubEvents, reconnected } from "../state/app";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { Markdown } from "../components/markdown";
import { Badge, Button, cx, EmptyState, ErrorNote, Loading, Page, Segmented } from "../components/ui";

type Feedback = NonNullable<Notification["feedback"]>;

const FEEDBACK: Array<{ value: Feedback; label: MessageKey; icon: typeof ThumbsUp; title: MessageKey; thanks: MessageKey }> = [
  { value: "useful", label: "notifications.feedback.useful", icon: ThumbsUp, title: "notifications.feedback.usefulTitle", thanks: "notifications.thanks.useful" },
  { value: "less", label: "notifications.feedback.less", icon: ThumbsDown, title: "notifications.feedback.lessTitle", thanks: "notifications.thanks.less" },
  { value: "off", label: "notifications.feedback.off", icon: BellOff, title: "notifications.feedback.offTitle", thanks: "notifications.thanks.off" },
];

type Filter = "all" | "notify" | "digest" | "silent";

const FILTER_LABELS: Record<Filter, MessageKey> = {
  all: "notifications.filter.all",
  notify: "notifications.filter.notify",
  digest: "notifications.filter.digest",
  silent: "notifications.filter.silent",
};

export function NotificationsPage() {
  const [list, setList] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string>();
  const [flushing, setFlushing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setList(await api.get<Notification[]>("/api/notifications?limit=200"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const off1 = hubEvents.on((e) => {
      if (e.type === "notification.created") setList((l) => (l ? [e.data, ...l.filter((n) => n.id !== e.data.id)] : l));
    });
    const off2 = reconnected.on(() => void load());
    return () => {
      off1();
      off2();
    };
  }, [load]);

  const feedback = async (n: Notification, value: Feedback) => {
    try {
      const updated = await api.post<Notification>(`/api/notifications/${encodeURIComponent(n.id)}/feedback`, { value });
      setList((l) => l?.map((x) => (x.id === n.id ? { ...x, ...updated, feedback: value } : x)) ?? l);
      const option = FEEDBACK.find((f) => f.value === value);
      if (option) toast(t(option.thanks), "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const flush = async () => {
    setFlushing(true);
    try {
      const r = await api.post<{ sent: number }>("/api/digest/flush", {});
      toast(r.sent ? t("notifications.digestSent", { n: r.sent }) : t("notifications.digestEmpty"), r.sent ? "success" : "info");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setFlushing(false);
    }
  };

  const shown = (list ?? []).filter((n) => filter === "all" || (filter === "notify" ? n.level === "notify" || n.level === "ask" : n.level === filter));

  return (
    <Page
      title={t("nav.notifications")}
      subtitle={t("notifications.subtitle")}
      actions={
        <Button icon={<Send className="size-4" />} onClick={() => void flush()} loading={flushing}>
          {t("notifications.flush")}
        </Button>
      }
    >
      <div className="mb-4">
        <Segmented<Filter> value={filter} onChange={setFilter} options={(Object.keys(FILTER_LABELS) as Filter[]).map((f) => ({ value: f, label: t(FILTER_LABELS[f]) }))} />
      </div>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && shown.length === 0 && <EmptyState icon="bell" title={t("notifications.empty")} hint={t("notifications.emptyHint")} />}
      <div className="flex flex-col gap-3">
        {shown.map((n) => {
          const lvl = notifyLevel(n.level);
          return (
            <article key={n.id} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={lvl.tone}>{lvl.label}</Badge>
                <span className="min-w-0 flex-1 font-semibold">{n.title}</span>
                <span className="text-xs text-muted" title={n.createdAt}>
                  {relativeTime(n.createdAt)}
                </span>
              </div>
              {n.body && <Markdown text={n.body} className="mt-2 text-sm" />}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {FEEDBACK.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    title={t(f.title)}
                    onClick={() => void feedback(n, f.value)}
                    aria-pressed={n.feedback === f.value}
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition",
                      n.feedback === f.value ? "border-accent bg-accent-soft text-accent-text" : "border-border text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <f.icon className="size-3.5" />
                    {t(f.label)}
                  </button>
                ))}
                <span className="flex-1" />
                {n.taskId && (
                  <Link href={`/tasks/${n.taskId}`} className="text-xs text-accent-text hover:underline">
                    {t("notifications.toTask")}
                  </Link>
                )}
                {!n.taskId && n.conversationId && (
                  <Link href={`/chat/${n.conversationId}`} className="text-xs text-accent-text hover:underline">
                    {t("notifications.toChat")}
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Page>
  );
}
