// Notifications as an Inbox: storage, intake, reports, the digest the assistant writes, the Inbox read model
// (docs/superpowers/specs/2026-10-31-notifications-inbox-design.md).

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";
import { nowIso, type MessagePart, type OutboundMessage, type Task } from "@piomio/shared";
import { Settings, type CoreSettings } from "../src/settings.ts";
import { HookRegistry } from "../src/hooks.ts";
import type { ChannelRegistry } from "../src/channels.ts";
import { humanFailure, Notifier, notifyInputError, notifyRefusal } from "../src/notifier.ts";
import { buildSystemPrompt, taskEnding } from "../src/prompt.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerCoreTools, type CoreToolDeps } from "../src/tools/core-tools.ts";

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

  it("files a notification under item and keeps it silent when a hook turns it into a level the hub does not know", async () => {
    const { notifier, hooks, row, notes } = setup();
    hooks.register("notify.before", "test", async () => ({ level: "urgent" }));
    const n = await notifier.notify({ level: "digest", title: "Odd", body: "level from a hook" });
    expect(n.kind).toBe("item");
    expect(n.effectiveLevel).toBe("silent");
    expect(row(n.id).kind).toBe("item");
    expect(row(n.id).level).toBe("silent");
    expect(notes()).toHaveLength(0);
  });

  it("finds a duplicate even when the title comes with spaces around it", async () => {
    const { notifier, row } = setup();
    await notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    const again = await notifier.notify({ level: "notify", title: "  Курс доллара ", body: "480", agentId: "assistant" });
    expect(again.effectiveLevel).toBe("silent");
    expect(row(again.id).reason).toMatch(/duplicate/);
  });
});

describe("who may notify, and how a background run ends", () => {
  it("lets checks notify; channel runs, reports and the digest put their words elsewhere", () => {
    expect(notifyRefusal(undefined)).toBeUndefined();
    expect(notifyRefusal({})).toBeUndefined();
    expect(notifyRefusal({ feedId: "f_1" })).toMatch(/posts you publish/);
    expect(notifyRefusal({ deliver: "report" })).toMatch(/final reply is delivered to the user as this report/);
    expect(notifyRefusal({ deliver: "digest" })).toMatch(/final reply is the digest/);
  });

  it("ends each kind of task with how its result reaches the person", () => {
    expect(taskEnding({ background: false })).toMatch(/passed to whoever created the task/);
    expect(taskEnding({ background: true })).toMatch(/call notify \(once\)/);
    expect(taskEnding({ background: true, feedId: "f_1" })).not.toMatch(/notify/);
    expect(taskEnding({ background: true, deliver: "report" })).toMatch(/report the user receives/);
    expect(taskEnding({ background: true, deliver: "digest" })).toMatch(/digest the user receives/);
  });
});

describe("the notify tool and the background rules", () => {
  /** The hub's `notify` tool over a notifier of its own, as an agent in `taskId` would call it. */
  function toolSetup() {
    const h = setup();
    const registry = new ToolRegistry();
    registerCoreTools({ registry, store: h.store, notifier: h.notifier } as unknown as CoreToolDeps);
    const call = (input: object, taskId?: string) =>
      registry.get("notify")!.invoke(input, { agentId: "assistant", taskId, conversationId: "c_1" } as never);
    return { ...h, call };
  }
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

  it("tells the model what is wrong instead of throwing, and records nothing", async () => {
    const { call, db } = toolSetup();
    const badLevel = await call({ level: "normal", title: "x" });
    expect(badLevel.isError).toBe(true);
    expect(textOf(badLevel)).toMatch(/Nothing was sent: level must be one of/);
    const noTitle = await call({ level: "notify", title: " " });
    expect(noTitle.isError).toBe(true);
    expect(textOf(noTitle)).toMatch(/title is required/);
    expect((db.prepare("select count(*) as n from notifications").get() as { n: number }).n).toBe(0);
  });

  it("refuses a report run, a digest run and a channel run, and records nothing", async () => {
    const { call, store, db } = toolSetup();
    const make = (extra: object) => store.createTask({ agentId: "assistant", title: "t", goal: "g", background: true, createdBy: "trigger", ...extra }).id;
    const report = await call({ level: "notify", title: "Brief" }, make({ deliver: "report" }));
    expect(textOf(report)).toMatch(/final reply is delivered to the user as this report/);
    expect(report.isError).toBeUndefined();
    expect(textOf(await call({ level: "notify", title: "Brief" }, make({ deliver: "digest" })))).toMatch(/final reply is the digest/);
    expect(textOf(await call({ level: "notify", title: "Brief" }, make({ feedId: "f_1" })))).toMatch(/posts you publish/);
    expect((db.prepare("select count(*) as n from notifications").get() as { n: number }).n).toBe(0);
  });

  it("lets a check notify, with the trigger it ran for", async () => {
    const { call, store, db, row } = toolSetup();
    const task = store.createTask({ agentId: "assistant", title: "t", goal: "g", background: true, createdBy: "trigger", triggerId: "t_check" });
    const r = await call({ level: "digest", title: "Курс доллара вырос", body: "480" }, task.id);
    expect(textOf(r)).toBe("Notification recorded (level: digest).");
    const stored = db.prepare("select id from notifications").get() as { id: string };
    expect(row(stored.id)).toMatchObject({ trigger_id: "t_check", task_id: task.id });
  });

  describe("the system prompt", () => {
    const agent = { id: "owl", name: "Owl", description: "", brains: [], initiative: 1 as const, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 1 }, prompt: "", source: "builtin" };
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: true, skills: [], nativeSkills: false, appended: [] };
    const task = (extra: object) => ({ id: "t1", title: "t", goal: "g", background: true, ...extra }) as never;

    it("tells a report run and a digest run that their final reply is the message, and a check to call notify", () => {
      expect(buildSystemPrompt({ ...base, task: task({ deliver: "report" }) })).toMatch(/scheduled REPORT[^\n]*final reply is delivered to them[^\n]*Do not call `notify`/);
      expect(buildSystemPrompt({ ...base, task: task({ deliver: "digest" }) })).toMatch(/writing the user's digest[^\n]*Do not call `notify`/);
      expect(buildSystemPrompt({ ...base, task: task({}) })).toMatch(/call `notify` exactly once[\s\S]*the title is the news itself/);
    });

    it("keeps the note for a taught skill on a report run, pointing at the reply", () => {
      const skills = [{ name: "rate", description: "d", dir: "/x", source: "user", taught: true, sites: [] }];
      const p = buildSystemPrompt({ ...base, skills, task: task({ deliver: "report", skill: "rate" }) });
      expect(p).toContain("follows the skill `rate`");
      expect(p).toContain("say so in your reply");
      const check = buildSystemPrompt({ ...base, skills, task: task({ skill: "rate" }) });
      expect(check).toContain("say so in your notify");
      expect(check).not.toContain("initiative level only allows");
    });
  });
});

describe("scheduled reports", () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: "t_r1",
    conversationId: "c_t",
    agentId: "assistant",
    title: "Утренняя сводка по Алматы",
    goal: "g",
    status: "done",
    createdBy: "trigger",
    triggerId: "t_brief",
    background: true,
    deliver: "report",
    result: "Сейчас +6°, туман.\n\n**Перекрытия**\n- Центральная",
    createdAt: "2026-10-31T03:00:00.000Z",
    updatedAt: "2026-10-31T03:01:00.000Z",
    ...over,
  });

  it("delivers the final reply whole, as the agent's message, silently in quiet hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const { notifier, notes, sent, row } = setup({ settings: { quietHours: { enabled: true, start: "23:00", end: "08:00" } } });
      const n = await notifier.deliverReport(task());
      expect(notes()[0]).toMatchObject({ kind: "report", title: "Утренняя сводка по Алматы", body: task().result, caption: "scheduled, 03:00", notificationId: n!.id });
      expect(row(n!.id)).toMatchObject({ kind: "report", level: "notify", trigger_id: "t_brief" });
      expect(row(n!.id).message_id).toBeTruthy();
      expect(sent[0]).toMatchObject({ kind: "notification", silent: true });
      expect(sent[0].text).toContain("Утренняя сводка по Алматы · scheduled, 03:00\n\nСейчас +6°, туман.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never holds a report back for the rate limit: the next one from the same schedule arrives as well", async () => {
    const { notifier, notes, sent, row } = setup({ settings: { notifyRatePerHour: 1 } });
    const first = await notifier.deliverReport(task());
    const second = await notifier.deliverReport(task({ id: "t_r2", result: "Через час +8°, туман уходит." }));
    expect(notes().map((p) => [p.kind, p.body])).toEqual([
      ["report", task().result],
      ["report", "Через час +8°, туман уходит."],
    ]);
    expect(sent.map((m) => [m.kind, m.silent])).toEqual([
      ["notification", false],
      ["notification", false],
    ]);
    expect([row(first!.id), row(second!.id)]).toMatchObject([
      { level: "notify", kind: "report", trigger_id: "t_brief" },
      { level: "notify", kind: "report", trigger_id: "t_brief" },
    ]);
    // The limit really is spent for this schedule: an ordinary notify from it now waits for the digest.
    const held = await notifier.notify({ level: "notify", title: "Ещё новость", body: "x", agentId: "assistant", triggerId: "t_brief" });
    expect(held).toMatchObject({ effectiveLevel: "digest", reason: "rate limit — moved to the digest" });
  });

  it("does not deliver the same report twice when a schedule fires twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const { notifier, notes, sent, db, bus, events } = setup();
      const created: string[] = [];
      bus.on("notification.created", (n) => created.push(n.id));
      const first = await notifier.deliverReport(task());
      const rows = () => (db.prepare("select count(*) as n from notifications where kind = 'report'").get() as { n: number }).n;
      const unread = events.length;

      // The same run twice a minute apart: the second one writes nothing and hands back the first.
      vi.setSystemTime(new Date("2026-10-31T03:01:00Z"));
      const again = await notifier.deliverReport(task({ id: "t_r2" }));
      expect(again?.id).toBe(first!.id);
      expect(notes()).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(rows()).toBe(1);
      expect(events).toHaveLength(unread);
      expect(created).toEqual([first!.id]);

      // Another text from the same schedule is its own report.
      await notifier.deliverReport(task({ id: "t_r3", result: "Уже +7°." }));
      expect(rows()).toBe(2);

      // A schedule without an id cannot be told apart, so nothing is guarded.
      await notifier.deliverReport(task({ id: "t_r4", triggerId: undefined, result: "Без расписания" }));
      await notifier.deliverReport(task({ id: "t_r5", triggerId: undefined, result: "Без расписания" }));
      expect(rows()).toBe(4);

      // Past the window the same text is news again.
      vi.setSystemTime(new Date("2026-10-31T03:11:00Z"));
      const later = await notifier.deliverReport(task({ id: "t_r6" }));
      expect(later!.id).not.toBe(first!.id);
      expect(rows()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a schedule the person muted quiet: the report is still written and stored, but pushed silently", async () => {
    const { notifier, notes, sent, row, db } = setup();
    db.prepare("insert into notifications(id, level, title, body, trigger_id, created_at, feedback) values (?,?,?,?,?,?,?)").run(
      "n_old",
      "notify",
      "Вчерашняя сводка",
      "старая",
      "t_brief",
      "2026-10-30T03:00:00.000Z",
      "off",
    );
    const n = await notifier.deliverReport(task());
    expect(n).toMatchObject({ kind: "report", level: "notify", reason: "the trigger is muted by the user" });
    expect(notes()).toHaveLength(1);
    expect(row(n!.id)).toMatchObject({ kind: "report", trigger_id: "t_brief", reason: "the trigger is muted by the user" });
    expect(row(n!.id).message_id).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "notification", silent: true });

    // Another schedule is not affected; an ordinary notify from the muted one is still silent.
    const other = await notifier.deliverReport(task({ id: "t_r2", triggerId: "t_other", result: "Другая сводка" }));
    expect(other!.reason).toBeUndefined();
    expect(sent[1]).toMatchObject({ silent: false });
    const quiet = await notifier.notify({ level: "notify", title: "Новость", body: "x", agentId: "assistant", triggerId: "t_brief" });
    expect(quiet).toMatchObject({ effectiveLevel: "silent", reason: "the trigger is muted by the user" });
  });

  it("says so when a report came back empty", async () => {
    const { notifier, notes } = setup();
    expect(await notifier.deliverReport(task({ result: "  " }))).toBeUndefined();
    expect(notes()[0]).toMatchObject({ kind: "alert", title: "“Утренняя сводка по Алматы” came back empty" });
  });

  it("puts a failure in one plain sentence", () => {
    expect(humanFailure("Can't start the agent “Assistant”: claude-code@local: not signed in", "no-brain", "Assistant")).toBe(
      "Assistant isn't signed in to any brain yet. Sign in from its chat.",
    );
    expect(humanFailure("The page did not load. Then it timed out.", undefined, "Assistant")).toBe("The page did not load.");
    expect(humanFailure("x".repeat(300), undefined, "Assistant")).toHaveLength(200);
  });
});

describe("the digest", () => {
  /** What waits: an item replaced by a newer one from the same schedule, the newer one, a silent note, a channel post and a calendar section. */
  const seed = async (n: ReturnType<typeof setup>) => {
    const brief = n.store.createTask({ agentId: "assistant", title: "Утренняя сводка по Алматы", goal: "g", background: true, createdBy: "trigger", triggerId: "t_brief" });
    await n.notifier.notify({ level: "digest", title: "☀️ Алматы, утро", body: "старое", agentId: "assistant", triggerId: "t_brief", taskId: brief.id });
    await n.notifier.notify({ level: "digest", title: "☀️ Алматы, сб 31 октября", body: "Сейчас +6°, туман.\nДнём +13°.", agentId: "assistant", triggerId: "t_brief", taskId: brief.id });
    await n.notifier.notify({ level: "silent", title: "Ничего срочного", body: "", agentId: "assistant" });
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f_almaty', 'Новости Алматы', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f_almaty', 'Ботсад закрыт 2 ноября', 't', ?)").run(nowIso());
    n.hooks.register("digest.compose", "calendar", async () => ({ title: "Calendar", body: "10:00 Dentist" }));
  };
  const digestRow = (n: ReturnType<typeof setup>) => n.db.prepare("select * from notifications where kind = 'digest'").get() as any;

  it("sends nothing when nothing waits; channel posts alone make no digest", async () => {
    const n = setup();
    expect(await n.notifier.flushDigest()).toBe(0);
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'X', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f1', 'Post', 't', ?)").run(nowIso());
    expect(await n.notifier.flushDigest()).toBe(0);
    expect(n.started).toHaveLength(0);
  });

  it("gathers what waits and has the default agent write it, once", async () => {
    const n = setup();
    await seed(n);
    expect(await n.notifier.flushDigest()).toBe(2);
    expect(n.started).toHaveLength(1);
    expect(n.started[0]).toMatchObject({ agentId: "assistant", deliver: "digest" });
    expect(n.started[0].title).toMatch(/digest · /);
    expect(n.started[0].goal).toContain("Сейчас +6°, туман.\nДнём +13°.");
    expect(n.started[0].goal).not.toContain("старое");
    expect(n.started[0].goal).toContain("Ботсад закрыт 2 ноября");
    expect(n.started[0].goal).toContain("10:00 Dentist");
    const d = digestRow(n);
    expect(d).toMatchObject({ task_id: "t_digest_1", delivered_at: null });
    expect((n.db.prepare("select count(*) as c from notifications where digest_id = ?").get(d.id) as { c: number }).c).toBe(1);
    // Asked again while it is being written (the timer and "Collect now"): the same digest, no second task.
    expect(await Promise.all([n.notifier.flushDigest(), n.notifier.flushDigest()])).toEqual([2, 2]);
    expect(n.started).toHaveLength(1);
    n.notifier.stop();
  });

  it("starts one digest when asked twice at the same moment, from nothing open", async () => {
    const n = setup();
    await seed(n);
    // Both calls pass the "is one open?" check before either has filed its digest: only the guard keeps them to one.
    expect(await Promise.all([n.notifier.flushDigest(), n.notifier.flushDigest()])).toEqual([2, 2]);
    expect(n.started).toHaveLength(1);
    expect((n.db.prepare("select count(*) as c from notifications where kind = 'digest'").get() as { c: number }).c).toBe(1);
    n.notifier.stop();
  });

  it("keeps a digest out of the list until it is written: its body is raw material before that", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    expect(n.notifier.list().some((x) => x.kind === "digest")).toBe(false);
    // The rest of the notifications are still listed.
    expect(n.notifier.list().length).toBeGreaterThan(0);
    await n.notifier.digestWritten("t_digest_1", "Спокойный день.");
    expect(n.notifier.list().filter((x) => x.kind === "digest")).toMatchObject([{ body: "Спокойный день.", deliveredAt: expect.any(String) }]);
  });

  it("delivers what the assistant wrote, with the sources the hub knows, once", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    const text = "Спокойный день.\n\n**Город**\n- Ботсад закрыт 2 ноября";
    await n.notifier.digestWritten("t_digest_1", text);
    await n.notifier.digestWritten("t_digest_1", "again");
    const parts = n.notes().filter((p) => p.kind === "digest");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      body: text,
      sources: [{ label: "Утренняя сводка по Алматы", href: expect.stringMatching(/^\/tasks\//) }, { label: "Calendar" }, { label: "Новости Алматы", count: 1, href: "/channels/f_almaty" }],
    });
    expect(digestRow(n)).toMatchObject({ body: text, agent_id: "assistant" });
    expect(digestRow(n).delivered_at).toBeTruthy();
    expect(digestRow(n).message_id).toBeTruthy();
    const out = n.sent.find((m) => m.kind === "digest")!;
    expect(out.text).toContain("Спокойный день.");
    expect(out.text).toContain("From: [Утренняя сводка по Алматы](https://hub.example.com/tasks/");
    expect(out.text).toContain("Calendar · [Новости Алматы](https://hub.example.com/channels/f_almaty)");
    expect(n.events.at(-1)).toEqual({ unread: 1 });
  });

  it("sends the card when the assistant could not write it, every item whole with its line breaks", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    await n.notifier.digestWritten("t_digest_1", undefined);
    const body = n.notes().find((p) => p.kind === "digest")!.body;
    expect(body).toContain("### Schedules and checks");
    // Markdown hard break (two spaces) keeps the line break the brief had.
    expect(body).toContain("Сейчас +6°, туман.  \nДнём +13°.");
    expect(body).toContain("### Calendar\n\n10:00 Dentist");
    expect(body).toContain("### Channels\n\n**Новости Алматы**\n- Ботсад закрыт 2 ноября");
    expect(digestRow(n).body).toBe(body);
  });

  it("sends the card when the assistant says nothing", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    await n.notifier.digestWritten("t_digest_1", "  \n ");
    expect(n.notes().find((p) => p.kind === "digest")!.body).toContain("### Schedules and checks");
  });

  it("sends the card when no reply came in time, and drops a late reply", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 20_000 });
      await seed(n);
      await n.notifier.flushDigest();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(digestRow(n).delivered_at).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(digestRow(n).delivered_at).toBeTruthy();
      await n.notifier.digestWritten("t_digest_1", "late");
      const parts = n.notes().filter((p) => p.kind === "digest");
      expect(parts).toHaveLength(1);
      expect(parts[0].body).toContain("### Schedules and checks");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the card at once when there is nobody to write it", async () => {
    const n = setup({ startTask: false });
    await seed(n);
    expect(await n.notifier.flushDigest()).toBe(2);
    expect(n.notes().some((p) => p.kind === "digest")).toBe(true);
    expect(digestRow(n).delivered_at).toBeTruthy();
  });

  it("sends the card at once when the writer could not be started, says why in the log, and does not stay open", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const n = setup({ startTask: false });
      (n.notifier as any).startTask = () => {
        throw new Error("no room");
      };
      await seed(n);
      expect(await n.notifier.flushDigest()).toBe(2);
      expect(digestRow(n).delivered_at).toBeTruthy();
      expect(n.notes().filter((p) => p.kind === "digest")).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[piomio\] digest: .*no room/));
    } finally {
      log.mockRestore();
    }
  });

  it("after a restart, a digest left unwritten goes out as the card", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 60_000 });
      await seed(n);
      await n.notifier.flushDigest();
      n.notifier.stop();
      const restarted = new Notifier({
        db: n.db,
        bus: n.bus,
        settings: n.settings,
        channels: { broadcast: async () => {} } as unknown as ChannelRegistry,
        hooks: n.hooks,
        store: n.store,
        sign: (p) => p,
        publicUrl: "http://localhost:8080",
        hasAgent: () => true,
        digestWriteMs: 20_000,
      });
      restarted.startDigestTimer();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(digestRow(n).delivered_at).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      restarted.stop();
      expect(digestRow(n).delivered_at).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the material over oldest first, a section with no text left out, and a post as one line", async () => {
    const n = setup();
    // Inserted newest first: the order comes from the time, not from the rows.
    const ins = n.db.prepare("insert into notifications(id, level, kind, title, body, agent_id, created_at) values (?, 'digest', 'item', ?, ?, 'scout', ?)");
    ins.run("n_late", "Second thing", "later", "2026-10-31T11:00:00.000Z");
    ins.run("n_early", "First thing", "earlier", "2026-10-31T09:00:00.000Z");
    n.hooks.register("digest.compose", "empty", async () => ({ title: "Empty section", body: "  \n " }));
    n.hooks.register("digest.compose", "calendar", async () => ({ title: "Calendar", body: "10:00 Dentist" }));
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'News', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f1', 'A long\nheadline\r\n  in three lines', 't', ?)").run(nowIso());
    expect(await n.notifier.flushDigest()).toBe(3);
    const goal = n.started[0].goal;
    expect(goal.indexOf("### First thing (09:00, Scout)")).toBeGreaterThan(-1);
    expect(goal.indexOf("### First thing")).toBeLessThan(goal.indexOf("### Second thing"));
    expect(goal).toContain("### Calendar");
    expect(goal).not.toContain("Empty section");
    expect(goal).toContain("- A long headline in three lines");
    n.notifier.stop();
  });

  it("caps channels and posts but keeps the true totals, so \"and N more\" is right", async () => {
    const n = setup({ startTask: false });
    await n.notifier.notify({ level: "digest", title: "Something", body: "x", agentId: "assistant" });
    const feed = n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values (?, ?, 'b', 'assistant', '[]', ?, ?)");
    const post = n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values (?, ?, ?, 't', ?)");
    // Channel f0 has 8 new posts, the other seven one each, every post a millisecond apart: newest first, 8 channels, two over the cap.
    const base = Date.now();
    const at = (ms: number) => new Date(base + ms).toISOString();
    for (let i = 0; i < 8; i++) feed.run(`f${i}`, `Channel ${i}`, nowIso(), nowIso());
    for (let i = 0; i < 8; i++) post.run(`p0_${i}`, "f0", `Headline ${i}`, at(100 + i));
    for (let i = 1; i < 8; i++) post.run(`p${i}`, `f${i}`, `Only ${i}`, at(10 - i));
    expect(await n.notifier.flushDigest()).toBe(1);
    const body = digestRow(n).body as string;
    expect(body).toContain("**Channel 0**");
    // The newest five headlines, the rest counted.
    expect(body).toContain("- Headline 7\n- Headline 6\n- Headline 5\n- Headline 4\n- Headline 3");
    expect(body).not.toContain("Headline 2");
    expect(body).toContain("and 3 more");
    expect(body.match(/\*\*Channel \d\*\*/g)).toHaveLength(6);
    expect(body).toContain("**Channel 5**");
    expect(body).not.toContain("Channel 6");
    expect(body).not.toContain("Channel 7");
  });

  it("does not bring a delivered digest's items again, and the next one reaches back only to the last", async () => {
    const n = setup({ startTask: false });
    await n.notifier.notify({ level: "digest", title: "First news", body: "one", agentId: "assistant" });
    expect(await n.notifier.flushDigest()).toBe(1);
    expect(await n.notifier.flushDigest()).toBe(0);
    await n.notifier.notify({ level: "digest", title: "Second news", body: "two", agentId: "assistant" });
    expect(await n.notifier.flushDigest()).toBe(1);
    const bodies = (n.db.prepare("select body from notifications where kind = 'digest' order by created_at").all() as Array<{ body: string }>).map((r) => r.body);
    expect(bodies[0]).toContain("First news");
    expect(bodies[1]).toContain("Second news");
    expect(bodies[1]).not.toContain("First news");
  });

  it("brings what landed while a digest was being written into the next one: a post and an alert", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 10 * 60_000 });
      n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'News', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
      const post = (id: string, title: string) => n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values (?, 'f1', ?, 't', ?)").run(id, title, nowIso());
      post("p_before", "Landed before the digest");
      await n.notifier.notify({ level: "digest", title: "First news", body: "one", agentId: "assistant" });
      await vi.advanceTimersByTimeAsync(1000);
      // The first digest goes to its writer, and the writer takes a while.
      expect(await n.notifier.flushDigest()).toBe(1);
      expect(n.started[0].goal).toContain("Landed before the digest");
      await vi.advanceTimersByTimeAsync(30_000);
      post("p_during", "Landed while it was written");
      await n.notifier.notify({ level: "notify", title: "Alert while it was written", body: "x", agentId: "assistant" });
      await vi.advanceTimersByTimeAsync(10_000);
      await n.notifier.digestWritten("t_digest_1", "Done");
      await vi.advanceTimersByTimeAsync(10_000);
      await n.notifier.notify({ level: "digest", title: "Second news", body: "two", agentId: "assistant" });
      expect(await n.notifier.flushDigest()).toBe(1);
      // What landed in those 40 seconds is in no digest yet: this one brings it. What the first digest had already is not repeated.
      const goal = n.started[1].goal;
      expect(goal).toContain("Landed while it was written");
      expect(goal).toContain("Alert while it was written");
      expect(goal).not.toContain("Landed before the digest");
      n.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the assistant what already reached the person since the last digest", async () => {
    const n = setup();
    await n.notifier.notify({ level: "notify", title: "Ботсад закрыт 2 ноября", body: "Весь день.", agentId: "assistant" });
    await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    await n.notifier.flushDigest();
    expect(n.started[0].goal).toMatch(/Already told[^\n]*\n- \d\d:\d\d Ботсад закрыт 2 ноября/);
    n.notifier.stop();
  });

  it("clears its timers when stopped", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 1000 });
      await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
      await n.notifier.flushDigest();
      expect(vi.getTimerCount()).toBe(1);
      n.notifier.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(digestRow(n).delivered_at).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms no timer for a digest still being gathered when it is stopped, and does again once started", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 1000 });
      await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
      // A plugin's section keeps the gathering open while the notifier is stopped (a cluster standby, a shutdown).
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      n.hooks.register("digest.compose", "slow", async () => {
        await gate;
        return { title: "Slow", body: "late section" };
      });
      const flushing = n.notifier.flushDigest();
      n.notifier.stop();
      release();
      expect(await flushing).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(digestRow(n).delivered_at).toBeNull();
      // Led again: the digest the stop left open gets its time like after any restart.
      n.notifier.startDigestTimer();
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(digestRow(n).delivered_at).toBeTruthy();
      n.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the digest_now tool", () => {
  it("sends the digest now, and says so when nothing waits", async () => {
    const h = setup();
    const registry = new ToolRegistry();
    registerCoreTools({ registry, store: h.store, notifier: h.notifier } as unknown as CoreToolDeps);
    const call = () => registry.get("digest_now")!.invoke({}, { agentId: "assistant", conversationId: "c_1" } as never);
    const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
    expect(textOf(await call())).toBe("Nothing waits for a digest: nothing was sent.");
    await h.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    expect(textOf(await call())).toMatch(/being written from 1 item\(s\)/);
    expect(h.started).toHaveLength(1);
    h.notifier.stop();
  });
});
