// Append-only audit log with a hash chain: hash = sha256(prevHash + canonical record).

import { createHash } from "node:crypto";
import type { AuditEntry } from "@openbot/shared";
import { nowIso } from "@openbot/shared";
import { json, type Db } from "./db.ts";
import type { Redactor } from "./vault/redact.ts";

const GENESIS = "0".repeat(64);

function digest(prevHash: string, e: { ts: string; actor: string; action: string; target?: string; data?: string }): string {
  return createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(JSON.stringify([e.ts, e.actor, e.action, e.target ?? null, e.data ?? null]))
    .digest("hex");
}

export class AuditLog {
  db: Db;
  redactor?: Redactor;
  constructor(db: Db, redactor?: Redactor) {
    this.db = db;
    this.redactor = redactor;
  }

  append(actor: string, action: string, target?: string, data?: unknown): AuditEntry {
    const ts = nowIso();
    const dataStr = data === undefined ? undefined : JSON.stringify(this.redactor ? this.redactor.value(data) : data);
    const last = this.db.prepare("select hash from audit order by seq desc limit 1").get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS;
    const hash = digest(prevHash, { ts, actor, action, target, data: dataStr });
    const r = this.db
      .prepare("insert into audit(ts, actor, action, target, data, prev_hash, hash) values (?,?,?,?,?,?,?)")
      .run(ts, actor, action, target ?? null, dataStr ?? null, prevHash, hash);
    return { seq: Number(r.lastInsertRowid), ts, actor, action, target, data, prevHash, hash };
  }

  list(opts: { limit?: number; before?: number; action?: string } = {}): AuditEntry[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.before) {
      where.push("seq < ?");
      args.push(opts.before);
    }
    if (opts.action) {
      where.push("action like ?");
      args.push(opts.action.replace(/\*/g, "%"));
    }
    const sql = `select * from audit ${where.length ? "where " + where.join(" and ") : ""} order by seq desc limit ?`;
    return this.db
      .prepare(sql)
      .all(...args, limit)
      .map((r: any) => ({
        seq: r.seq,
        ts: r.ts,
        actor: r.actor,
        action: r.action,
        target: r.target ?? undefined,
        data: json(r.data, undefined),
        prevHash: r.prev_hash,
        hash: r.hash,
      }));
  }

  /** Walk the whole chain. Returns the first broken seq, if any. */
  verify(): { ok: boolean; count: number; brokenAt?: number } {
    let prev = GENESIS;
    let count = 0;
    for (const r of this.db.prepare("select * from audit order by seq asc").iterate() as Iterable<any>) {
      const expected = digest(prev, { ts: r.ts, actor: r.actor, action: r.action, target: r.target ?? undefined, data: r.data ?? undefined });
      if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, count, brokenAt: r.seq };
      prev = r.hash;
      count++;
    }
    return { ok: true, count };
  }
}
