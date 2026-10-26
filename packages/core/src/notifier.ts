// "Is it worth interrupting you?" — levels, quiet hours, rate limits, dedup, digests, feedback.

import type { Notification, NotifyLevel } from "@openbot/shared";
import { newId, nowIso, truncate } from "@openbot/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { Settings } from "./settings.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { HookRegistry } from "./hooks.ts";
import type { Store } from "./store.ts";

const fromRow = (r: any): Notification => ({
  id: r.id,
  level: r.level,
  title: r.title,
  body: r.body,
  agentId: r.agent_id ?? undefined,
  taskId: r.task_id ?? undefined,
  triggerId: r.trigger_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at ?? undefined,
  feedback: r.feedback ?? undefined,
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
  private digestTimer?: NodeJS.Timeout;
  private lastDigestKey = "";

  constructor(d: { db: Db; bus: EventBus; settings: Settings; channels: ChannelRegistry; hooks: HookRegistry; store: Store; sign: (p: string) => string; publicUrl: string }) {
    this.db = d.db;
    this.bus = d.bus;
    this.settings = d.settings;
    this.channels = d.channels;
    this.hooks = d.hooks;
    this.store = d.store;
    this.sign = d.sign;
    this.publicUrl = d.publicUrl;
  }

  feedbackToken(id: string, value: string): string {
    return this.sign(`f:${id}:${value}`);
  }

  async notify(input: NotifyInput): Promise<Notification & { effectiveLevel: NotifyLevel; reason?: string }> {
    const s = this.settings.get();
    let level = input.level;
    let reason: string | undefined;

    const hooked = await this.hooks.run("notify.before", { ...input }, (p, r) => (r.block ? { blocked: r.block } : r.level ? { ...p, level: r.level } : p));
    if (hooked.blocked) {
      level = "silent";
      reason = hooked.blocked;
    } else level = hooked.payload.level;

    // Feedback "off" on this trigger silences it.
    if (input.triggerId && level !== "ask") {
      const off = this.db.prepare("select 1 from notifications where trigger_id = ? and feedback = 'off' limit 1").get(input.triggerId);
      if (off) {
        level = "silent";
        reason = "триггер выключен пользователем";
      }
    }

    // Dedup: same title+body in the last 6 hours.
    const dup = this.db
      .prepare("select 1 from notifications where title = ? and body = ? and created_at > ? limit 1")
      .get(input.title, input.body, new Date(Date.now() - 6 * 3600_000).toISOString());
    if (dup && level !== "ask") {
      level = "silent";
      reason = "повтор";
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
        reason = "лимит частоты — в сводку";
      } else if (inQuietHours(s.quietHours, localHHMM(s.timezone))) {
        level = "digest";
        reason = "тихие часы — в сводку";
      }
    }

    const n: Notification = { id: newId("n_"), level, title: input.title, body: input.body, agentId: input.agentId, taskId: input.taskId, triggerId: input.triggerId, conversationId: input.conversationId, createdAt: nowIso() };
    this.db
      .prepare("insert into notifications(id, level, title, body, agent_id, task_id, trigger_id, conversation_id, created_at) values (?,?,?,?,?,?,?,?,?)")
      .run(n.id, level, n.title, n.body, n.agentId ?? null, n.taskId ?? null, n.triggerId ?? null, n.conversationId ?? null, n.createdAt);
    this.bus.emit("notification.created", n);

    if (level === "notify" || level === "ask") await this.deliver(n);
    return { ...n, effectiveLevel: level, reason };
  }

  private async deliver(n: Notification): Promise<void> {
    const s = this.settings.get();
    const main = this.store.mainConversation(s.defaultAgent);
    this.store.addMessage({
      conversationId: main.id,
      role: "assistant",
      parts: [{ type: "notification", level: n.level, title: n.title, body: n.body }],
      status: "complete",
      agentId: n.agentId,
      taskId: n.taskId,
    });
    const quiet = inQuietHours(s.quietHours, localHHMM(s.timezone));
    await this.channels.broadcast({
      kind: "notification",
      text: `${n.title}\n\n${truncate(n.body, 3500)}`,
      link: `${this.publicUrl}/${n.taskId ? `tasks/${n.taskId}` : ""}`,
      notificationId: n.id,
      silent: quiet,
      feedback: n.triggerId
        ? {
            notificationId: n.id,
            tokens: { useful: this.feedbackToken(n.id, "useful"), less: this.feedbackToken(n.id, "less"), off: this.feedbackToken(n.id, "off") },
          }
        : undefined,
    });
    this.db.prepare("update notifications set delivered_at = ? where id = ?").run(nowIso(), n.id);
  }

  list(limit = 100): Notification[] {
    return this.db.prepare("select * from notifications order by created_at desc limit ?").all(limit).map(fromRow);
  }

  get(id: string): Notification | undefined {
    const r = this.db.prepare("select * from notifications where id = ?").get(id);
    return r ? fromRow(r) : undefined;
  }

  feedback(id: string, value: "useful" | "less" | "off", token?: string): Notification {
    if (token !== undefined && token !== this.feedbackToken(id, value)) throw new Error("Неверная подпись кнопки");
    this.db.prepare("update notifications set feedback = ? where id = ?").run(value, id);
    const n = this.get(id);
    if (!n) throw new Error("Уведомление не найдено");
    this.bus.emit("notification.feedback", n);
    return n;
  }

  /** Combine pending digest items into one message. */
  async flushDigest(): Promise<number> {
    const rows = this.db.prepare("select * from notifications where level = 'digest' and digested = 0 order by created_at").all().map(fromRow);
    if (rows.length === 0) return 0;
    const s = this.settings.get();
    const body = rows.map((n) => `• ${n.title}${n.body ? ` — ${truncate(n.body.replace(/\s+/g, " "), 300)}` : ""}`).join("\n");
    const main = this.store.mainConversation(s.defaultAgent);
    this.store.addMessage({
      conversationId: main.id,
      role: "assistant",
      parts: [{ type: "notification", level: "digest", title: `Сводка (${rows.length})`, body }],
      status: "complete",
    });
    await this.channels.broadcast({ kind: "digest", text: `Сводка (${rows.length})\n\n${truncate(body, 3800)}`, link: this.publicUrl });
    const st = this.db.prepare("update notifications set digested = 1, delivered_at = ? where id = ?");
    for (const n of rows) st.run(nowIso(), n.id);
    return rows.length;
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
