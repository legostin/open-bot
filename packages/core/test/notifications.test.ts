// Notifications as an Inbox: storage, intake, reports, the digest the assistant writes, the Inbox read model
// (docs/superpowers/specs/2026-10-31-notifications-inbox-design.md).

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";

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
