// "Is it worth interrupting you?" — levels, quiet hours, rate limits, dedup, digests, feedback.

import type { Notification, NotificationKind, NotificationSource, NotifyLevel, Task } from "@piomio/shared";
import { newId, nowIso, truncate } from "@piomio/shared";
import { json, type Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { CoreSettings, Settings } from "./settings.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { HookRegistry } from "./hooks.ts";
import type { Store } from "./store.ts";
import { hubLocale, LocalizedError, t } from "./i18n.ts";
import {
  DIGEST_CHANNELS,
  DIGEST_POSTS_PER_CHANNEL,
  digestPrompt,
  digestSources,
  fallbackDigestBody,
  hasDigestContent,
  partOfDay,
  type DigestChannel,
  type DigestMaterial,
  type DigestSection,
} from "./digest.ts";

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
  private digestTimers = new Map<string, NodeJS.Timeout>();
  private flushing?: Promise<number>;

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

  /** Sections plugins add to a digest going out now (digest.compose): the day's events and the like, lines kept; a section with no text is left out. */
  private async digestSections(timezone: string): Promise<DigestSection[]> {
    const now = new Date();
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const r = await this.hooks.run("digest.compose", { date, time: localHHMM(timezone, now), timezone }, (p) => p);
    return r.results
      .filter((x): x is { title: string; body: string } => !!x && typeof x.title === "string" && typeof x.body === "string" && !!x.body.trim())
      .map((x) => ({ title: x.title.trim(), body: truncate(x.body.trim(), 1500) }));
  }

  /** What waits for the digest: items in full (oldest first), the plugins' sections, new channel posts, and what already reached the person. */
  private async gather(s: CoreSettings): Promise<DigestMaterial> {
    const now = new Date();
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const last =
      (this.db.prepare("select max(delivered_at) as at from notifications where kind = 'digest'").get() as { at: string | null }).at ??
      new Date(now.getTime() - 24 * 3600_000).toISOString();
    const rows = this.db.prepare("select * from notifications where kind = 'item' and level = 'digest' and digested = 0 and superseded_by is null order by created_at").all().map(fromRow);
    const items = rows.map((n) => {
      const task = n.taskId ? this.store.getTask(n.taskId) : undefined;
      return {
        id: n.id,
        title: n.title,
        body: n.body,
        time: localHHMM(s.timezone, new Date(n.createdAt)),
        ...(n.agentId ? { agentId: n.agentId, agentName: this.agentName(n.agentId) } : {}),
        ...(n.taskId ? { taskId: n.taskId } : {}),
        ...(n.triggerId ? { triggerId: n.triggerId, ...(task ? { trigger: task.title } : {}) } : {}),
      };
    });
    const sections = await this.digestSections(s.timezone);
    const posts = this.db
      .prepare("select p.feed_id as feedId, f.title as feed, p.title as post from feed_posts p join feeds f on f.id = p.feed_id where p.created_at > ? order by p.created_at desc")
      .all(last) as Array<{ feedId: string; feed: string; post: string }>;
    // The caps apply before the material is built; the totals stay true, so "and N more" is right.
    const channels: DigestChannel[] = [];
    for (const p of posts) {
      let c = channels.find((x) => x.feedId === p.feedId);
      if (!c) {
        if (channels.length >= DIGEST_CHANNELS) continue;
        c = { feedId: p.feedId, title: p.feed, posts: [], total: 0 };
        channels.push(c);
      }
      c.total++;
      // A headline is one line: a line break would break the list around it.
      if (c.posts.length < DIGEST_POSTS_PER_CHANNEL) c.posts.push(p.post.replace(/\s+/g, " ").trim());
    }
    const told = (
      this.db
        .prepare("select title, created_at from notifications where kind in ('report', 'alert', 'question') and delivered_at is not null and created_at > ? order by created_at")
        .all(last) as Array<{ title: string; created_at: string }>
    ).map((r) => ({ title: r.title, time: localHHMM(s.timezone, new Date(r.created_at)) }));
    return { partOfDay: partOfDay(localHHMM(s.timezone, now)), date, items, sections, channels, told };
  }

  /** "Утренняя сводка · 31 окт.": the part of the day and the date, in the hub language. */
  private digestTitle(m: DigestMaterial): string {
    const day = new Intl.DateTimeFormat(hubLocale(), { timeZone: this.settings.get().timezone, day: "numeric", month: "short" }).format(new Date());
    return t(`notify.digest.${m.partOfDay}`, { date: day });
  }

  private materialOf(row: { body: string }): DigestMaterial {
    return json<DigestMaterial>(row.body, { partOfDay: "day", date: "", items: [], sections: [], channels: [], told: [] });
  }

  /** Gather what waits for the digest and have the default agent write it; how many items and sections went in (0: nothing to say). */
  flushDigest(): Promise<number> {
    this.flushing ??= this.startDigest().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async startDigest(): Promise<number> {
    // One digest at a time: while one is being written, asking again returns it.
    const open = this.db.prepare("select * from notifications where kind = 'digest' and delivered_at is null order by created_at desc limit 1").get() as { body: string } | undefined;
    if (open) {
      const m = this.materialOf(open);
      return m.items.length + m.sections.length;
    }
    const s = this.settings.get();
    const material = await this.gather(s);
    if (!hasDigestContent(material)) return 0;
    const id = newId("n_");
    const title = this.digestTitle(material);
    // Until it goes out, the digest's body holds its material (for the card, also after a restart).
    this.db.prepare("insert into notifications(id, level, kind, title, body, agent_id, created_at) values (?, 'digest', 'digest', ?, ?, ?, ?)").run(id, title, JSON.stringify(material), s.defaultAgent, nowIso());
    const mark = this.db.prepare("update notifications set digest_id = ?, digested = 1 where id = ?");
    for (const it of material.items) mark.run(id, it.id);
    let task: { id: string } | undefined;
    if (this.startTask && this.hasAgent(s.defaultAgent)) {
      try {
        task = this.startTask({ agentId: s.defaultAgent, title, goal: digestPrompt(material), deliver: "digest" });
      } catch {
        // No writer could be started: the card goes out instead, the digest does not stay open.
      }
    }
    if (task) {
      this.db.prepare("update notifications set task_id = ? where id = ?").run(task.id, id);
      this.armDigestTimer(id, this.digestWriteMs);
    } else await this.deliverDigest(id, undefined);
    return material.items.length + material.sections.length;
  }

  private armDigestTimer(id: string, ms: number): void {
    const timer = setTimeout(() => void this.deliverDigest(id, undefined).catch((e) => console.log(`[piomio] digest: ${e?.message ?? e}`)), Math.max(0, ms));
    timer.unref();
    this.digestTimers.set(id, timer);
  }

  /** The digest task ended: its reply goes out, or the card when it failed or said nothing. A late reply after the card is dropped. */
  async digestWritten(taskId: string, text: string | undefined): Promise<void> {
    const row = this.db.prepare("select id from notifications where kind = 'digest' and task_id = ? and delivered_at is null").get(taskId) as { id: string } | undefined;
    if (row) await this.deliverDigest(row.id, text?.trim() || undefined);
  }

  private async deliverDigest(id: string, text: string | undefined): Promise<void> {
    const timer = this.digestTimers.get(id);
    if (timer) clearTimeout(timer);
    this.digestTimers.delete(id);
    const row = this.db.prepare("select * from notifications where id = ? and delivered_at is null").get(id) as { title: string; body: string } | undefined;
    if (!row) return;
    const material = this.materialOf(row);
    const body =
      text ??
      fallbackDigestBody(material, {
        schedules: t("digest.section.schedules"),
        agents: t("digest.section.agents"),
        channels: t("digest.section.channels"),
        more: (n) => t("digest.morePosts", { n }),
      });
    // Claimed first, so the timer and the reply arriving together send it once.
    const claimed = this.db.prepare("update notifications set delivered_at = ?, body = ? where id = ? and delivered_at is null").run(nowIso(), body, id);
    if (!Number(claimed.changes)) return;
    const s = this.settings.get();
    const sources = digestSources(material);
    const dialog = this.store.agentConversation(s.defaultAgent);
    const m = this.store.addMessage({
      conversationId: dialog.id,
      role: "assistant",
      parts: [{ type: "notification", level: "digest", kind: "digest", title: row.title, body, notificationId: id, ...(sources.length ? { sources } : {}) }],
      status: "complete",
      agentId: s.defaultAgent,
    });
    this.db.prepare("update notifications set message_id = ? where id = ?").run(m.id, id);
    this.bus.emit("notification.created", fromRow(this.db.prepare("select * from notifications where id = ?").get(id)));
    await this.channels.broadcast({
      kind: "digest",
      text: this.channelText(row.title, body, sources),
      link: `${this.publicUrl}/agent/${encodeURIComponent(s.defaultAgent)}`,
      notificationId: id,
      silent: inQuietHours(s.quietHours, localHHMM(s.timezone)),
    });
    this.inboxChanged();
  }

  /** A digest for the channels: the title, the text and the sources on one line (links on a public HTTPS hub). */
  private channelText(title: string, body: string, sources: NotificationSource[]): string {
    const pub = /^https:\/\//.test(this.publicUrl) && !/\/\/(localhost|127\.0\.0\.1)\b/.test(this.publicUrl) ? this.publicUrl.replace(/\/+$/, "") : undefined;
    const line = sources
      .map((x) => {
        const label = x.count && x.count > 1 ? `${x.label} (${x.count})` : x.label;
        return pub && x.href ? `[${label}](${pub}${x.href})` : label;
      })
      .join(" · ");
    return [title, truncate(body, 3600), line ? `${t("digest.from")} ${line}` : ""].filter(Boolean).join("\n\n");
  }

  /** Digests left unwritten (the hub restarted while the agent wrote): the card once their time is up. */
  private recoverDigests(): void {
    const rows = this.db.prepare("select id, created_at from notifications where kind = 'digest' and delivered_at is null").all() as Array<{ id: string; created_at: string }>;
    for (const r of rows) if (!this.digestTimers.has(r.id)) this.armDigestTimer(r.id, Date.parse(r.created_at) + this.digestWriteMs - Date.now());
  }

  startDigestTimer(): void {
    this.recoverDigests();
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
    for (const timer of this.digestTimers.values()) clearTimeout(timer);
    this.digestTimers.clear();
  }
}
