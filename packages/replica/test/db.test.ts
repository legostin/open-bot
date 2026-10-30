import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DbReplicator, Hlc, parseHlc, type ReplEntry, type ReplTable } from "../src/index.ts";

const T0 = Date.parse("2026-10-30T12:00:00Z");

const SCHEMA = `
create table conversations(id text primary key, title text not null, updated_at text not null);
create table messages(id text primary key, conversation_id text not null, text text not null, data blob);
create table settings(key text primary key, value text not null);
create table plugin_kv(plugin_id text not null, key text not null, value text not null, primary key(plugin_id, key));
create table usage(day text not null, agent_id text not null, kind text not null, count integer not null default 0,
  primary key(day, agent_id, kind));
`;

const TABLES: ReplTable[] = [
  { name: "conversations", pk: ["id"] },
  { name: "messages", pk: ["id"] },
  { name: "settings", pk: ["key"], skip: (pk) => String(pk[0]).startsWith("local.") },
  { name: "plugin_kv", pk: ["plugin_id", "key"] },
  { name: "usage", pk: ["day", "agent_id", "kind"] },
  { name: "pages", pk: ["id"] },
];

type Replica = ReturnType<typeof replica>;

/** A hub replica on its own database and clock; `at(ms)` sets the wall time its next changes are stamped with. */
function replica(origin: string, o: { file?: string; schema?: string; tables?: ReplTable[] } = {}) {
  let time = T0;
  const db = new DatabaseSync(o.file ?? ":memory:");
  if (o.file) db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
  db.exec(o.schema ?? SCHEMA);
  const logs: string[] = [];
  const applied: ReplEntry[][] = [];
  const r = new DbReplicator({
    db,
    origin,
    tables: o.tables ?? TABLES,
    now: () => time,
    log: (m) => logs.push(m),
    onApplied: (e) => applied.push(e),
  });
  r.install();
  return {
    db,
    r,
    logs,
    applied,
    at: (ms: number) => {
      time = T0 + ms;
    },
    run: (sql: string, ...params: (string | number | null | Uint8Array)[]) => db.prepare(sql).run(...params),
    rows: (sql: string) => db.prepare(sql).all().map((x) => ({ ...x })),
  };
}

/** `to` pulls from `from` everything it has not seen, a few entries at a time, through JSON like the wire. */
function pull(to: Replica, from: Replica, limit = 2): number {
  from.r.drain();
  let applied = 0;
  for (;;) {
    const { entries, more } = from.r.changesSince(to.r.vector(), limit);
    applied += to.r.apply(JSON.parse(JSON.stringify(entries)) as ReplEntry[]).applied;
    if (!more) return applied;
  }
}

function sync(...replicas: Replica[]): void {
  for (const a of replicas) for (const b of replicas) if (a !== b) pull(a, b);
}

const conv = (x: Replica) => x.rows("select * from conversations order by id");
const msgs = (x: Replica) => x.rows("select id, conversation_id, text from messages order by id");

describe("hybrid logical clock", () => {
  it("only moves forward and sorts as text in time order", () => {
    let wall = T0;
    const c = new Hlc(() => wall);
    const a = c.now();
    const b = c.now();
    wall -= 5000; // the wall clock jumps back
    const d = c.now();
    wall = T0 + 1;
    const e = c.now();
    expect([a, b, d, e]).toEqual([...new Set([a, b, d, e])].sort());
    expect(parseHlc(a)).toEqual({ ms: T0, counter: 0 });
    expect(parseHlc(d)).toEqual({ ms: T0, counter: 2 });
    expect(parseHlc(e)).toEqual({ ms: T0 + 1, counter: 0 });
  });

  it("comes after a time seen from another replica", () => {
    const c = new Hlc(() => T0);
    const remote = new Hlc(() => T0 + 60_000).now();
    c.observe(remote);
    expect(c.now() > remote).toBe(true);
    c.observe("garbage");
    expect(parseHlc("garbage")).toBeNull();
    expect(parseHlc(c.now())?.ms).toBe(T0 + 60_000);
  });
});

describe("database replication", () => {
  it("carries inserts, updates and deletes to another replica", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    a.run("insert into messages values ('m1', 'c1', 'hi', null), ('m2', 'c1', 'there', null)");
    expect(pull(b, a)).toBe(3);
    expect(conv(b)).toEqual(conv(a));
    expect(msgs(b)).toEqual(msgs(a));

    a.run("update conversations set title = 'Renamed' where id = 'c1'");
    a.run("delete from messages where id = 'm2'");
    expect(pull(b, a)).toBe(2);
    expect(conv(b)).toEqual([{ id: "c1", title: "Renamed", updated_at: "t1" }]);
    expect(msgs(b)).toEqual([{ id: "m1", conversation_id: "c1", text: "hi" }]);
    expect(b.applied.flat().map((e) => `${e.op} ${e.tbl} ${JSON.stringify(e.pk)}`)).toContain('delete messages ["m2"]');

    // Nothing new: nothing applied.
    expect(pull(b, a)).toBe(0);
    expect(b.r.vector()).toEqual({ a: 5 });
  });

  it("does not capture what it applies", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    pull(b, a);
    expect(b.rows("select count(*) n from repl_pending")).toEqual([{ n: 0 }]);
    expect(b.rows("select applying from repl_ctl")).toEqual([{ applying: 0 }]);
    expect(b.r.drain()).toBe(0);
    expect(b.r.vector()).toEqual({ a: 1 });
    // Its own writes after that are captured again.
    b.run("update conversations set title = 'Mine' where id = 'c1'");
    expect(b.r.drain()).toBe(1);
    expect(b.r.vector()).toEqual({ a: 1, b: 1 });
  });

  it("settles concurrent edits of one row on the same value everywhere (last writer wins)", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    sync(a, b);

    a.at(100);
    a.run("update conversations set title = 'from a' where id = 'c1'");
    b.at(200);
    b.run("update conversations set title = 'from b' where id = 'c1'");
    sync(a, b);
    expect(conv(a)).toEqual([{ id: "c1", title: "from b", updated_at: "t1" }]);
    expect(conv(b)).toEqual(conv(a));

    // The same clock time on both: the origin decides, the same way on both sides.
    a.at(300);
    b.at(300);
    a.run("update conversations set title = 'tie a' where id = 'c1'");
    b.run("update conversations set title = 'tie b' where id = 'c1'");
    a.r.drain();
    b.r.drain();
    expect(a.r.changesSince(b.r.vector()).entries[0].hlc).toBe(b.r.changesSince(a.r.vector()).entries[0].hlc);
    sync(b, a);
    expect(conv(a)[0].title).toBe("tie b");
    expect(conv(b)[0].title).toBe("tie b");
  });

  it("keeps a row deleted against an older concurrent update", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    sync(a, b);

    b.at(100);
    b.run("update conversations set title = 'edited' where id = 'c1'");
    a.at(200);
    a.run("delete from conversations where id = 'c1'");
    pull(a, b); // the older update reaches the replica that deleted the row
    pull(b, a);
    expect(conv(a)).toEqual([]);
    expect(conv(b)).toEqual([]);
    for (const x of [a, b]) {
      expect(x.rows("select pk, origin, deleted from repl_rows where tbl = 'conversations'")).toEqual([
        { pk: '["c1"]', origin: "a", deleted: 1 },
      ]);
    }

    // A replica that hears of the update only now does not bring the row back either.
    const c = replica("c");
    pull(c, a);
    pull(c, b);
    expect(conv(c)).toEqual([]);
  });

  it("relays changes through a replica in the middle", () => {
    const a = replica("a");
    const b = replica("b");
    const c = replica("c");
    a.run("insert into conversations values ('c1', 'From A', 't1')");
    a.run("insert into messages values ('m1', 'c1', 'one', null)");
    pull(b, a);
    expect(pull(c, b)).toBe(2);
    expect(conv(c)).toEqual(conv(a));
    expect(c.r.vector()).toEqual({ a: 2 });

    c.run("insert into messages values ('m2', 'c1', 'from c', null)");
    pull(b, c);
    expect(pull(a, b)).toBe(1); // only C's: its own come back already seen
    expect(msgs(a)).toEqual(msgs(c));
    expect(a.r.vector()).toEqual({ a: 2, c: 1 });
    expect(b.r.changesSince(a.r.vector()).entries).toEqual([]);
  });

  it("handles composite and key/value primary keys, a changed key included", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into settings values ('theme', 'amber'), ('lang', 'en')");
    a.run("insert into plugin_kv values ('p1', 'k1', 'v1'), ('p1', 'k2', 'v2'), ('p2', 'k1', 'other')");
    a.run("insert into usage(day, agent_id, kind, count) values ('2026-10-30', 'owl', 'turn', 1), ('2026-10-30', 'owl', 'tool', 4)");
    pull(b, a);
    a.run("update settings set value = 'ru' where key = 'lang'");
    a.run("update plugin_kv set key = 'k3' where plugin_id = 'p1' and key = 'k1'");
    a.run("update usage set count = count + 1 where kind = 'turn'");
    a.run("delete from usage where kind = 'tool'");
    pull(b, a);
    for (const sql of ["select * from settings order by key", "select * from plugin_kv order by plugin_id, key", "select * from usage"]) {
      expect(b.rows(sql)).toEqual(a.rows(sql));
    }
    expect(b.rows("select key from plugin_kv where plugin_id = 'p1' order by key")).toEqual([{ key: "k2" }, { key: "k3" }]);
    expect(b.rows("select count from usage")).toEqual([{ count: 2 }]);
  });

  it("keeps rows a table marks local on each replica", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into settings values ('local.name', 'mac'), ('shared', 'x')");
    b.run("insert into settings values ('local.name', 'vps')");
    sync(a, b);
    expect(a.rows("select * from settings order by key")).toEqual([
      { key: "local.name", value: "mac" },
      { key: "shared", value: "x" },
    ]);
    expect(b.rows("select * from settings order by key")).toEqual([
      { key: "local.name", value: "vps" },
      { key: "shared", value: "x" },
    ]);
    expect(a.rows("select pk from repl_log where tbl = 'settings'")).toEqual([{ pk: '["shared"]' }]);

    // Sent anyway (a peer with other rules): not applied, but seen.
    const entry: ReplEntry = { origin: "z", seq: 1, hlc: new Hlc(() => T0 + 1e6).now(), tbl: "settings", pk: ["local.name"], op: "upsert", row: { key: "local.name", value: "z" } };
    expect(b.r.apply([entry])).toEqual({ applied: 0, skipped: 1 });
    expect(b.rows("select value from settings where key = 'local.name'")).toEqual([{ value: "vps" }]);
    expect(b.r.vector().z).toBe(1);
  });

  it("carries blobs through JSON", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into messages values ('m1', 'c1', 'bin', ?)", new Uint8Array([0, 255, 1, 2]));
    a.r.drain();
    expect(a.r.changesSince({}).entries[0].row?.data).toEqual({ $b64: "AP8BAg==" });
    pull(b, a);
    expect(b.rows("select data from messages")).toEqual([{ data: new Uint8Array([0, 255, 1, 2]) }]);
  });

  it("writes only the columns a replica has", () => {
    const newer = SCHEMA.replace("data blob)", "data blob, extra text)").replace(
      "updated_at text not null)",
      "updated_at text not null, kind text not null)",
    );
    const a = replica("a");
    const n = replica("n", { schema: newer });
    // From the newer one: the column this replica lacks is left out.
    n.run("insert into messages values ('m1', 'c1', 'hi', null, 'kept')");
    expect(pull(a, n)).toBe(1);
    expect(msgs(a)).toEqual([{ id: "m1", conversation_id: "c1", text: "hi" }]);

    // From the older one: the newer keeps its value of the column the older does not have.
    a.run("update messages set text = 'edited' where id = 'm1'");
    expect(pull(n, a)).toBe(1);
    expect(n.rows("select text, extra from messages")).toEqual([{ text: "edited", extra: "kept" }]);

    // A row the newer one cannot insert (a required column it has and the older lacks): skipped, logged, kept for relay.
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    a.run("insert into messages values ('m2', 'c1', 'next', null)");
    expect(pull(n, a)).toBe(1);
    expect(conv(n)).toEqual([]);
    expect(n.logs.some((m) => m.includes("could not write conversations"))).toBe(true);
    const c = replica("c");
    pull(c, n);
    expect(conv(c)).toEqual([{ id: "c1", title: "Hello", updated_at: "t1" }]);
  });

  it("catches up a table or a column it gains later from the log", () => {
    const newer = `${SCHEMA}\ncreate table pages(id text primary key, title text not null);\n`.replace("data blob)", "data blob, extra text)");
    const n = replica("n", { schema: newer });
    const o = replica("o");
    expect(o.logs.some((m) => m.includes("no table pages"))).toBe(true);
    n.run("insert into pages values ('p1', 'Page')");
    n.run("insert into messages values ('m1', 'c1', 'hi', null, 'x1')");
    n.run("insert into messages values ('m2', 'c1', 'yo', null, 'x2')");
    pull(o, n);
    expect(o.rows("select count(*) n from repl_log where tbl = 'pages'")).toEqual([{ n: 1 }]);
    // The older one edits m2 while it cannot see the new column.
    o.run("update messages set text = 'yo!' where id = 'm2'");
    pull(n, o);
    expect(n.rows("select id, text, extra from messages order by id")).toEqual([
      { id: "m1", text: "hi", extra: "x1" },
      { id: "m2", text: "yo!", extra: "x2" },
    ]);

    // The older one upgrades: migrations, then install().
    o.db.exec("create table pages(id text primary key, title text not null); alter table messages add column extra text;");
    o.r.install();
    expect(o.rows("select * from pages")).toEqual([{ id: "p1", title: "Page" }]);
    expect(o.rows("select id, text, extra from messages order by id")).toEqual(n.rows("select id, text, extra from messages order by id"));
    // Catching up is not a change of its own.
    expect(o.r.drain()).toBe(0);
    o.run("insert into pages values ('p2', 'Mine')");
    pull(n, o);
    expect(n.rows("select id from pages order by id")).toEqual([{ id: "p1" }, { id: "p2" }]);
  });

  it("captures writes from another connection to the same file (the CLI, a sqlite3 shell)", () => {
    const dir = mkdtempSync(join(tmpdir(), "owl-repl-"));
    const file = join(dir, "hub.db");
    const a = replica("a", { file });
    const b = replica("b");
    const cli = new DatabaseSync(file);
    cli.exec("pragma busy_timeout = 5000");
    cli.exec("insert into conversations values ('c1', 'From the CLI', 't1')");
    cli.exec("insert into settings values ('shared', 'x')");
    cli.exec("delete from settings where key = 'shared'");
    cli.close();
    expect(a.r.drain()).toBe(2);
    pull(b, a);
    expect(conv(b)).toEqual([{ id: "c1", title: "From the CLI", updated_at: "t1" }]);
    expect(a.rows("select op from repl_log where tbl = 'settings'")).toEqual([{ op: "delete" }]);
    a.db.close();
  });

  it("after a restart keeps what was pending and stamps after its log, even with the wall clock behind", () => {
    const file = join(mkdtempSync(join(tmpdir(), "owl-repl-")), "hub.db");
    const a = replica("a", { file });
    a.at(60_000);
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    a.r.drain();
    const first = a.r.changesSince({}).entries[0].hlc;
    a.run("update conversations set title = 'Pending' where id = 'c1'");
    a.db.close();

    const db = new DatabaseSync(file);
    const r = new DbReplicator({ db, origin: "a", tables: TABLES, now: () => T0 });
    expect(r.drain()).toBe(0); // before install() nothing is taken
    r.install();
    expect(r.drain()).toBe(1);
    const { entries } = r.changesSince({});
    expect(entries.map((e) => [e.seq, e.row?.title])).toEqual([[2, "Pending"]]);
    expect(entries[0].hlc > first).toBe(true);
    db.close();
  });

  it("keeps one log entry per row and origin", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into conversations values ('c1', 'v0', 't1')");
    for (let i = 1; i <= 5; i++) {
      a.run("update conversations set title = ? where id = 'c1'", `v${i}`);
      a.r.drain();
    }
    expect(a.rows("select origin, seq from repl_log")).toEqual([{ origin: "a", seq: 5 }]);
    pull(b, a);
    b.run("update conversations set title = 'from b' where id = 'c1'");
    b.r.drain();
    b.run("update conversations set title = 'from b again' where id = 'c1'");
    b.r.drain();
    expect(b.rows("select origin, seq from repl_log order by origin")).toEqual([
      { origin: "a", seq: 5 },
      { origin: "b", seq: 2 },
    ]);
    const c = replica("c");
    pull(c, b);
    expect(conv(c)[0].title).toBe("from b again");
  });

  it("drops what it cannot read without failing the rest", () => {
    const a = replica("a");
    const b = replica("b");
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    a.r.drain();
    const good = a.r.changesSince({}).entries;
    const bad = [{ origin: "x" }, null, { ...good[0], seq: -1 }, { ...good[0], hlc: "yesterday" }] as unknown as ReplEntry[];
    expect(b.r.apply([...bad, ...good])).toEqual({ applied: 1, skipped: 4 });
    expect(conv(b)).toEqual(conv(a));
  });

  it("waits for changes: wakes on a new write or relayed entry, times out otherwise", async () => {
    const a = replica("a");
    const b = replica("b");
    expect(await a.r.waitForChanges(a.r.vector(), 20)).toBe(false);

    const woke = a.r.waitForChanges(a.r.vector(), 5000);
    a.r.start(10);
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    expect(await woke).toBe(true);
    a.r.stop();

    // Already there: at once.
    expect(await a.r.waitForChanges({}, 5000)).toBe(true);
    // A peer waiting on B wakes when B applies what A sent.
    const relayed = b.r.waitForChanges(b.r.vector(), 5000);
    pull(b, a);
    expect(await relayed).toBe(true);
    // Stopping ends the waits.
    const cut = b.r.waitForChanges(b.r.vector(), 5000);
    b.r.stop();
    expect(await cut).toBe(false);
  });

  it("makes a snapshot a new replica opens and goes on replicating from", () => {
    const dir = mkdtempSync(join(tmpdir(), "owl-repl-"));
    const a = replica("a");
    const b = replica("b");
    b.run("insert into conversations values ('c0', 'From B', 't0')");
    pull(a, b);
    a.run("insert into conversations values ('c1', 'Hello', 't1')");
    a.run("insert into messages values ('m1', 'c1', 'hi', null)");
    const path = join(dir, "copy.db");
    a.r.snapshot(path);

    const c = replica("c", { file: path, schema: "" });
    expect(c.r.vector()).toEqual(a.r.vector());
    expect(conv(c)).toEqual(conv(a));
    expect(pull(c, a)).toBe(0);

    c.run("update conversations set title = 'From C' where id = 'c1'");
    a.run("insert into messages values ('m2', 'c1', 'more', null)");
    expect(pull(a, c)).toBe(1);
    expect(pull(c, a)).toBe(1);
    expect(pull(b, c)).toBe(4); // A's three rows and C's edit, all through C
    for (const x of [b, c]) {
      expect(conv(x)).toEqual(conv(a));
      expect(msgs(x)).toEqual(msgs(a));
    }
    c.db.close();
  });

  it("installs idempotently and puts triggers back after a table is rebuilt", () => {
    const a = replica("a");
    const triggers = () => a.rows("select name, sql from sqlite_master where type = 'trigger' order by name");
    const before = triggers();
    expect(before).toHaveLength(15);
    a.r.install();
    expect(triggers()).toEqual(before);

    // A migration that rebuilds a table drops its triggers.
    a.db.exec(`
      create table conversations_new(id text primary key, title text not null, updated_at text not null, pinned integer not null default 0);
      insert into conversations_new(id, title, updated_at) select id, title, updated_at from conversations;
      drop table conversations;
      alter table conversations_new rename to conversations;
    `);
    a.r.install();
    a.run("insert into conversations(id, title, updated_at) values ('c1', 'Hello', 't1')");
    expect(a.r.drain()).toBe(1);

    // A table no longer replicated loses its triggers.
    const fewer = new DbReplicator({ db: a.db, origin: "a", tables: TABLES.filter((t) => t.name !== "usage") });
    fewer.install();
    expect(a.rows("select name from sqlite_master where type = 'trigger' and tbl_name = 'usage'")).toEqual([]);
  });
});
