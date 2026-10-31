// "Is it worth interrupting you?" — levels, quiet hours, rate limits, dedup, digests, feedback.

import type { Notification, NotificationKind, NotifyLevel, Task } from "@piomio/shared";
import { newId, nowIso, truncate } from "@piomio/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { Settings } from "./settings.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { HookRegistry } from "./hooks.ts";
import type { Store } from "./store.ts";
import { LocalizedError, t } from "./i18n.ts";

/** What a routing level is for the person, when nothing more specific was said. */
export const KIND_OF_LEVEL: Record<NotifyLevel, NotificationKind> = { silent: "item", digest: "item", notify: "alert", ask: "question" };

export const NOTIFY_LEVELS: NotifyLevel[] = ["silent", "digest", "notify", "ask"];

/** What is wrong with a notify call (English, for the model), or undefined. */
export function notifyInputError(level: unknown, title: unknown): string | undefined {
  if (!NOTIFY_LEVELS.includes(level as NotifyLevel)) return `level must be one of ${NOTIFY_LEVELS.join(", ")} (got ${JSON.stringify(level)}).`;
  if (typeof title !== "string" || !title.trim()) return "title is required: the news itself, in the user's language.";
  return undefined;
}

/** Why `notify` records nothing in this run (English, for the model), or undefined when the run may notify. */
export function notifyRefusal(task: Pick<Task, "feedId" | "deliver"> | undefined): string | undefined {
  if (task?.feedId) return "Not needed: the posts you publish with feed_post are what the user sees. Nothing was sent.";
  if (task?.deliver === "report") return "Not needed: your final reply is delivered to the user as this report. Put everything they should read there. Nothing was sent.";
  if (task?.deliver === "digest") return "Not needed: your final reply is the digest itself. Nothing was sent.";
  return undefined;
}

/** One plain sentence for why a task failed: known causes in the person's words, otherwise the error's first sentence. */
export function humanFailure(error: string, code: "no-brain" | undefined, agent: string): string {
  if (code === "no-brain") return t("notify.failed.noBrain", { agent });
  const first = error.trim().split(/(?<=[.!?])\s+|\n/)[0]?.trim() || error.trim();
  return first.length > 200 ? first.slice(0, 200) : first;
}

/** An Inbox row with its chat message and that message's conversation. */
const INBOX_FROM = "from notifications n left join messages m on m.id = n.message_id left join conversations c on c.id = m.conversation_id";
/** Not opened in the Inbox, and its message (if any) after its conversation's read marker. */
const UNREAD = "n.read_at is null and (m.id is null or c.read_at is null or m.created_at > c.read_at)";
const INBOX_KINDS = "('report', 'alert', 'question', 'digest')";
/** How long the default agent may write the digest before the card goes out. */
export const DIGEST_WRITE_MS = 3 * 60_000;
/** A schedule that fires twice delivers one report: the same text from the same trigger within this window is the same report. */
export const REPORT_DUPLICATE_MS = 10 * 60_000;

const fromRow = (r: any): Notification => ({
  id: r.id,
  level: r.level,
  kind: r.kind ?? KIND_OF_LEVEL[r.level as NotifyLevel] ?? "item",
  title: r.title,
  body: r.body,
  agentId: r.agent_id ?? undefined,
  taskId: r.task_id ?? undefined,
  triggerId: r.trigger_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at ?? undefined,
  feedback: r.feedback ?? undefined,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.message_id ? { messageId: r.message_id } : {}),
  ...(r.read_at ? { readAt: r.read_at } : {}),
  ...(r.digest_id ? { digestId: r.digest_id } : {}),
  ...(r.superseded_by ? { supersededBy: r.superseded_by } : {}),
});

export function localHHMM(timezone: string, d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

export function inQuietHours(q: { enabled: boolean; start: string; end: string }, hhmm: string): boolean {
  if (!q.enabled) return false;
  if (q.start === q.end) return false;
  return q.start < q.end ? hhmm >= q.start && hhmm < q.end : hhmm >= q.start || hhmm < q.end;
}

export interface NotifyInput {
  level: NotifyLevel;
  title: string;
  body: string;
  agentId?: string;
  taskId?: string;
  triggerId?: string;
  conversationId?: string;
  /** "approval": the hub's push for an approval whose card is already in the chat (channels only). */
  kind?: "approval";
}

export class Notifier {
  db: Db;
  bus: EventBus;
  settings: Settings;
  channels: ChannelRegistry;
  hooks: HookRegistry;
  store: Store;
  sign: (payload: string) => string;
  publicUrl: string;
  hasAgent: (id: string) => boolean;
  startTask?: (t: { agentId: string; title: string; goal: string; deliver: "digest" }) => { id: string };
  agentName: (id: string) => string;
  digestWriteMs: number;
  private digestTimer?: NodeJS.Timeout;
  private lastDigestKey = "";

  constructor(d: {
    db: Db;
    bus: EventBus;
    settings: Settings;
    channels: ChannelRegistry;
    hooks: HookRegistry;
    store: Store;
    sign: (p: string) => string;
    publicUrl: string;
    hasAgent: (id: string) => boolean;
    /** Starts the default agent's digest task (the runner's createTask); without it the card goes out at once. */
    startTask?: (t: { agentId: string; title: string; goal: string; deliver: "digest" }) => { id: string };
    /** An agent's name in the hub language, for the digest's material. */
    agentName?: (id: string) => string;
    /** How long the digest task may write before the card goes out (DIGEST_WRITE_MS). */
    digestWriteMs?: number;
  }) {
    this.db = d.db;
    this.bus = d.bus;
    this.settings = d.settings;
    this.channels = d.channels;
    this.hooks = d.hooks;
    this.store = d.store;
    this.sign = d.sign;
    this.publicUrl = d.publicUrl;
    this.hasAgent = d.hasAgent;
    this.startTask = d.startTask;
    this.agentName = d.agentName ?? ((id) => id);
    this.digestWriteMs = d.digestWriteMs ?? DIGEST_WRITE_MS;
  }

  /** Whose dialog a notification goes to: the agent that raised it, or the default agent. */
  private recipient(agentId: string | undefined): string {
    return agentId && this.hasAgent(agentId) ? agentId : this.settings.get().defaultAgent;
  }

  /** The person answered one of this trigger's notifications "off": nothing from it pushes any more. */
  private triggerSilenced(triggerId: string): boolean {
    return !!this.db.prepare("select 1 from notifications where trigger_id = ? and feedback = 'off' limit 1").get(triggerId);
  }

  feedbackToken(id: string, value: string): string {
    return this.sign(`f:${id}:${value}`);
  }

  async notify(input: NotifyInput): Promise<Notification & { effectiveLevel: NotifyLevel; reason?: string }> {
    const invalid = notifyInputError(input.level, input.title);
    if (invalid) throw new Error(invalid);
    const s = this.settings.get();
    let level = input.level;
    let reason: string | undefined;

    const hooked = await this.hooks.run("notify.before", { ...input }, (p, r) => (r.block ? { blocked: r.block } : r.level ? { ...p, level: r.level } : p));
    if (hooked.blocked) {
      level = "silent";
      reason = hooked.blocked;
    } else level = hooked.payload.level;
    // A hook may return a level the hub does not know: it counts as silent, like the migration's unknown levels.
    if (!NOTIFY_LEVELS.includes(level)) level = "silent";

    // Feedback "off" on this trigger silences it.
    if (input.triggerId && level !== "ask" && this.triggerSilenced(input.triggerId)) {
      level = "silent";
      reason = t("notify.reason.triggerOff");
    }

    // Dedup: same title+body in the last 6 hours.
    const dup = this.db
      .prepare("select 1 from notifications where title = ? and body = ? and created_at > ? limit 1")
      .get(input.title.trim(), input.body, new Date(Date.now() - 6 * 3600_000).toISOString());
    if (dup && level !== "ask") {
      level = "silent";
      reason = t("notify.reason.duplicate");
    }

    if (level === "notify") {
      const key = input.triggerId ?? input.agentId ?? "none";
      const col = input.triggerId ? "trigger_id" : "agent_id";
      const recent = (
        this.db
          .prepare(`select count(*) as n from notifications where ${col} = ? and level = 'notify' and delivered_at is not null and created_at > ?`)
          .get(key, new Date(Date.now() - 3600_000).toISOString()) as { n: number }
      ).n;
      // Feedback "less" halves the budget for this trigger.
      const less = input.triggerId
        ? (this.db.prepare("select count(*) as n from notifications where trigger_id = ? and feedback = 'less'").get(input.triggerId) as { n: number }).n
        : 0;
      const limit = Math.max(1, Math.floor(s.notifyRatePerHour / 2 ** Math.min(less, 3)));
      if (recent >= limit) {
        level = "digest";
        reason = t("notify.reason.rateLimited");
      } else if (inQuietHours(s.quietHours, localHHMM(s.timezone))) {
        level = "digest";
        reason = t("notify.reason.quietHours");
      }
    }

    const kind: NotificationKind = input.kind === "approval" && level === "notify" ? "approval" : KIND_OF_LEVEL[level];
    const n: Notification = {
      id: newId("n_"),
      level,
      kind,
      title: input.title.trim(),
      body: input.body,
      agentId: input.agentId,
      taskId: input.taskId,
      triggerId: input.triggerId,
      conversationId: input.conversationId,
      createdAt: nowIso(),
      ...(reason ? { reason } : {}),
    };
    this.db
      .prepare("insert into notifications(id, level, kind, title, body, agent_id, task_id, trigger_id, conversation_id, created_at, reason) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(n.id, level, kind, n.title, n.body, n.agentId ?? null, n.taskId ?? null, n.triggerId ?? null, n.conversationId ?? null, n.createdAt, reason ?? null);
    // A newer item from the same schedule replaces the one still waiting for the digest (a rerun, a duplicate run).
    if (level === "digest" && n.triggerId) {
      this.db
        .prepare("update notifications set superseded_by = ?, digested = 1, reason = ? where trigger_id = ? and kind = 'item' and level = 'digest' and digested = 0 and id != ?")
        .run(n.id, t("notify.reason.superseded"), n.triggerId, n.id);
    }
    this.bus.emit("notification.created", n);

    if (level === "notify" || level === "ask") await this.deliver(n);
    return { ...n, effectiveLevel: level, reason };
  }

  private async deliver(n: Notification): Promise<void> {
    const s = this.settings.get();
    // A proactive message lands in the dialog of the agent that raised it.
    const agentId = this.recipient(n.agentId);
    let messageId: string | undefined;
    // An approval's own card is already in the chat: its push only goes to the channels.
    if (n.kind !== "approval") {
      const dialog = this.store.agentConversation(agentId);
      const m = this.store.addMessage({
        conversationId: dialog.id,
        role: "assistant",
        parts: [{ type: "notification", level: n.level, kind: n.kind, title: n.title, body: n.body, notificationId: n.id, ...(n.triggerId ? { feedbackable: true } : {}) }],
        status: "complete",
        agentId: n.agentId,
        taskId: n.taskId,
      });
      messageId = m.id;
    }
    const quiet = inQuietHours(s.quietHours, localHHMM(s.timezone));
    await this.channels.broadcast({
      kind: "notification",
      text: `${n.title}\n\n${truncate(n.body, 3500)}`,
      link: `${this.publicUrl}/${n.taskId ? `tasks/${n.taskId}` : `agent/${encodeURIComponent(agentId)}`}`,
      notificationId: n.id,
      silent: quiet,
      feedback: n.triggerId
        ? {
            notificationId: n.id,
            tokens: { useful: this.feedbackToken(n.id, "useful"), less: this.feedbackToken(n.id, "less"), off: this.feedbackToken(n.id, "off") },
          }
        : undefined,
    });
    this.db.prepare("update notifications set delivered_at = ?, message_id = ? where id = ?").run(nowIso(), messageId ?? null, n.id);
    this.inboxChanged();
  }

  /** A scheduled report's final reply: the agent's own message in its dialog and the channels, at its time (silent in quiet hours, never held back). */
  async deliverReport(task: Task): Promise<Notification | undefined> {
    const text = (task.result ?? "").trim();
    if (!text) {
      await this.notify({ level: "notify", title: t("notify.report.emptyTitle", { title: task.title }), body: t("notify.report.emptyBody"), agentId: task.agentId, taskId: task.id });
      return undefined;
    }
    // A schedule that fires twice (a rerun, a duplicate run) brings the same report: the first one stands.
    if (task.triggerId) {
      const dup = this.db
        .prepare("select * from notifications where kind = 'report' and trigger_id = ? and body = ? and created_at > ? order by created_at desc limit 1")
        .get(task.triggerId, text, new Date(Date.now() - REPORT_DUPLICATE_MS).toISOString());
      if (dup) return fromRow(dup);
    }
    const s = this.settings.get();
    const agentId = this.recipient(task.agentId);
    const caption = t("notify.report.caption", { time: localHHMM(s.timezone) });
    // A schedule the person muted still writes its report (they ordered it) but never pushes it.
    const muted = !!task.triggerId && this.triggerSilenced(task.triggerId);
    const reason = muted ? t("notify.reason.triggerOff") : undefined;
    const n: Notification = {
      id: newId("n_"),
      level: "notify",
      kind: "report",
      title: task.title,
      body: text,
      agentId: task.agentId,
      taskId: task.id,
      triggerId: task.triggerId,
      createdAt: nowIso(),
      ...(reason ? { reason } : {}),
    };
    const dialog = this.store.agentConversation(agentId);
    const m = this.store.addMessage({
      conversationId: dialog.id,
      role: "assistant",
      parts: [{ type: "notification", level: "notify", kind: "report", title: n.title, body: text, caption, notificationId: n.id }],
      status: "complete",
      agentId: task.agentId,
      taskId: task.id,
    });
    const deliveredAt = nowIso();
    this.db
      .prepare("insert into notifications(id, level, kind, title, body, agent_id, task_id, trigger_id, created_at, delivered_at, message_id, reason) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(n.id, n.level, n.kind, n.title, n.body, n.agentId ?? null, n.taskId ?? null, n.triggerId ?? null, n.createdAt, deliveredAt, m.id, reason ?? null);
    const out: Notification = { ...n, deliveredAt, messageId: m.id };
    this.bus.emit("notification.created", out);
    await this.channels.broadcast({
      kind: "notification",
      text: `${n.title} · ${caption}\n\n${truncate(text, 3500)}`,
      link: `${this.publicUrl}/agent/${encodeURIComponent(agentId)}`,
      notificationId: n.id,
      silent: muted || inQuietHours(s.quietHours, localHHMM(s.timezone)),
    });
    this.inboxChanged();
    return out;
  }

  /** Reports, digests, alerts and questions that reached the person and are not read yet. */
  unreadCount(): number {
    return (this.db.prepare(`select count(*) as n ${INBOX_FROM} where n.kind in ${INBOX_KINDS} and n.delivered_at is not null and ${UNREAD}`).get() as { n: number }).n;
  }

  /** Tell the apps the Inbox's unread count (their badges). */
  inboxChanged(): void {
    this.bus.emit("inbox.changed", { unread: this.unreadCount() });
  }

  list(limit = 100): Notification[] {
    return this.db.prepare("select * from notifications order by created_at desc limit ?").all(limit).map(fromRow);
  }

  get(id: string): Notification | undefined {
    const r = this.db.prepare("select * from notifications where id = ?").get(id);
    return r ? fromRow(r) : undefined;
  }

  feedback(id: string, value: "useful" | "less" | "off", token?: string): Notification {
    if (token !== undefined && token !== this.feedbackToken(id, value)) throw new LocalizedError("approval.badSignature");
    this.db.prepare("update notifications set feedback = ? where id = ?").run(value, id);
    const n = this.get(id);
    if (!n) throw new LocalizedError("notification.notFound");
    this.bus.emit("notification.feedback", n);
    return n;
  }

  /** Sections plugins add to a digest going out now (digest.compose): the day's events and the like, lines kept. */
  private async digestSections(timezone: string): Promise<string[]> {
    const now = new Date();
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const r = await this.hooks.run("digest.compose", { date, time: localHHMM(timezone, now), timezone }, (p) => p);
    return r.results
      .filter((x): x is { title: string; body: string } => !!x && typeof x.title === "string" && typeof x.body === "string" && !!x.body.trim())
      .map((x) => `**${x.title.trim()}**\n${truncate(x.body.trim(), 1500)}`);
  }

  /** Combine pending digest items, and the plugins' sections, into one message. */
  async flushDigest(): Promise<number> {
    const rows = this.db.prepare("select * from notifications where level = 'digest' and digested = 0 order by created_at").all().map(fromRow);
    const s = this.settings.get();
    const sections = await this.digestSections(s.timezone);
    if (rows.length === 0 && sections.length === 0) return 0;
    const items = rows.map((n) => `• ${n.title}${n.body ? ` — ${truncate(n.body.replace(/\s+/g, " "), 300)}` : ""}`).join("\n");
    const body = [...sections, items].filter(Boolean).join("\n\n");
    const title = t("notify.digestTitle", { count: rows.length + sections.length });
    // The digest gathers the whole team's items: it goes to the default agent's dialog.
    const dialog = this.store.agentConversation(s.defaultAgent);
    this.store.addMessage({
      conversationId: dialog.id,
      role: "assistant",
      parts: [{ type: "notification", level: "digest", title, body }],
      status: "complete",
    });
    await this.channels.broadcast({ kind: "digest", text: `${title}\n\n${truncate(body, 3800)}`, link: this.publicUrl });
    const st = this.db.prepare("update notifications set digested = 1, delivered_at = ? where id = ?");
    for (const n of rows) st.run(nowIso(), n.id);
    return rows.length + sections.length;
  }

  startDigestTimer(): void {
    this.digestTimer = setInterval(() => {
      const s = this.settings.get();
      const hhmm = localHHMM(s.timezone);
      const key = `${new Date().toDateString()} ${hhmm}`;
      if (s.digestTimes.includes(hhmm) && this.lastDigestKey !== key) {
        this.lastDigestKey = key;
        void this.flushDigest();
      }
    }, 20_000);
    this.digestTimer.unref();
  }

  stop(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
  }
}
