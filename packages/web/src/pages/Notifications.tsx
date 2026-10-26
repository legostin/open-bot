// Notifications feed with feedback buttons and "send digest now".

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { BellOff, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import type { Notification } from "@openbot/shared";
import { api, errorText } from "../lib/api";
import { NOTIFY_LEVEL, plural, relativeTime } from "../lib/format";
import { hubEvents, reconnected } from "../state/app";
import { toast } from "../state/toast";
import { Markdown } from "../components/markdown";
import { Badge, Button, cx, EmptyState, ErrorNote, Loading, Page, Segmented } from "../components/ui";

type Feedback = NonNullable<Notification["feedback"]>;

const FEEDBACK: Array<{ value: Feedback; label: string; icon: typeof ThumbsUp; title: string }> = [
  { value: "useful", label: "полезно", icon: ThumbsUp, title: "Полезно — продолжай в том же духе" },
  { value: "less", label: "реже", icon: ThumbsDown, title: "Присылай такое реже" },
  { value: "off", label: "выключить", icon: BellOff, title: "Больше не присылай такое" },
];

type Filter = "all" | "notify" | "digest" | "silent";

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
      toast(value === "useful" ? "Спасибо! Учту" : value === "less" ? "Буду присылать реже" : "Больше не буду присылать такое", "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const flush = async () => {
    setFlushing(true);
    try {
      const r = await api.post<{ sent: number }>("/api/digest/flush", {});
      toast(r.sent ? `Сводка отправлена: ${r.sent} ${plural(r.sent, "пункт", "пункта", "пунктов")}` : "Для сводки пока ничего нет", r.sent ? "success" : "info");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setFlushing(false);
    }
  };

  const shown = (list ?? []).filter((n) => filter === "all" || (filter === "notify" ? n.level === "notify" || n.level === "ask" : n.level === filter));

  return (
    <Page
      title="Уведомления"
      subtitle="Что агенты сочли достойным вашего внимания. Оценки помогают им понять, что важно."
      actions={
        <Button icon={<Send className="size-4" />} onClick={() => void flush()} loading={flushing}>
          Отправить сводку сейчас
        </Button>
      }
    >
      <div className="mb-4">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Все" },
            { value: "notify", label: "Важные" },
            { value: "digest", label: "В сводку" },
            { value: "silent", label: "Тихие" },
          ]}
        />
      </div>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && shown.length === 0 && <EmptyState icon="bell" title="Уведомлений нет" hint="Когда фоновые задачи найдут что-то интересное, оно появится здесь." />}
      <div className="flex flex-col gap-3">
        {shown.map((n) => {
          const lvl = NOTIFY_LEVEL[n.level] ?? { label: n.level, tone: "neutral" as const };
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
                    title={f.title}
                    onClick={() => void feedback(n, f.value)}
                    aria-pressed={n.feedback === f.value}
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition",
                      n.feedback === f.value ? "border-accent bg-accent-soft text-accent-text" : "border-border text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <f.icon className="size-3.5" />
                    {f.label}
                  </button>
                ))}
                <span className="flex-1" />
                {n.taskId && (
                  <Link href={`/tasks/${n.taskId}`} className="text-xs text-accent-text hover:underline">
                    задача →
                  </Link>
                )}
                {!n.taskId && n.conversationId && (
                  <Link href={`/chat/${n.conversationId}`} className="text-xs text-accent-text hover:underline">
                    в чат →
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
