// Notifications as an Inbox: storage, intake, reports, the digest the assistant writes, the Inbox read model
// (docs/superpowers/specs/2026-10-31-notifications-inbox-design.md).

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";
import type { MessagePart, OutboundMessage } from "@piomio/shared";
import { Settings, type CoreSettings } from "../src/settings.ts";
import { HookRegistry } from "../src/hooks.ts";
import type { ChannelRegistry } from "../src/channels.ts";
import { Notifier, notifyInputError } from "../src/notifier.ts";

describe("notification storage", () => {
  it("gives old notifications a kind, turns unknown levels silent and counts them read", () => {
    const file = join(mkdtempSync(join(tmpdir(), "piomio-notif-db-")), "piomio.db");
    const old = openDb(file);
    // The schema before the Inbox: no kinds, no read state, no task delivery.
    old.exec(`
      drop index notifications_kind;
      alter table notifications drop column kind; alter table notifications drop column reason;
      alter table notifications drop column message_id; alter table notifications drop column read_at;
      alter table notifications drop column digest_id; alter table notifications drop column superseded_by;
      alter table tasks drop column deliver;
      update schema_version set v = v - 1;`);
    const ins = old.prepare("insert into notifications(id, level, title, body, created_at, delivered_at) values (?,?,?,?,?,?)");
    ins.run("n1", "notify", "A", "a", "2026-10-30T10:00:00.000Z", "2026-10-30T10:00:01.000Z");
    ins.run("n2", "digest", "B", "b", "2026-10-30T11:00:00.000Z", null);
    ins.run("n3", "normal", "", "", "2026-10-30T12:00:00.000Z", null);
    ins.run("n4", "ask", "D", "d", "2026-10-30T13:00:00.000Z", "2026-10-30T13:00:00.000Z");
    old.close();

    const db = openDb(file);
    const rows = db.prepare("select id, level, kind, read_at from notifications order by id").all();
    expect(rows).toEqual([
      { id: "n1", level: "notify", kind: "alert", read_at: "2026-10-30T10:00:01.000Z" },
      { id: "n2", level: "digest", kind: "item", read_at: "2026-10-30T11:00:00.000Z" },
      { id: "n3", level: "silent", kind: "item", read_at: "2026-10-30T12:00:00.000Z" },
      { id: "n4", level: "ask", kind: "question", read_at: "2026-10-30T13:00:00.000Z" },
    ]);
    db.close();
  });

  it("keeps how a task's result reaches the person", () => {
    const store = new Store(openDb(":memory:"), new EventBus());
    const report = store.createTask({ agentId: "assistant", title: "Brief", goal: "g", background: true, createdBy: "trigger", deliver: "report" });
    expect(store.getTask(report.id)?.deliver).toBe("report");
    const plain = store.createTask({ agentId: "assistant", title: "x", goal: "g", background: true, createdBy: "user" });
    expect("deliver" in store.getTask(plain.id)!).toBe(false);
  });
});

type Started = { agentId: string; title: string; goal: string; deliver: "digest" };

/** A notifier over an in-memory hub: the channels' messages, the digest tasks it starts, and its Inbox events. */
function setup(opts: { settings?: Partial<CoreSettings>; digestWriteMs?: number; startTask?: boolean } = {}) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const settings = new Settings(db, "UTC");
  settings.update({ quietHours: { enabled: false, start: "23:00", end: "08:00" }, ...opts.settings });
  const store = new Store(db, bus);
  const hooks = new HookRegistry();
  const sent: OutboundMessage[] = [];
  const channels = { broadcast: async (m: OutboundMessage) => void sent.push(m) } as unknown as ChannelRegistry;
  const started: Started[] = [];
  const events: Array<{ unread: number }> = [];
  bus.on("inbox.changed", (e) => events.push(e));
  const notifier = new Notifier({
    db,
    bus,
    settings,
    channels,
    hooks,
    store,
    sign: (p) => `sig:${p}`,
    publicUrl: "https://hub.example.com",
    hasAgent: (id) => id === "assistant" || id === "scout",
    agentName: (id) => (id === "assistant" ? "Assistant" : id === "scout" ? "Scout" : id),
    digestWriteMs: opts.digestWriteMs,
    ...(opts.startTask === false
      ? {}
      : {
          startTask: (t: Started) => {
            started.push(t);
            return { id: `t_digest_${started.length}` };
          },
        }),
  });
  const notes = (agentId = "assistant") =>
    store
      .listMessages(store.agentConversation(agentId).id, { limit: 100 })
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "notification") as Array<Extract<MessagePart, { type: "notification" }>>;
  const row = (id: string) => db.prepare("select * from notifications where id = ?").get(id) as any;
  return { db, bus, settings, store, hooks, notifier, sent, started, events, notes, row };
}

describe("notification intake", () => {
  it("files each level under its kind and delivers alerts and questions as cards that know their notification", async () => {
    const { notifier, notes, row, sent, events } = setup();
    const a = await notifier.notify({ level: "notify", title: "Ботсад закрыт 2 ноября", body: "Весь день.", agentId: "scout" });
    const q = await notifier.notify({ level: "ask", title: "Залить антифриз?", body: "", agentId: "scout" });
    const d = await notifier.notify({ level: "digest", title: "Новости", body: "3 поста", agentId: "scout" });
    const s = await notifier.notify({ level: "silent", title: "Ничего срочного", body: "", agentId: "scout" });
    expect([a.kind, q.kind, d.kind, s.kind]).toEqual(["alert", "question", "item", "item"]);
    expect(notes("scout").find((p) => p.notificationId === a.id)).toMatchObject({ kind: "alert", title: "Ботсад закрыт 2 ноября" });
    expect(notes("scout").find((p) => p.notificationId === q.id)).toMatchObject({ kind: "question" });
    expect(notes("scout")).toHaveLength(2);
    expect(row(a.id).message_id).toBeTruthy();
    expect(row(d.id).delivered_at).toBeNull();
    expect(sent).toHaveLength(2);
    expect(events.at(-1)).toEqual({ unread: 2 });
  });

  it("refuses an unknown level or an empty title", async () => {
    const { notifier, db } = setup();
    expect(notifyInputError("normal", "x")).toMatch(/level must be one of silent, digest, notify, ask/);
    expect(notifyInputError("notify", "  ")).toMatch(/title is required/);
    expect(notifyInputError("digest", "Ok")).toBeUndefined();
    await expect(notifier.notify({ level: "normal" as never, title: "", body: "" })).rejects.toThrow(/level must be one of/);
    expect((db.prepare("select count(*) as n from notifications").get() as { n: number }).n).toBe(0);
  });

  it("holds a notify back in quiet hours as a digest item and says why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const { notifier, row, sent } = setup({ settings: { quietHours: { enabled: true, start: "23:00", end: "08:00" } } });
      const n = await notifier.notify({ level: "notify", title: "Курс доллара", body: "480", agentId: "assistant" });
      expect(n).toMatchObject({ effectiveLevel: "digest", kind: "item" });
      expect(row(n.id).reason).toMatch(/quiet hours/);
      expect(sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a digest item from the same schedule that has not gone out yet", async () => {
    const { notifier, row } = setup();
    const first = await notifier.notify({ level: "digest", title: "☀️ Алматы, 31 октября", body: "+6°", agentId: "assistant", triggerId: "t_brief" });
    const second = await notifier.notify({ level: "digest", title: "☀️ Алматы, сб 31 октября", body: "+6°, туман", agentId: "assistant", triggerId: "t_brief" });
    expect(row(first.id)).toMatchObject({ superseded_by: second.id, digested: 1 });
    expect(row(first.id).reason).toMatch(/newer/);
    expect(row(second.id)).toMatchObject({ superseded_by: null, digested: 0 });
  });

  it("sends the approval push to the channels only: the approval's own card is already in the chat", async () => {
    const { notifier, notes, sent, row } = setup();
    const n = await notifier.notify({ level: "notify", kind: "approval", title: "Waiting for your approval", body: "Unlock the vault on vps", agentId: "assistant" });
    expect(n.kind).toBe("approval");
    expect(notes()).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(row(n.id).delivered_at).toBeTruthy();
  });

  it("files a notification under item when a hook turns it into a level the hub does not know", async () => {
    const { notifier, hooks, row, notes } = setup();
    hooks.register("notify.before", "test", async () => ({ level: "urgent" }));
    const n = await notifier.notify({ level: "digest", title: "Odd", body: "level from a hook" });
    expect(n.kind).toBe("item");
    expect(row(n.id).kind).toBe("item");
    expect(notes()).toHaveLength(0);
  });
});
