import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  create table meta(key text primary key, value text);
  create table settings(key text primary key, value text not null);
  create table conversations(id text primary key, kind text not null, title text not null, agent_id text not null, task_id text, created_at text not null, updated_at text not null);
  create table messages(id text primary key, conversation_id text not null, role text not null, parts text not null, status text not null, agent_id text, task_id text, brain_ref text, channel text, created_at text not null);
  create index messages_conv on messages(conversation_id, created_at);
  create table tasks(id text primary key, conversation_id text not null, parent_conversation_id text, parent_task_id text, agent_id text not null, title text not null, goal text not null, status text not null, brain_ref text, created_by text not null, trigger_id text, background integer not null default 0, result text, error text, resume_at text, created_at text not null, updated_at text not null);
  create index tasks_status on tasks(status);
  create table sessions(id text primary key, conversation_id text not null, task_id text, agent_id text not null, brain_ref text not null, resume_token text, tainted integer not null default 0, status text not null, background integer not null default 0, token_hash text, created_at text not null, updated_at text not null);
  create index sessions_conv on sessions(conversation_id);
  create index sessions_token on sessions(token_hash);
  create table approvals(id text primary key, session_id text not null, conversation_id text not null, task_id text, agent_id text not null, tool text not null, input text not null, summary text not null, effect text not null, tainted integer not null, status text not null, result text, created_at text not null, resolved_at text, resolved_via text, reminded integer not null default 0);
  create index approvals_status on approvals(status);
  create table approved_targets(value text primary key, created_at text not null);
  create table rules(id text primary key, tool text not null, agent_id text, conditions text not null, decision text not null, note text, created_at text not null, created_via text not null);
  create table audit(seq integer primary key autoincrement, ts text not null, actor text not null, action text not null, target text, data text, prev_hash text not null, hash text not null);
  create table notifications(id text primary key, level text not null, title text not null, body text not null, agent_id text, task_id text, trigger_id text, conversation_id text, created_at text not null, delivered_at text, feedback text, digested integer not null default 0);
  create table plugins(id text primary key, dir text not null, source text not null, enabled integer not null, granted text not null, commit_hash text, installed_at text not null, settings text not null default '{}');
  create table plugin_kv(plugin_id text not null, key text not null, value text not null, primary key(plugin_id, key));
  create table machines(id text primary key, name text not null, public_key text not null, info text, last_seen_at text, created_at text not null, revoked integer not null default 0);
  create table pairing_codes(code text primary key, name text, expires_at text not null, used integer not null default 0);
  create table auth(key text primary key, value text not null);
  create table auth_sessions(id text primary key, kind text not null, csrf text not null, created_at text not null, expires_at text not null);
  create table passkeys(id text primary key, public_key text not null, counter integer not null, transports text, name text, created_at text not null);
  create table brain_limits(brain_ref text primary key, until text not null, detail text);
  create table usage(day text not null, agent_id text not null, kind text not null, count integer not null default 0, tokens integer not null default 0, primary key(day, agent_id, kind));
  `,
  // Vault items the user granted a plugin beyond its manifest (security console only).
  `alter table plugins add column extra_vault text not null default '[]';`,
  // Secrets the hub asked for in the chat (values never stored here, only where they went).
  `create table secret_requests(id text primary key, vault_id text not null, title text not null, hint text, link text, plugin_id text, setting text,
    conversation_id text, status text not null, created_at text not null, resolved_at text);`,
  // One long-lived dialog per agent: find it by agent, and remember what the user has read (unread counts).
  // History from before counts as read.
  `
  alter table conversations add column read_at text;
  update conversations set read_at = updated_at;
  create index conversations_kind_agent on conversations(kind, agent_id);
  `,
  // New agents put together in the chat: the card shows the live draft; the agent exists once it is created.
  `create table agent_drafts(id text primary key, conversation_id text not null, data text not null, status text not null, agent_id text,
    created_at text not null, updated_at text not null);`,
  // Phones paired with the hub: a bearer token (hash only) and the phone's Secure Enclave key for approvals.
  `
  create table devices(id text primary key, name text not null, platform text not null, model text, token_hash text not null,
    public_key text not null, created_at text not null, last_seen_at text, revoked integer not null default 0);
  create index devices_token on devices(token_hash);
  create table device_pairing_codes(code text primary key, expires_at text not null, used integer not null default 0);
  `,
  // Group chats: the agents taking part (JSON array, the lead first; agent_id holds the lead too).
  `alter table conversations add column members text;`,
  // A task's open question to whoever started it (task_ask).
  `alter table tasks add column question text;`,
  // Threads between teammates (team_message: kind "message"), and tasks started from a session that read outside content.
  `
  alter table tasks add column kind text;
  alter table tasks add column tainted integer not null default 0;
  alter table tasks add column from_agent text;
  `,
  // One-time invites for any device (invites.ts); pairing_codes and device_pairing_codes are no longer written.
  `create table invites(code text primary key, expires_at text not null, used_at text, used_by text);`,
  // Channels (feeds.ts) and the tasks that gather them.
  `
  create table feeds(id text primary key, title text not null, brief text not null, agent_id text not null, times text not null,
    weekdays text not null default '[]', sources text not null default '[]', enabled integer not null default 1, read_at text,
    last_run_at text, next_run_at text, created_at text not null, updated_at text not null);
  create table feed_posts(id text primary key, feed_id text not null, title text not null, text text not null, url text, source text,
    image text, created_at text not null);
  create index feed_posts_feed on feed_posts(feed_id, created_at);
  alter table tasks add column feed_id text;
  `,
];

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") {
    // Hub-only: plugin and agent users share the data volume. SQLite gives -wal/-shm the same mode.
    try {
      chmodSync(file, 0o600);
    } catch {
      /* windows */
    }
  }
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec("create table if not exists schema_version(v integer not null)");
  const row = db.prepare("select v from schema_version").get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare("insert into schema_version(v) values (0)").run();
  v = repairSwappedMigrations(db, v);
  while (v < MIGRATIONS.length) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.prepare("update schema_version set v = ?").run(v);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  return db;
}

const DEVICES_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("create table devices("));
const MEMBERS_MIGRATION = MIGRATIONS.findIndex((m) => m.includes("add column members"));

/**
 * Desktop builds of claude/desktop-app made before the phones' support was merged (2026-10-27) ran the group chats'
 * migration where the phones' one is now: such a database has the members column but no devices table. It gets the
 * phones' tables and counts as having run both.
 */
function repairSwappedMigrations(db: Db, v: number): number {
  if (v !== DEVICES_MIGRATION + 1 || MEMBERS_MIGRATION !== DEVICES_MIGRATION + 1) return v;
  const members = db.prepare("select 1 from pragma_table_info('conversations') where name = 'members'").get();
  const devices = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'devices'").get();
  if (!members || devices) return v;
  db.exec("begin");
  try {
    db.exec(MIGRATIONS[DEVICES_MIGRATION]);
    db.prepare("update schema_version set v = ?").run(MEMBERS_MIGRATION + 1);
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
  return MEMBERS_MIGRATION + 1;
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("begin");
  try {
    const r = fn();
    db.exec("commit");
    return r;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}
