// Inbox: what waits for you, then what came in by day (reports, digests, alerts), each a row that opens in place;
// the rest behind "Behind the scenes". The same view as the phone's Inbox tab.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { BehindEntry, InboxEntry, InboxView } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { dayLabel, groupByDay } from "../lib/notifications";
import { formatTime } from "../lib/format";
import { useStore } from "../lib/store";
import { agents, ensureAgents, hubEvents, reconnected, session } from "../state/app";
import { toast } from "../state/toast";
import { locale, t } from "../i18n";
import { Markdown } from "../components/markdown";
import { AgentAvatar } from "../components/AgentAvatar";
import { cx, EmptyState, ErrorNote, Loading, Page } from "../components/ui";
import { FEEDBACK, sendFeedback, Sources } from "./chat/NotificationCard";

/** A page of "Behind the scenes". The hub may run a page past this on a tie of times, so a page this long may have more after it. */
const BEHIND_PAGE = 50;

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="px-1 pb-1.5 text-[12px] font-medium text-muted">{label}</div>
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">{children}</div>
    </section>
  );
}

function Row({ e, open, onToggle, dot }: { e: InboxEntry; open: boolean; onToggle: () => void; dot: boolean }) {
  const a = useStore(agents)?.find((x) => x.id === e.agentId);
  const [feedback, setFeedback] = useState(e.feedback);
  const preview = e.body.replace(/[#*_`>[\]]/g, "").replace(/\s+/g, " ").trim();
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2/70">
        <span className={cx("mt-2.5 size-1.5 shrink-0 rounded-full", dot ? "bg-accent" : "bg-transparent")} />
        <AgentAvatar avatar={a?.avatar} id={e.agentId} name={a?.name} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{e.title}</span>
          {!open && preview && <span className="block truncate text-xs text-muted">{preview}</span>}
        </span>
        <span className="shrink-0 pt-0.5 text-xs text-muted">{formatTime(e.createdAt)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-[66px]">
          {e.caption && <div className="mb-1 text-xs text-muted">{e.caption}</div>}
          {/* An alert or a question keeps the hub's own line breaks; a report or a digest is the agent's Markdown. */}
          <Markdown text={e.body} className="text-sm" user={e.kind === "alert" || e.kind === "question"} />
          {e.sources?.length ? <Sources sources={e.sources} /> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {e.feedbackable &&
              FEEDBACK.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={feedback === f.value}
                  onClick={async () => {
                    if (await sendFeedback(e.id, f.value)) setFeedback(f.value);
                  }}
                  className={cx("rounded-lg border px-2 py-0.5", feedback === f.value ? "border-accent bg-accent-soft text-accent-text" : "border-border text-muted hover:text-fg")}
                >
                  {t(f.label)}
                </button>
              ))}
            <span className="flex-1" />
            {e.conversationId && (
              <Link href={`/chat/${e.conversationId}`} className="text-accent-text hover:underline">
                {t("inbox.openChat")}
              </Link>
            )}
            {e.taskId && e.kind !== "digest" && (
              <Link href={`/tasks/${e.taskId}`} className="text-accent-text hover:underline">
                {t("notifications.toTask")}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function behindWhy(b: BehindEntry): string {
  if (b.supersededBy) return t("inbox.why.superseded");
  if (b.digest) return t("inbox.why.inDigest", { title: b.digest.title });
  if (b.kind === "approval") return t("inbox.why.approval");
  if (b.level === "digest") return t("inbox.why.waiting");
  return b.reason ?? t("inbox.why.silent");
}

export function InboxPage() {
  const s = useStore(session);
  const [view, setView] = useState<InboxView | null>(null);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [behind, setBehind] = useState<BehindEntry[] | null>(null);
  const [behindMore, setBehindMore] = useState(false);
  const [collecting, setCollecting] = useState(false);
  // Entries that were unread when shown: marked read at once, their dot stays while the page is open.
  const fresh = useRef(new Set<string>());

  useEffect(() => ensureAgents(), []);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setView(await api.get<InboxView>("/api/inbox"));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const off1 = hubEvents.on((e) => {
      if (e.type === "notification.created") void load();
    });
    const off2 = reconnected.on(() => void load());
    return () => {
      off1();
      off2();
    };
  }, [load]);

  useEffect(() => {
    if (!view) return;
    const ids = [...view.questions, ...view.entries].filter((e) => e.unread && !fresh.current.has(e.id)).map((e) => e.id);
    if (!ids.length) return;
    for (const id of ids) fresh.current.add(id);
    // A read that did not go through is tried again with the next view.
    void api.post("/api/inbox/read", { ids }).catch(() => {
      for (const id of ids) fresh.current.delete(id);
    });
  }, [view]);

  const collect = async () => {
    setCollecting(true);
    try {
      const r = await api.post<{ sent: number }>("/api/digest/flush", {});
      toast(r.sent ? t("inbox.collecting") : t("notifications.digestEmpty"), r.sent ? "success" : "info");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setCollecting(false);
    }
  };

  // The hub runs a page to the end of a moment, so what follows starts strictly before the last entry's time.
  const more = async () => {
    const last = view?.entries[view.entries.length - 1];
    if (!last) return;
    try {
      const next = await api.get<InboxView>(`/api/inbox?before=${encodeURIComponent(last.createdAt)}`);
      setView((v) => v && { ...v, entries: [...v.entries, ...next.entries.filter((e) => !v.entries.some((x) => x.id === e.id))], hasMore: next.hasMore });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const loadBehind = async (before?: string) => {
    try {
      const page = await api.get<BehindEntry[]>(`/api/inbox/behind?limit=${BEHIND_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      const kept = before ? (behind ?? []) : [];
      setBehind([...kept, ...page.filter((b) => !kept.some((x) => x.id === b.id))]);
      // The list is a bare array: a page as long as asked for (or longer) may have more after it.
      setBehindMore(page.length >= BEHIND_PAGE);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const toggleBehind = async () => {
    if (behind) return setBehind(null);
    await loadBehind();
  };

  const row = (e: InboxEntry) => <Row key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? undefined : e.id)} dot={e.unread || fresh.current.has(e.id)} />;
  const tz = s?.timezone;
  const now = new Date();
  const empty = view && !view.questions.length && !view.entries.length && !s?.pendingApprovals;

  return (
    <Page title={t("nav.notifications")}>
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!view && !error && <Loading />}
      {view?.next && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2 text-[13px] text-muted">
          <Sparkles className="size-4 shrink-0 text-accent-text" />
          <span className="min-w-0 flex-1">{view.next.time ? t("inbox.next", { time: view.next.time, n: view.next.count }) : t("inbox.nextNoTime", { n: view.next.count })}</span>
          <button type="button" onClick={() => void collect()} disabled={collecting} className="shrink-0 font-medium text-accent-text hover:underline disabled:opacity-60">
            {t("inbox.collect")}
          </button>
        </div>
      )}
      {view && (view.questions.length > 0 || !!s?.pendingApprovals) && (
        <Section label={t("inbox.waiting")}>
          {!!s?.pendingApprovals && (
            <a href={`${s.consoleUrl}/#/approvals`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-surface-2/70">
              <span className="min-w-0 flex-1 font-medium">{t("inbox.approvals", { n: s.pendingApprovals })}</span>
              <ChevronRight className="size-4 text-muted" />
            </a>
          )}
          {view.questions.map(row)}
        </Section>
      )}
      {view &&
        groupByDay(view.entries, tz).map((g) => (
          <Section key={g.day} label={dayLabel(g.day, now, tz, locale, { today: t("inbox.today"), yesterday: t("inbox.yesterday") })}>
            {g.entries.map(row)}
          </Section>
        ))}
      {view?.hasMore && (
        <button type="button" onClick={() => void more()} className="mb-4 w-full rounded-xl py-2 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
          {t("inbox.more")}
        </button>
      )}
      {empty && <EmptyState icon="bell" title={t("inbox.empty")} hint={t("inbox.emptyHint")} />}
      {view && view.behindCount > 0 && (
        <div className="mt-2">
          <button type="button" onClick={() => void toggleBehind()} aria-expanded={!!behind} className="flex w-full items-center gap-2 px-1 py-2 text-[13px] text-muted hover:text-fg">
            <span className="flex-1 text-left">{t("inbox.behind", { n: view.behindCount })}</span>
            <ChevronDown className={cx("size-4 transition-transform", behind && "rotate-180")} />
          </button>
          {behind && (
            <div className="flex flex-col divide-y divide-border rounded-2xl border border-hairline bg-surface">
              {behind.map((b) => (
                <div key={b.id} className="px-3 py-2.5 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{b.title}</span>
                    <span className="shrink-0 text-xs text-muted">{formatTime(b.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{behindWhy(b)}</div>
                </div>
              ))}
              {behindMore && behind.length > 0 && (
                <button type="button" onClick={() => void loadBehind(behind[behind.length - 1].createdAt)} className="py-2 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
                  {t("inbox.more")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
