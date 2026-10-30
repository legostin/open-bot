// Database replication between hub replicas (spec 2026-10-30-cluster-design.md, "2. Replicas → Database").
// Capture: plain SQL triggers note (table, primary key) in repl_pending, so writes from any process are seen.
// Drain: pending rows become repl_log entries carrying the full row and a hybrid logical clock.
// Apply: last writer wins per row by (hlc, origin); deletes leave tombstones; entries are kept for relay.
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { Hlc, parseHlc } from "./hlc.ts";

export interface ReplTable {
  name: string;
  pk: string[];
  /** rows kept local (never logged nor applied), by pk values */
  skip?: (pk: unknown[]) => boolean;
}

/** One row's version. JSON-safe as is: blobs in `row` are `{ "$b64": "..." }`. */
export interface ReplEntry {
  origin: string;
  seq: number;
  hlc: string;
  tbl: string;
  pk: unknown[];
  op: "upsert" | "delete";
  row: Record<string, unknown> | null;
}

export interface DbReplicatorOptions {
  db: DatabaseSync;
  /** This replica's id: the origin of the changes made here. */
  origin: string;
  tables: ReplTable[];
  now?: () => number;
  log?: (m: string) => void;
  /** After a commit, with the entries that changed local rows. */
  onApplied?: (entries: ReplEntry[]) => void;
}

const SCHEMA = `
create table if not exists repl_ctl(id integer primary key check (id = 1), applying integer not null default 0);
insert or ignore into repl_ctl(id, applying) values (1, 0);
create table if not exists repl_pending(id integer primary key, tbl text not null, pk text not null);
create table if not exists repl_log(origin text not null, seq integer not null, hlc text not null, tbl text not null, pk text not null,
  op text not null, row text, primary key(origin, seq));
create unique index if not exists repl_log_row on repl_log(origin, tbl, pk);
create index if not exists repl_log_hlc on repl_log(hlc);
create table if not exists repl_rows(tbl text not null, pk text not null, hlc text not null, origin text not null,
  deleted integer not null default 0, primary key(tbl, pk)) without rowid;
create table if not exists repl_vector(origin text primary key, seq integer not null);
create table if not exists repl_tables(tbl text primary key, columns text not null);
`;

const TRIGGERS = ["ins", "upd", "del"] as const;

type LogRow = { origin: string; seq: number; hlc: string; tbl: string; pk: string; op: string; row: string | null };

interface Waiter {
  vector: Record<string, number>;
  resolve: (changed: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class DbReplicator {
  readonly origin: string;
  private readonly db: DatabaseSync;
  private readonly tables = new Map<string, ReplTable>();
  private readonly clock: Hlc;
  private readonly log: (m: string) => void;
  private readonly onApplied: ((entries: ReplEntry[]) => void) | undefined;
  /** Installed tables (present here, triggers in place) and their columns. */
  private readonly columns = new Map<string, string[]>();
  private readonly statements = new Map<string, StatementSync>();
  private readonly waiters = new Set<Waiter>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private installed = false;

  constructor(o: DbReplicatorOptions) {
    if (!o.origin) throw new Error("DbReplicator: origin is required");
    this.db = o.db;
    this.origin = o.origin;
    this.clock = new Hlc(o.now);
    this.log = o.log ?? (() => {});
    this.onApplied = o.onApplied;
    for (const t of o.tables) {
      if (t.name.startsWith("repl_")) throw new Error(`DbReplicator: ${t.name} is a replication table`);
      if (!t.pk.length) throw new Error(`DbReplicator: ${t.name} has no primary key`);
      this.tables.set(t.name, t);
    }
  }

  /** The repl_* tables and the triggers. Idempotent; run on every start after migrations. */
  install(): void {
    this.outsideTx("install");
    this.statements.clear();
    this.columns.clear();
    this.tx(() => {
      this.db.exec(SCHEMA);
      this.setApplying(false);
      for (const r of this.all("select name, tbl_name from sqlite_master where type = 'trigger'")) {
        const tbl = String(r.tbl_name);
        if (!this.tables.has(tbl) && TRIGGERS.some((k) => r.name === triggerName(tbl, k))) this.db.exec(`drop trigger ${q(String(r.name))}`);
      }
      for (const r of this.all("select tbl from repl_tables")) {
        if (!this.tables.has(String(r.tbl))) this.st("delete from repl_tables where tbl = ?").run(String(r.tbl));
      }
      for (const t of this.tables.values()) this.installTable(t);
    });
    const last = this.st("select max(hlc) as hlc from repl_log").get();
    if (last?.hlc) this.clock.observe(String(last.hlc));
    this.installed = true;
  }

  /** Pending changes → repl_log. How many rows were logged. */
  drain(): number {
    // Before install() the tables are not known yet: what is pending would be dropped.
    // In a transaction left open across an await: entries must never be seen before they are committed.
    if (!this.installed || this.db.isTransaction) return 0;
    if (!this.st("select 1 from repl_pending limit 1").get()) return 0;
    const n = this.tx(() => this.drainPending());
    if (n) this.wake();
    return n;
  }

  /** The highest seq of each origin seen here, own and applied. */
  vector(): Record<string, number> {
    const v: Record<string, number> = {};
    for (const r of this.all("select origin, seq from repl_vector")) v[String(r.origin)] = Number(r.seq);
    return v;
  }

  /** Every logged entry a replica at `vector` has not seen: in clock order, each origin's in seq order. */
  changesSince(vector: Record<string, number>, limit = 1000): { entries: ReplEntry[]; more: boolean } {
    const max = Math.max(1, Math.floor(limit));
    const streams: { rows: LogRow[]; i: number }[] = [];
    for (const r of this.all("select origin from repl_vector")) {
      const rows = this.st("select origin, seq, hlc, tbl, pk, op, row from repl_log where origin = ? and seq > ? order by seq limit ?")
        .all(String(r.origin), seen(vector, String(r.origin)), max + 1) as LogRow[];
      if (rows.length) streams.push({ rows, i: 0 });
    }
    // Merging the origins' streams keeps each one a prefix, so a cut at the limit never skips an entry.
    const entries: ReplEntry[] = [];
    while (entries.length < max) {
      let best: { rows: LogRow[]; i: number } | undefined;
      for (const s of streams) {
        if (s.i < s.rows.length && (!best || before(s.rows[s.i], best.rows[best.i]))) best = s;
      }
      if (!best) break;
      entries.push(toEntry(best.rows[best.i++]));
    }
    return { entries, more: streams.some((s) => s.i < s.rows.length) };
  }

  apply(entries: ReplEntry[]): { applied: number; skipped: number } {
    if (!entries.length) return { applied: 0, skipped: 0 };
    if (!this.installed) throw new Error("DbReplicator.apply before install()");
    this.outsideTx("apply");
    const applied: ReplEntry[] = [];
    let changed = false;
    this.tx(() => {
      // Local changes first: they take their clock before the remote ones are weighed against them.
      if (this.drainPending()) changed = true;
      const start = this.vector();
      const top = new Map<string, number>();
      this.setApplying(true);
      try {
        for (const e of entries) {
          const r = this.applyEntry(e, start, top);
          if (r.stored) changed = true;
          if (r.written) applied.push(e);
        }
        for (const [origin, seq] of top) this.setVector(origin, seq);
      } finally {
        this.setApplying(false);
      }
    });
    if (changed) this.wake();
    if (applied.length && this.onApplied) {
      try {
        this.onApplied(applied);
      } catch (e) {
        this.log(`replication: onApplied failed: ${(e as Error).message}`);
      }
    }
    return { applied: applied.length, skipped: entries.length - applied.length };
  }

  /** True as soon as there are entries a replica at `vector` has not seen; false after `timeoutMs`. */
  async waitForChanges(vector: Record<string, number>, timeoutMs: number): Promise<boolean> {
    try {
      this.drain();
    } catch (e) {
      this.log(`replication: drain failed: ${(e as Error).message}`);
    }
    if (this.hasChangesSince(vector)) return true;
    return new Promise<boolean>((resolve) => {
      const w: Waiter = {
        vector,
        resolve: (changed) => {
          clearTimeout(w.timer);
          this.waiters.delete(w);
          resolve(changed);
        },
      };
      w.timer = setTimeout(() => w.resolve(false), timeoutMs);
      this.waiters.add(w);
    });
  }

  /** A consistent copy for a new replica (VACUUM INTO; `path` must not exist). It keeps the repl_* state. */
  snapshot(path: string): void {
    this.drain();
    this.db.prepare("vacuum into ?").run(path);
    // What is still pending is this replica's to log: the copy must not log it again as its own.
    const copy = new DatabaseSync(path);
    try {
      copy.exec("delete from repl_pending; update repl_ctl set applying = 0;");
    } finally {
      copy.close();
    }
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.drain();
      } catch (e) {
        this.log(`replication: drain failed: ${(e as Error).message}`);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const w of [...this.waiters]) w.resolve(false);
  }

  private installTable(t: ReplTable): void {
    const cols = this.all("select name from pragma_table_info(?)", t.name).map((r) => String(r.name));
    const missing = cols.length ? t.pk.filter((c) => !cols.includes(c)) : [];
    if (!cols.length || missing.length) {
      this.log(
        cols.length
          ? `replication: ${t.name} has no column ${missing.join(", ")}; its changes are only relayed`
          : `replication: no table ${t.name} here; its changes are only relayed`,
      );
      for (const k of TRIGGERS) this.db.exec(`drop trigger if exists ${q(triggerName(t.name, k))}`);
      this.st("delete from repl_tables where tbl = ?").run(t.name);
      return;
    }
    const known = this.st("select columns from repl_tables where tbl = ?").get(t.name);
    const before: string[] | null = known ? (JSON.parse(String(known.columns)) as string[]) : null;
    const changed = !before || before.join("\n") !== cols.join("\n");
    for (const [k, sql] of triggerSql(t)) {
      const name = triggerName(t.name, k);
      const have = this.st("select sql from sqlite_master where type = 'trigger' and name = ?").get(name);
      if (have && have.sql === sql && !changed) continue;
      if (have) this.db.exec(`drop trigger ${q(name)}`);
      this.db.exec(sql);
    }
    this.columns.set(t.name, cols);
    if (!changed) return;
    // A table or columns this replica did not have yet: what peers wrote there meanwhile is in the log.
    this.setApplying(true);
    try {
      this.catchUp(t, before ? cols.filter((c) => !before.includes(c)) : null);
    } finally {
      this.setApplying(false);
    }
    this.st("insert into repl_tables(tbl, columns) values (?, ?) on conflict(tbl) do update set columns = excluded.columns").run(
      t.name,
      JSON.stringify(cols),
    );
  }

  /** A new table gets each row's newest logged version; new columns get the newest logged value of each. */
  private catchUp(t: ReplTable, added: string[] | null): void {
    if (added && !added.length) return;
    const rows = this.st("select origin, seq, hlc, tbl, pk, op, row from repl_log where tbl = ? order by hlc desc, origin desc").all(
      t.name,
    ) as LogRow[];
    let n = 0;
    if (!added) {
      const done = new Set<string>();
      for (const r of rows) {
        if (done.has(r.pk)) continue;
        done.add(r.pk);
        const e = toEntry(r);
        if (!t.skip?.(e.pk) && this.writeIfNewer(t, e, r.pk)) n++;
      }
    } else {
      const fill = new Map<string, { pk: unknown[]; values: Map<string, unknown> }>();
      for (const r of rows) {
        if (r.op !== "upsert" || r.row === null) continue;
        const row = JSON.parse(r.row) as Record<string, unknown>;
        for (const c of added) {
          if (!Object.hasOwn(row, c)) continue;
          let f = fill.get(r.pk);
          if (!f) fill.set(r.pk, (f = { pk: JSON.parse(r.pk) as unknown[], values: new Map() }));
          if (!f.values.has(c)) f.values.set(c, row[c]);
        }
      }
      for (const f of fill.values()) {
        if (t.skip?.(f.pk)) continue;
        const set = [...f.values.keys()];
        try {
          const r = this.st(`update ${q(t.name)} set ${set.map((c) => `${q(c)} = ?`).join(", ")} where ${where(t)}`).run(
            ...set.map((c) => decodeValue(f.values.get(c))),
            ...f.pk.map(decodeValue),
          );
          n += Number(r.changes);
        } catch (e) {
          this.log(`replication: could not fill ${t.name} ${JSON.stringify(f.pk)}: ${(e as Error).message}`);
        }
      }
    }
    if (n) this.log(`replication: ${t.name}: ${n} rows caught up from the log`);
  }

  /** Inside a transaction. */
  private drainPending(): number {
    const pending = this.all("select id, tbl, pk from repl_pending order by id") as { id: number; tbl: string; pk: string }[];
    if (!pending.length) return 0;
    // Another process with this origin may have drained too: stay after its clock.
    const last = this.st("select hlc from repl_log where origin = ? order by seq desc limit 1").get(this.origin);
    if (last) this.clock.observe(String(last.hlc));
    let seq = Number(this.st("select seq from repl_vector where origin = ?").get(this.origin)?.seq ?? 0);
    const done = new Set<string>();
    let n = 0;
    for (const p of pending) {
      const t = this.tables.get(p.tbl);
      if (!t || !this.columns.has(t.name)) continue;
      let pk: unknown[];
      try {
        pk = JSON.parse(p.pk) as unknown[];
      } catch {
        continue;
      }
      if (!Array.isArray(pk) || pk.length !== t.pk.length) continue;
      const key = JSON.stringify(pk);
      if (done.has(`${t.name}\n${key}`)) continue;
      done.add(`${t.name}\n${key}`);
      if (t.skip?.(pk)) continue;
      const row = this.st(`select * from ${q(t.name)} where ${where(t)}`).get(...pk.map(decodeValue));
      const hlc = this.clock.now();
      this.logEntry({ origin: this.origin, seq: ++seq, hlc, tbl: t.name, pk, op: row ? "upsert" : "delete", row: row ? encodeRow(row) : null }, key);
      this.setVersion(t.name, key, hlc, this.origin, !row);
      n++;
    }
    if (n) this.setVector(this.origin, seq);
    this.st("delete from repl_pending where id <= ?").run(pending[pending.length - 1].id);
    return n;
  }

  /** Inside apply's transaction, with the triggers standing still. */
  private applyEntry(e: unknown, start: Record<string, number>, top: Map<string, number>): { stored: boolean; written: boolean } {
    const none = { stored: false, written: false };
    if (!validEntry(e)) {
      const from = e && typeof e === "object" ? (e as { origin?: unknown }).origin : undefined;
      this.log(`replication: dropped a malformed entry${typeof from === "string" ? ` from ${from}` : ""}`);
      return none;
    }
    if (e.seq <= seen(start, e.origin)) return none;
    top.set(e.origin, Math.max(top.get(e.origin) ?? 0, e.seq));
    const t = this.tables.get(e.tbl);
    if (t?.skip?.(e.pk)) return none;
    this.clock.observe(e.hlc);
    const key = JSON.stringify(e.pk);
    const stored = this.logEntry(e, key);
    // A table this replica does not have (yet): only relayed; install() catches up once it is here.
    if (!t || !this.columns.has(t.name)) return { stored, written: false };
    return { stored, written: this.writeIfNewer(t, e, key) };
  }

  private writeIfNewer(t: ReplTable, e: ReplEntry, key: string): boolean {
    const cur = this.st("select hlc, origin from repl_rows where tbl = ? and pk = ?").get(t.name, key);
    if (cur && !newer(e, String(cur.hlc), String(cur.origin))) return false;
    if (e.pk.length !== t.pk.length) {
      this.log(`replication: ${t.name} ${key} from ${e.origin} has another primary key`);
      return false;
    }
    this.db.exec("savepoint repl_entry");
    try {
      const pk = e.pk.map(decodeValue);
      if (e.op === "delete") this.st(`delete from ${q(t.name)} where ${where(t)}`).run(...pk);
      else this.writeRow(t, e.row ?? {}, pk);
      this.setVersion(t.name, key, e.hlc, e.origin, e.op === "delete");
      this.db.exec("release repl_entry");
      return true;
    } catch (err) {
      this.db.exec("rollback to repl_entry; release repl_entry");
      this.log(`replication: could not write ${t.name} ${key} from ${e.origin}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Only the columns this table has: one a peer lacks keeps its value here (its default on insert). */
  private writeRow(t: ReplTable, row: Record<string, unknown>, pk: SQLInputValue[]): void {
    const values = new Map<string, SQLInputValue>();
    for (const c of this.columns.get(t.name) ?? []) if (Object.hasOwn(row, c)) values.set(c, decodeValue(row[c]));
    t.pk.forEach((c, i) => values.set(c, pk[i]));
    if (this.st(`select 1 from ${q(t.name)} where ${where(t)}`).get(...pk)) {
      const set = [...values.keys()].filter((c) => !t.pk.includes(c));
      if (set.length) {
        this.st(`update ${q(t.name)} set ${set.map((c) => `${q(c)} = ?`).join(", ")} where ${where(t)}`).run(
          ...set.map((c) => values.get(c) ?? null),
          ...pk,
        );
      }
      return;
    }
    const cols = [...values.keys()];
    this.st(`insert into ${q(t.name)}(${cols.map(q).join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(
      ...cols.map((c) => values.get(c) ?? null),
    );
  }

  /** The newest entry per (origin, row) is kept. False when the log already has this one or a newer one. */
  private logEntry(e: ReplEntry, key: string): boolean {
    const cur = this.st("select seq from repl_log where origin = ? and tbl = ? and pk = ?").get(e.origin, e.tbl, key);
    if (cur && Number(cur.seq) >= e.seq) return false;
    if (cur) this.st("delete from repl_log where origin = ? and tbl = ? and pk = ?").run(e.origin, e.tbl, key);
    const r = this.st("insert or ignore into repl_log(origin, seq, hlc, tbl, pk, op, row) values (?, ?, ?, ?, ?, ?, ?)").run(
      e.origin,
      e.seq,
      e.hlc,
      e.tbl,
      key,
      e.op,
      e.row === null ? null : JSON.stringify(e.row),
    );
    return Number(r.changes) > 0;
  }

  private setVersion(tbl: string, key: string, hlc: string, origin: string, deleted: boolean): void {
    this.st(
      "insert into repl_rows(tbl, pk, hlc, origin, deleted) values (?, ?, ?, ?, ?) " +
        "on conflict(tbl, pk) do update set hlc = excluded.hlc, origin = excluded.origin, deleted = excluded.deleted",
    ).run(tbl, key, hlc, origin, deleted ? 1 : 0);
  }

  private setVector(origin: string, seq: number): void {
    this.st("insert into repl_vector(origin, seq) values (?, ?) on conflict(origin) do update set seq = max(seq, excluded.seq)").run(origin, seq);
  }

  private setApplying(on: boolean): void {
    this.st("insert or replace into repl_ctl(id, applying) values (1, ?)").run(on ? 1 : 0);
  }

  private hasChangesSince(vector: Record<string, number>): boolean {
    for (const r of this.all("select origin from repl_vector")) {
      const origin = String(r.origin);
      if (this.st("select 1 from repl_log where origin = ? and seq > ? limit 1").get(origin, seen(vector, origin))) return true;
    }
    return false;
  }

  private wake(): void {
    for (const w of [...this.waiters]) if (this.hasChangesSince(w.vector)) w.resolve(true);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const r = fn();
      this.db.exec("commit");
      return r;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  private outsideTx(what: string): void {
    if (this.db.isTransaction) throw new Error(`DbReplicator.${what} inside an open transaction`);
  }

  private st(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private all(sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] {
    return this.st(sql).all(...params);
  }
}

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function where(t: ReplTable): string {
  return t.pk.map((c) => `${q(c)} = ?`).join(" and ");
}

function triggerName(tbl: string, kind: (typeof TRIGGERS)[number]): string {
  return `repl_${tbl}_${kind}`;
}

/** Plain SQL only (json_array is built into SQLite), so the sqlite3 shell and other processes are captured too. */
function triggerSql(t: ReplTable): [(typeof TRIGGERS)[number], string][] {
  const tbl = q(t.name);
  const lit = `'${t.name.replaceAll("'", "''")}'`;
  const pk = (row: "new" | "old") => `json_array(${t.pk.map((c) => `${row}.${q(c)}`).join(", ")})`;
  const when = "when (select applying from repl_ctl) is not 1";
  const note = (row: "new" | "old") => `insert into repl_pending(tbl, pk) values (${lit}, ${pk(row)});`;
  const moved = t.pk.map((c) => `old.${q(c)} is not new.${q(c)}`).join(" or ");
  const create = (k: (typeof TRIGGERS)[number], event: string, body: string) =>
    `CREATE TRIGGER ${q(triggerName(t.name, k))} after ${event} on ${tbl} ${when} begin ${body} end`;
  return [
    ["ins", create("ins", "insert", note("new"))],
    // A changed primary key: the old row is gone.
    ["upd", create("upd", "update", `${note("new")} insert into repl_pending(tbl, pk) select ${lit}, ${pk("old")} where ${moved};`)],
    ["del", create("del", "delete", note("old"))],
  ];
}

function seen(vector: Record<string, number>, origin: string): number {
  const v = Object.hasOwn(vector, origin) ? Number(vector[origin]) : 0;
  return Number.isFinite(v) ? v : 0;
}

function before(a: LogRow, b: LogRow): boolean {
  return a.hlc < b.hlc || (a.hlc === b.hlc && a.origin < b.origin);
}

function newer(e: ReplEntry, hlc: string, origin: string): boolean {
  return e.hlc > hlc || (e.hlc === hlc && e.origin > origin);
}

function toEntry(r: LogRow): ReplEntry {
  return {
    origin: r.origin,
    seq: Number(r.seq),
    hlc: r.hlc,
    tbl: r.tbl,
    pk: JSON.parse(r.pk) as unknown[],
    op: r.op === "delete" ? "delete" : "upsert",
    row: r.row === null ? null : (JSON.parse(r.row) as Record<string, unknown>),
  };
}

function validEntry(e: unknown): e is ReplEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<ReplEntry>;
  return (
    typeof x.origin === "string" &&
    x.origin !== "" &&
    Number.isSafeInteger(x.seq) &&
    (x.seq as number) > 0 &&
    parseHlc(x.hlc) !== null &&
    typeof x.tbl === "string" &&
    Array.isArray(x.pk) &&
    x.pk.length > 0 &&
    (x.op === "delete" || (x.op === "upsert" && !!x.row && typeof x.row === "object" && !Array.isArray(x.row)))
  );
}

export function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
  return out;
}

function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  // Integer affinity turns the text back into the integer.
  if (typeof v === "bigint") return v.toString();
  return v;
}

export function decodeValue(v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string") {
    return new Uint8Array(Buffer.from((v as { $b64: string }).$b64, "base64"));
  }
  throw new Error(`unsupported value ${JSON.stringify(v)}`);
}
