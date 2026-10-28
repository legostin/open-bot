// One-time invites for any device: the code in a /join link, a phone's QR or the hub CLI pairs either a computer (a
// machine) or a phone, once, within an hour. The first device to use it wins.

import { randomBytes } from "node:crypto";
import { nowIso } from "@owlbot/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { AuditLog } from "./audit.ts";

export const INVITE_TTL = 60 * 60_000;

/** "ab12-cd34" as typed or read aloud → "AB12CD34". */
export const normalizeInviteCode = (code: unknown): string =>
  String(code ?? "")
    .replace(/[\s-]/g, "")
    .toUpperCase();

export class InviteRegistry {
  db: Db;
  bus: EventBus;
  audit: AuditLog;

  constructor(d: { db: Db; bus: EventBus; audit: AuditLog }) {
    this.db = d.db;
    this.bus = d.bus;
    this.audit = d.audit;
  }

  create(): { code: string; expiresAt: string } {
    this.db.prepare("delete from invites where expires_at < ?").run(nowIso());
    // 8 of [A-Z0-9]: the format the phone app reads from its link.
    const code = randomBytes(8).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toUpperCase().padEnd(8, "X").slice(0, 8);
    const expiresAt = new Date(Date.now() + INVITE_TTL).toISOString();
    this.db.prepare("insert into invites(code, expires_at) values (?,?)").run(code, expiresAt);
    this.audit.append("user", "invite.create");
    return { code, expiresAt };
  }

  /** Unused and not expired. */
  valid(code: string): boolean {
    return !!this.db.prepare("select 1 from invites where code = ? and used_at is null and expires_at > ?").get(normalizeInviteCode(code), nowIso());
  }

  /** Marks the invite used by `by`; false when it is unknown, used or expired. One caller wins a race. */
  consume(code: string, by: string): boolean {
    const r = this.db.prepare("update invites set used_at = ?, used_by = ? where code = ? and used_at is null and expires_at > ?").run(nowIso(), by, normalizeInviteCode(code), nowIso());
    return r.changes === 1;
  }

  /** Called once the device behind a consumed invite exists: the card and pages that show the invite close. */
  joined(code: string, kind: "machine" | "device", name: string): void {
    this.bus.emit("invite.used", { code: normalizeInviteCode(code), kind, name });
  }

  revoke(code: string): boolean {
    const r = this.db.prepare("delete from invites where code = ? and used_at is null").run(normalizeInviteCode(code));
    if (r.changes) this.audit.append("user", "invite.revoke");
    return r.changes === 1;
  }
}
